// Daily re-engagement agent (finding find_95e2c1e5a8e6, flag "ga-find_95e2c1e5a8e6").
// EventBridge invokes the learning function at 08:00 UTC with
// { "job": "reengage_inactive_learners" }; handler.js routes that here, the same
// way billing routes renew_subscriptions.
//
// Code decides WHO is eligible, in which order, and which reasons/courses are
// allowed (existing deterministic functions). The model only decides whether to
// nudge, which allowed reason and course to feature, and drafts the text. The
// agent only creates notifications and emails: it never enrols, charges, or
// changes carts, subscriptions or progress.
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { ChatBedrockConverse } from '@langchain/aws';
import { isEnabled } from '@learnloop/shared/flags';
import {
  buildLogRecord, getLogContext, logWarn, newTraceId, runWithLogContext, serialize, setLogSink,
} from '@learnloop/shared/logger';
import { getStore } from '@learnloop/shared/store';
import { getCart } from '@learnloop/catalog/services/cart';
import { listCatalog } from '@learnloop/catalog/services/catalog';
import { listUserEnrolments } from '@learnloop/catalog/services/enrolment';
import { getSubscription, isActive } from '@learnloop/billing/services/subscription';
import { createNotification, listNotifications } from '@learnloop/notifications/services/inbox';
import { sendEmail } from '@learnloop/notifications/services/email';
import { listUsers } from '@learnloop/notifications/repositories/users';
import { daysSinceLastActivity, getCourseProgress } from '../services/progress.js';

export const FLAG_KEY = 'ga-find_95e2c1e5a8e6';
export const REENGAGEMENT_JOB = 'reengage_inactive_learners';
export const DEFAULT_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

// Guardrails (deterministic, checked before any model call or send).
export const INACTIVE_AFTER_DAYS = 7;
export const COOLDOWN_DAYS = 14;
export const QUARTER_DAYS = 90;
export const MAX_NUDGES_PER_QUARTER = 3;
export const MAX_NUDGES_PER_RUN = 50;

// Model output budget: one decision with a subject and a short body is ~200 tokens.
export const OUTPUT_TOKENS_PER_ITEM = 200;
export const MODEL_BATCH_SIZE = 10;
export const MODEL_MAX_TOKENS = Math.ceil(OUTPUT_TOKENS_PER_ITEM * MODEL_BATCH_SIZE * 1.5); // 3000
export const MODEL_CONCURRENCY = 2;
const READ_CONCURRENCY = 8;

const MAX_SUBJECT = 120;
const MAX_BODY = 600;
const DAY_MS = 86_400_000;
const REASONS = Object.freeze(['cart_not_enrolled', 'enrolled_inactive', 'subscription_inactive']);
const FORBIDDEN_TEXT = /[$€£]|\d+\s*%|\b(discounts?|free|prices?|pricing|coupons?|promo|offers?|guarantee[ds]?|promis(e|es|ed)|refunds?|deals?|sale)\b/i;
const URL_TEXT = /https?:\/\/|www\.|\.com\b/i;

/** The deterministic functions the agent calls; overridable in tests only. */
export const defaultDeps = Object.freeze({
  listUsers,
  daysSinceLastActivity,
  getCourseProgress,
  listUserEnrolments,
  getCart,
  listCatalog,
  getSubscription,
  isActive,
  listNotifications,
  createNotification,
  sendEmail,
});

const SYSTEM_PROMPT = [
  'You help LearnLoop, an online-course platform, re-engage learners who stopped learning.',
  'You receive JSON {"learners":[...]}. Each learner has a ref, stalledDays, subscriptionActive, the reasons that apply',
  '(cart_not_enrolled: a course sits in the cart, never enrolled; enrolled_inactive: enrolled but no recent lesson activity;',
  'subscription_inactive: enrolling or continuing needs an active subscription) and courseOptions.',
  'For EACH learner return one object: {"ref":string,"send":boolean,"reason":one of that learner\'s reasons,',
  '"courseId":one of that learner\'s courseOptions ids,"subject":string (max 90 chars),"body":string (max 400 chars, 2 sentences)}.',
  'Use send=false when a nudge would not help. Mention the course title and the concrete next step (next lesson, enrol, or resume the plan).',
  'Never mention prices, discounts, offers, free access or promises. No links, no names, no greeting or signature.',
  'Reply with ONLY the JSON array, no prose.',
].join(' ');

// ---------------------------------------------------------------- logging

/** Exactly one structured summary line per run, through the shared logger's sink. */
function logRunSummary({ acted, candidates, reason }) {
  const sink = setLogSink(() => {});
  setLogSink(sink);
  const ctx = getLogContext() ?? {};
  const record = buildLogRecord({
    timestamp: new Date().toISOString(),
    level: reason === 'completed' || reason === 'flag_off' || reason === 'no_candidates' || reason === 'daily_cap' ? 'info' : 'warn',
    service: ctx.service ?? 'learning',
    version: ctx.version ?? 'dev',
    environment: ctx.environment ?? 'dev',
    traceId: ctx.traceId ?? newTraceId(),
    requestId: ctx.requestId ?? '-',
    message: 'reengagement run summary',
  });
  sink(serialize({ ...record, job: REENGAGEMENT_JOB, flag: FLAG_KEY, reason, acted, candidates }));
}

// ---------------------------------------------------------------- helpers

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

const chunk = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

const isOptedOut = (user) => user.reengagement_opt_out === true || user.notifications_opt_out === true;

/** Cool-down and quarterly cap, from the agent's own earlier inbox records. */
function withinNudgeLimits(previous, now) {
  const ages = previous.filter((n) => n.applied_by_agent === true).map((n) => now - new Date(n.created_at));
  if (ages.some((age) => age < COOLDOWN_DAYS * DAY_MS)) return false;
  return ages.filter((age) => age < QUARTER_DAYS * DAY_MS).length < MAX_NUDGES_PER_QUARTER;
}

const courseFacts = (c) => ({ id: c.id, title: c.title, category: c.category, level: c.level, lessonCount: c.lessonCount, durationMin: c.durationMin });

async function buildModel() {
  const region = process.env.AWS_REGION;
  const options = { model: process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID, region, maxTokens: MODEL_MAX_TOKENS, temperature: 0.3 };
  if (process.env.BEDROCK_ROLE_ARN) {
    const out = await new STSClient({ region }).send(new AssumeRoleCommand({
      RoleArn: process.env.BEDROCK_ROLE_ARN,
      RoleSessionName: 'learnloop-reengagement',
    }));
    options.credentials = {
      accessKeyId: out.Credentials.AccessKeyId,
      secretAccessKey: out.Credentials.SecretAccessKey,
      sessionToken: out.Credentials.SessionToken,
    };
  }
  return new ChatBedrockConverse(options);
}

function replyText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  return '';
}

function parseDecisions(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end < start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function decideBatch(model, batch) {
  let response;
  try {
    response = await model.invoke([['system', SYSTEM_PROMPT], ['human', JSON.stringify({ learners: batch.map((b) => b.facts) })]]);
  } catch (error) {
    logWarn('reengagement model call failed', { errorType: error?.name ?? 'Error' });
    return { failure: 'model_call_failed' };
  }
  if (response?.response_metadata?.stopReason === 'max_tokens') {
    logWarn('reengagement model reply truncated', { errorType: 'ModelReplyTruncated' });
    return { failure: 'model_reply_truncated' };
  }
  const decisions = parseDecisions(replyText(response?.content));
  if (!decisions) {
    logWarn('reengagement model reply unparseable', { errorType: 'ModelReplyUnparseable' });
    return { failure: 'model_reply_unparseable' };
  }
  return { decisions };
}

/** Accepts a model decision only inside what code allowed; the link is built by code. */
function checkDecision(decision, facts, options) {
  if (!decision || decision.send !== true) return null;
  if (!REASONS.includes(decision.reason) || !facts.reasons.includes(decision.reason)) return null;
  const option = options.find((o) => o.id === decision.courseId);
  if (!option) return null;
  if (decision.reason === 'cart_not_enrolled' && option.source !== 'cart') return null;
  if (decision.reason === 'enrolled_inactive' && option.source !== 'enrolled') return null;
  const subject = String(decision.subject ?? '').trim();
  const body = String(decision.body ?? '').trim();
  if (!subject || !body || subject.length > MAX_SUBJECT || body.length > MAX_BODY) return null;
  const text = `${subject} ${body}`;
  if (FORBIDDEN_TEXT.test(text) || URL_TEXT.test(text)) return null;
  const link = decision.reason === 'enrolled_inactive' && option.nextLessonId ? `/lessons/${option.nextLessonId}` : `/courses/${option.id}`;
  return { subject, body, link, reason: decision.reason, courseId: option.id };
}

async function markAppliedByAgent(notificationId, { reason, courseId }) {
  await getStore().update('notifications', (all) => {
    const found = all.find((n) => n.id === notificationId);
    if (!found) return;
    found.applied_by_agent = true;
    found.agent_flag = FLAG_KEY;
    found.agent_reason = reason;
    found.agent_course_id = courseId;
  });
}

// ---------------------------------------------------------------- the run

/** Inactive learners with an enrolment or cart item, longest stall first. */
async function findCandidates(now, deps) {
  const learners = (await deps.listUsers()).filter((u) => u.role === 'learner' && !isOptedOut(u));
  const rows = await mapPool(learners, READ_CONCURRENCY, async (user) => {
    const days = await deps.daysSinceLastActivity(user.id, now);
    if (days !== null && days < INACTIVE_AFTER_DAYS) return null;
    const [enrolments, cart] = await Promise.all([deps.listUserEnrolments(user.id), deps.getCart(user.id)]);
    if (enrolments.length === 0 && cart.count === 0) return null;
    // Never active: the stall runs from the oldest enrolment or cart item.
    const oldest = [...enrolments.map((e) => e.enrolled_at), ...cart.items.map((i) => i.addedAt)].filter(Boolean).sort()[0];
    const stalledDays = days ?? (oldest ? Math.floor((now - new Date(oldest)) / DAY_MS) : 0);
    return { user, stalledDays, enrolments, cart };
  });
  return rows.filter(Boolean).sort((a, b) => b.stalledDays - a.stalledDays || a.user.id.localeCompare(b.user.id));
}

async function buildFacts(candidate, ref, published, now, deps) {
  const { user, enrolments, cart } = candidate;
  const subscription = await deps.getSubscription(user.id);
  const subscriptionActive = deps.isActive(subscription, now);
  const cartOptions = cart.items
    .filter((i) => published.has(i.courseId))
    .map((i) => ({ ...courseFacts(published.get(i.courseId)), source: 'cart' }));
  const progress = (await Promise.all(enrolments.map((e) => deps.getCourseProgress(user.id, e.course_id))))
    .filter((p) => p && p.percent < 100 && published.has(p.courseId));
  const enrolledOptions = progress.map((p) => ({
    ...courseFacts(published.get(p.courseId)),
    source: 'enrolled',
    percent: p.percent,
    completedLessons: p.completedLessons,
    totalLessons: p.totalLessons,
    nextLessonTitle: p.nextLesson?.title ?? null,
    nextLessonId: p.nextLesson?.id ?? null,
  }));
  const options = [...cartOptions, ...enrolledOptions];
  const reasons = [];
  if (cartOptions.length) reasons.push('cart_not_enrolled');
  if (subscriptionActive && enrolledOptions.length) reasons.push('enrolled_inactive');
  if (!subscriptionActive && options.length) reasons.push('subscription_inactive');
  if (reasons.length === 0) return null;
  return {
    candidate,
    options,
    facts: {
      ref,
      stalledDays: candidate.stalledDays,
      subscriptionActive,
      subscriptionStatus: subscription?.status ?? 'none',
      reasons,
      courseOptions: options.map(({ nextLessonId, ...o }) => o),
    },
  };
}

async function sendNudge(item, decision, now, deps) {
  const { user } = item.candidate;
  const parent = getLogContext() ?? {};
  const ctx = { ...parent, userId: user.id, sessionId: undefined, role: 'system' };
  return runWithLogContext(ctx, async () => {
    const notification = await deps.createNotification(user.id, {
      type: 'staff_message', title: decision.subject, body: decision.body, link: decision.link,
    }, now);
    await markAppliedByAgent(notification.id, decision);
    await deps.sendEmail({
      to: user.email,
      template: 'staff_message',
      data: { name: user.name, title: decision.subject, body: decision.body, staffName: 'The LearnLoop team' },
    });
    return true;
  });
}

/**
 * One run of the agent. Returns { acted, candidates, reason } and logs it as one line.
 * options.model / options.deps / options.maxNudges are for tests.
 */
export async function runReengagement(now = new Date(), { model, deps = defaultDeps, maxNudges = MAX_NUDGES_PER_RUN } = {}) {
  const finish = (summary) => {
    logRunSummary(summary);
    return summary;
  };
  if (!(await isEnabled(FLAG_KEY))) return finish({ acted: 0, candidates: 0, reason: 'flag_off' });

  const candidates = await findCandidates(now, deps);
  if (candidates.length === 0) return finish({ acted: 0, candidates: 0, reason: 'no_candidates' });

  // Guardrails before the model: cool-down, quarterly cap, per-run cap (most at-risk first).
  const allowed = [];
  for (const candidate of candidates) {
    if (allowed.length >= maxNudges) break;
    if (withinNudgeLimits(await deps.listNotifications(candidate.user.id), now)) allowed.push(candidate);
  }
  if (allowed.length === 0) return finish({ acted: 0, candidates: candidates.length, reason: 'daily_cap' });

  const published = new Map((await deps.listCatalog()).map((c) => [c.id, c]));
  const items = (await mapPool(allowed, READ_CONCURRENCY, (c, i) => buildFacts(c, `L${i + 1}`, published, now, deps))).filter(Boolean);
  if (items.length === 0) return finish({ acted: 0, candidates: candidates.length, reason: 'no_candidates' });

  let chat = model;
  if (!chat) {
    try {
      chat = await buildModel();
    } catch (error) {
      logWarn('reengagement model setup failed', { errorType: error?.name ?? 'Error' });
      return finish({ acted: 0, candidates: candidates.length, reason: 'model_call_failed' });
    }
  }

  const byRef = new Map(items.map((item) => [item.facts.ref, item]));
  const results = await mapPool(chunk(items, MODEL_BATCH_SIZE), MODEL_CONCURRENCY, (batch) => decideBatch(chat, batch));
  const failures = results.filter((r) => r.failure).map((r) => r.failure);

  let acted = 0;
  const done = new Set();
  for (const decision of results.flatMap((r) => r.decisions ?? [])) {
    const item = byRef.get(decision?.ref);
    if (!item || done.has(item.facts.ref)) continue;
    done.add(item.facts.ref);
    const checked = checkDecision(decision, item.facts, item.options);
    if (!checked) continue;
    if (await sendNudge(item, checked, now, deps)) acted += 1;
  }
  return finish({ acted, candidates: candidates.length, reason: failures[0] ?? 'completed' });
}

/** Scheduled job entry point (handler.js calls job(now)). */
export async function reengageInactiveLearners(now = new Date()) {
  return runReengagement(now);
}
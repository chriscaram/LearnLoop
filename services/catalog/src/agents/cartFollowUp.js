// Daily cart follow-up agent (finding find_4219d5566568, goal: no course left
// waiting in a cart for more than 7 days). The job is routed by handler.js when
// the catalog function is invoked with { "job": "cart_follow_up" }, the same way
// billing routes renew_subscriptions. Everything is OFF unless the runtime flag
// "ga-find_4219d5566568" is enabled.
//
// Deterministic code decides WHO is considered (cart age, longest wait first),
// enforces every guardrail (7-day cooldown, 2 reminders per cart, daily cap,
// courses actually in the cart, no prices or discounts, length caps) and does
// every read and write through the existing services. The model only decides
// remind/skip, which waiting courses to highlight, and drafts the title and body.
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { ChatBedrockConverse } from '@langchain/aws';
import { isEnabled } from '@learnloop/shared/flags';
import { buildLogRecord, getLogContext, logWarn, newTraceId, runWithLogContext, serialize, setLogSink } from '@learnloop/shared/logger';
import { getStore } from '@learnloop/shared/store';
import { getSubscription, isActive } from '@learnloop/billing/services/subscription';
import { findUserById } from '@learnloop/billing/repositories/users';
import { createNotification, listNotifications } from '@learnloop/notifications/services/inbox';
import { sendEmail } from '@learnloop/notifications/services/email';
import { listCartItems } from '../repositories/carts.js';
import { listCourses } from '../repositories/courses.js';
import { listEnrolmentsForUser } from '../repositories/enrolments.js';
import { getCart } from '../services/cart.js';

export const CART_FOLLOW_UP_JOB = 'cart_follow_up';
export const FLAG_KEY = 'ga-find_4219d5566568';
export const DEFAULT_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
export const REMINDER_TYPE = 'cart_reminder';

export const MIN_CART_AGE_DAYS = 3; // act before day 7
export const REMINDER_COOLDOWN_DAYS = 7; // at most one reminder per user per 7 days
export const MAX_REMINDERS_PER_CART = 2;
export const DAILY_REMINDER_CAP = 50; // reminders across all users per 24 h
export const MAX_CARTS_PER_RUN = 20; // bounded batch per invocation; the rest waits for the next run
export const MODEL_BATCH_SIZE = 10; // carts per model call
export const MODEL_CONCURRENCY = 2; // model calls in flight at once
export const OUTPUT_TOKENS_PER_ITEM = 220; // decision + course ids + title + short body
export const MAX_OUTPUT_TOKENS = Math.ceil(OUTPUT_TOKENS_PER_ITEM * MODEL_BATCH_SIZE * 1.5); // 3300, 50% headroom
export const TITLE_MAX = 200;
export const BODY_MAX = 4000;
const SUMMARY_MAX = 300;
const DAY_MS = 86_400_000;

/** Prices, money and discounts are never offered (guardrail, checked in code). */
const MONEY_RE = /[$€£]|\d+\s*%|\b(usd|eur|gbp|price[sd]?|pricing|discounts?|coupons?|promo(?:tion)?s?|vouchers?|free trial|cheaper|refunds?)\b/i;

/** The existing deterministic functions the agent calls (overridable in tests to observe calls). */
export const DEFAULT_DEPS = Object.freeze({
  listCartItems, getCart, listEnrolmentsForUser, getSubscription, isActive,
  listNotifications, createNotification, sendEmail, findUserById,
});

const SYSTEM_PROMPT = [
  'You help LearnLoop, an online-course platform, follow up with learners whose chosen courses have been waiting in their cart.',
  'For each cart you receive facts only: how long the courses have waited, how many reminders were already sent for this cart,',
  'whether the learner has an active subscription (nextStep "checkout") or not (nextStep "resubscribe"), and the courses in the cart.',
  'For each cart decide "remind" or "skip". Skip when a reminder now is unlikely to help (for example a recent reminder).',
  'When reminding, pick one or more courseIds from that cart only, and write a friendly title (max 80 characters)',
  'and body (max 400 characters, two or three sentences) using ONLY the given course titles and summaries.',
  'For nextStep "checkout" invite them to finish enrolling from their cart; for "resubscribe" mention that an active subscription is needed to enrol.',
  'Never mention prices, money, discounts, coupons, trials or deadlines, never mention other courses, never invent facts, no personal details.',
  'Reply with JSON only, no prose: {"decisions":[{"ref":"c1","action":"remind","courseIds":["crs_..."],"title":"...","body":"..."},{"ref":"c2","action":"skip"}]}',
].join(' ');

// ---------------------------------------------------------------------------
// Deterministic reads and guardrails

/** User ids that hold a server cart (read-only scan of the carts document; there is no list-all repository yet). */
async function listCartUserIds() {
  return (await getStore().read('carts')).map((c) => c.user_id);
}

const isAgentReminder = (n) => n.type === REMINDER_TYPE && n.applied_by_agent === true;

/** Carts whose oldest item has waited at least MIN_CART_AGE_DAYS, longest wait first. */
export async function listAgedCarts(now, deps = DEFAULT_DEPS) {
  const aged = [];
  for (const userId of await listCartUserIds()) {
    const items = await deps.listCartItems(userId);
    if (items.length === 0) continue;
    const oldestAddedAt = items.map((i) => i.added_at).sort()[0];
    const ageDays = (now - new Date(oldestAddedAt)) / DAY_MS;
    if (ageDays >= MIN_CART_AGE_DAYS) aged.push({ userId, oldestAddedAt, ageDays });
  }
  return aged.sort((a, b) => b.ageDays - a.ageDays || a.userId.localeCompare(b.userId));
}

/** Why a cart may not be reminded now (null when it may): 7-day cooldown, 2 per cart. */
export function reminderBlock(reminders, oldestAddedAt, now) {
  const last = [...reminders].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  if (last && now - new Date(last.created_at) < REMINDER_COOLDOWN_DAYS * DAY_MS) return 'cooldown';
  if (reminders.filter((n) => n.created_at >= oldestAddedAt).length >= MAX_REMINDERS_PER_CART) return 'cart_cap';
  return null;
}

async function countRemindersSince(since) {
  const iso = since.toISOString();
  return (await getStore().read('notifications')).filter((n) => isAgentReminder(n) && n.created_at >= iso).length;
}

async function buildCandidate({ userId, oldestAddedAt, ageDays }, now, deps) {
  const user = await deps.findUserById(userId);
  if (!user || user.role !== 'learner') return null;
  const reminders = (await deps.listNotifications(userId)).filter(isAgentReminder);
  if (reminderBlock(reminders, oldestAddedAt, now)) return null;
  const [cart, enrolments, subscription] = await Promise.all([
    deps.getCart(userId), deps.listEnrolmentsForUser(userId), deps.getSubscription(userId),
  ]);
  const enrolled = new Set(enrolments.map((e) => e.course_id));
  const courses = cart.items
    .filter((i) => !enrolled.has(i.courseId))
    .map((i) => ({
      courseId: i.courseId,
      title: i.course.title,
      summary: String(i.course.summary ?? '').slice(0, SUMMARY_MAX),
      waitingDays: Math.floor((now - new Date(i.addedAt)) / DAY_MS),
    }));
  if (courses.length === 0) return null;
  const active = deps.isActive(subscription, now);
  const last = reminders[0];
  return {
    userId,
    user,
    courses,
    facts: {
      cartAgeDays: Math.floor(ageDays),
      remindersSentForThisCart: reminders.filter((n) => n.created_at >= oldestAddedAt).length,
      lastReminderDaysAgo: last ? Math.floor((now - new Date(last.created_at)) / DAY_MS) : null,
      subscriptionActive: active,
      nextStep: active ? 'checkout' : 'resubscribe',
    },
  };
}

/** A model draft that passes every guardrail, or null. */
export function acceptDraft(decision, candidate, catalogTitles) {
  if (decision?.action !== 'remind') return null;
  const inCart = new Set(candidate.courses.map((c) => c.courseId));
  const courseIds = [...new Set((Array.isArray(decision.courseIds) ? decision.courseIds : []).filter((id) => inCart.has(id)))];
  if (courseIds.length === 0) return null;
  const title = String(decision.title ?? '').trim().slice(0, TITLE_MAX);
  const body = String(decision.body ?? '').trim().slice(0, BODY_MAX);
  if (!title || !body) return null;
  const text = `${title}\n${body}`;
  if (MONEY_RE.test(text)) return null;
  const lower = text.toLowerCase();
  const cartTitles = new Set(candidate.courses.map((c) => c.title));
  if (catalogTitles.some((t) => !cartTitles.has(t) && lower.includes(t.toLowerCase()))) return null;
  return { courseIds, title, body };
}

// ---------------------------------------------------------------------------
// Model

async function buildModel() {
  const region = process.env.AWS_REGION;
  const model = process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID;
  let credentials;
  if (process.env.BEDROCK_ROLE_ARN) {
    const out = await new STSClient({ region }).send(new AssumeRoleCommand({
      RoleArn: process.env.BEDROCK_ROLE_ARN,
      RoleSessionName: 'learnloop-cart-follow-up',
    }));
    credentials = {
      accessKeyId: out.Credentials.AccessKeyId,
      secretAccessKey: out.Credentials.SecretAccessKey,
      sessionToken: out.Credentials.SessionToken,
    };
  }
  return new ChatBedrockConverse({ model, region, maxTokens: MAX_OUTPUT_TOKENS, temperature: 0.3, ...(credentials ? { credentials } : {}) });
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  return '';
}

export function parseDecisions(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new SyntaxError('no JSON object');
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!parsed || !Array.isArray(parsed.decisions)) throw new SyntaxError('no decisions list');
  return parsed.decisions;
}

async function decideBatch(model, batch) {
  const carts = batch.map((c, i) => ({ ref: `c${i + 1}`, ...c.facts, courses: c.courses }));
  let response;
  try {
    response = await model.invoke([['system', SYSTEM_PROMPT], ['human', JSON.stringify({ carts })]]);
  } catch (error) {
    logWarn('cart follow-up model call failed', { errorType: error?.name ?? 'Error' });
    return { failure: 'model_call_failed' };
  }
  if (response?.response_metadata?.stopReason === 'max_tokens') {
    logWarn('cart follow-up model reply truncated', { errorType: 'MaxTokens' });
    return { failure: 'model_reply_truncated' };
  }
  try {
    const byRef = new Map(parseDecisions(textOf(response?.content)).map((d) => [d?.ref, d]));
    return { decisions: batch.map((c, i) => byRef.get(`c${i + 1}`) ?? null) };
  } catch {
    logWarn('cart follow-up model reply unparseable', { errorType: 'UnparseableReply' });
    return { failure: 'model_reply_unparseable' };
  }
}

async function mapBounded(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Run summary: exactly one structured line per run, through the shared logger's sink.

function logRunSummary({ reason, acted = 0, candidates = 0, eligible = 0, skipped = 0 }) {
  const ctx = getLogContext();
  const failed = reason.startsWith('model_');
  const record = buildLogRecord({
    timestamp: new Date().toISOString(),
    level: failed ? 'warn' : 'info',
    service: ctx?.service ?? 'catalog',
    version: ctx?.version ?? 'dev',
    environment: ctx?.environment ?? 'dev',
    traceId: ctx?.traceId ?? newTraceId(),
    requestId: ctx?.requestId ?? '-',
    message: 'cart_follow_up run summary',
  });
  Object.assign(record, { job: CART_FOLLOW_UP_JOB, reason, acted, candidates, eligible, skipped });
  const sink = setLogSink(() => {});
  setLogSink(sink);
  sink(serialize(record));
  return { reason, acted, candidates, eligible, skipped };
}

// ---------------------------------------------------------------------------
// The job

export async function runCartFollowUp(now = new Date(), options = {}) {
  const deps = { ...DEFAULT_DEPS, ...(options.deps ?? {}) };
  if (!(await isEnabled(FLAG_KEY))) return logRunSummary({ reason: 'flag_off' });

  const aged = await listAgedCarts(now, deps);
  if (aged.length === 0) return logRunSummary({ reason: 'no_candidates' });
  const remaining = DAILY_REMINDER_CAP - (await countRemindersSince(new Date(now.getTime() - DAY_MS)));
  if (remaining <= 0) return logRunSummary({ reason: 'daily_cap', candidates: aged.length });
  const limit = Math.min(options.maxCarts ?? MAX_CARTS_PER_RUN, remaining);

  const eligible = [];
  let skipped = 0;
  for (const cart of aged) {
    if (eligible.length >= limit) break;
    const candidate = await buildCandidate(cart, now, deps);
    if (candidate) eligible.push(candidate);
    else skipped += 1;
  }
  if (eligible.length === 0) return logRunSummary({ reason: 'no_candidates', candidates: aged.length, skipped });

  let model = options.model;
  if (!model) {
    try {
      model = await buildModel();
    } catch (error) {
      logWarn('cart follow-up model setup failed', { errorType: error?.name ?? 'Error' });
      return logRunSummary({ reason: 'model_call_failed', candidates: aged.length, eligible: eligible.length, skipped });
    }
  }

  const batches = [];
  for (let i = 0; i < eligible.length; i += MODEL_BATCH_SIZE) batches.push(eligible.slice(i, i + MODEL_BATCH_SIZE));
  const replies = await mapBounded(batches, MODEL_CONCURRENCY, (batch) => decideBatch(model, batch));

  const catalogTitles = (await listCourses()).map((c) => c.title);
  const parent = getLogContext() ?? {};
  let failure = null;
  let acted = 0;
  for (const [b, reply] of replies.entries()) {
    if (reply.failure) {
      failure ??= reply.failure;
      continue;
    }
    for (const [i, decision] of reply.decisions.entries()) {
      const candidate = batches[b][i];
      const draft = acceptDraft(decision, candidate, catalogTitles);
      if (!draft) {
        skipped += 1;
        continue;
      }
      const ctx = { ...parent, userId: candidate.userId, sessionId: undefined, role: 'system' };
      try {
        await runWithLogContext(ctx, async () => {
          await deps.createNotification(candidate.userId, {
            type: REMINDER_TYPE, title: draft.title, body: draft.body, link: '/cart', appliedByAgent: true, courseIds: draft.courseIds,
          }, now);
          await deps.sendEmail({
            to: candidate.user.email,
            template: 'staff_message',
            data: { name: candidate.user.name, title: draft.title, body: `${draft.body}\n\nYour cart: /cart`, staffName: 'The LearnLoop team' },
          });
        });
        acted += 1;
      } catch (error) {
        logWarn('cart follow-up reminder failed', { errorType: error?.name ?? 'Error' });
        skipped += 1;
      }
    }
  }
  return logRunSummary({ reason: failure ?? 'completed', acted, candidates: aged.length, eligible: eligible.length, skipped });
}

/** Registered in handler.js; createHandler calls it with new Date(). */
export const cartFollowUpJob = (now) => runCartFollowUp(now);
// AI agent "nudge_stalled_carts" (finding find_d8539d6d1401). Runs as a scheduled
// job of the catalog function, invoked with { "job": "nudge_stalled_carts" } the same
// way billing runs renew_subscriptions. Switched off unless the feature flag
// ga-find_d8539d6d1401 is on.
//
// Existing code does the reads and the rules: cart items (listCartItems), enrolments
// (listEnrolmentsForUser), course summaries (getCart / toCourseSummary), plan status
// (getSubscription / isActive), reminders already sent (listNotifications), and the
// guardrails below. The model only decides send or skip and writes the title and body.
// The agent never enrols, never changes carts or subscriptions, never offers prices.
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { ChatBedrockConverse } from '@langchain/aws';
import { isEnabled } from '@learnloop/shared/flags';
import { getStore } from '@learnloop/shared/store';
import { buildLogRecord, getLogContext, logWarn, runWithLogContext, serialize, setLogSink } from '@learnloop/shared/logger';
import { getSubscription, isActive } from '@learnloop/billing/services/subscription';
import { createNotification, listNotifications } from '@learnloop/notifications/services/inbox';
import { listCourses } from '../repositories/courses.js';
import { listCartItems } from '../repositories/carts.js';
import { listEnrolmentsForUser } from '../repositories/enrolments.js';
import { getCart } from '../services/cart.js';

export const CART_REMINDER_JOB = 'nudge_stalled_carts';
export const FLAG_KEY = 'ga-find_d8539d6d1401';
export const DEFAULT_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
export const REMINDER_TYPE = 'cart_reminder';

const DAY_MS = 86_400_000;
/** A course counts as stalled after this many days in the cart without enrolment. */
export const STALL_DAYS = 3;
/** Guardrail: at most one reminder per user every 14 days. */
export const REMIND_EVERY_DAYS = 14;
/** Guardrail: at most 2 reminders for the same cart. */
export const MAX_REMINDERS_PER_CART = 2;
/** Guardrail: at most this many reminders per day (longest stall first). */
export const DAILY_CAP = 20;

// Output budget: a decision with a title and a two-sentence body is about 150 tokens.
export const OUTPUT_TOKENS_PER_ITEM = 150;
export const MODEL_BATCH_SIZE = 10;
export const MODEL_MAX_TOKENS = Math.ceil(OUTPUT_TOKENS_PER_ITEM * MODEL_BATCH_SIZE * 1.5); // 2250
export const MODEL_CONCURRENCY = 2;

export const TITLE_MAX = 120;
export const BODY_MAX = 400;
const FORBIDDEN_OFFER_RE = /discount|coupon|voucher|promo|%|\$|\busd\b|\bprice/i;

const SYSTEM_PROMPT = [
  'You help an online-course platform decide whether to send a learner a short in-app reminder about courses left in their cart.',
  'For each item you get only behaviour: the courses in the cart (title, category, level, summary, lesson count, duration, days in cart),',
  'days since the cart last changed, and reminders already sent for this cart.',
  'Decide "send": true only when a reminder is likely to help; skip when recent cart changes or ignored reminders suggest no interest.',
  `When sending, write "title" (at most ${TITLE_MAX} characters) and "body" (at most ${BODY_MAX} characters, two sentences),`,
  'mentioning only the courses listed for that item. Never mention prices, discounts, offers or anything about the person.',
  'Reply with JSON only: {"decisions":[{"ref":"c1","send":true,"title":"...","body":"..."},{"ref":"c2","send":false}]}',
].join(' ');

/** Builds the Bedrock model through LangChain; default credential chain unless BEDROCK_ROLE_ARN is set. */
export async function createModel() {
  const region = process.env.AWS_REGION;
  const options = {
    model: process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID,
    region,
    maxTokens: MODEL_MAX_TOKENS,
    temperature: 0.2,
  };
  if (process.env.BEDROCK_ROLE_ARN) {
    const out = await new STSClient({ region }).send(new AssumeRoleCommand({
      RoleArn: process.env.BEDROCK_ROLE_ARN,
      RoleSessionName: 'learnloop-cart-reminders',
    }));
    options.credentials = {
      accessKeyId: out.Credentials.AccessKeyId,
      secretAccessKey: out.Credentials.SecretAccessKey,
      sessionToken: out.Credentials.SessionToken,
    };
  }
  return new ChatBedrockConverse(options);
}

/** One structured summary line per run, through the shared logger's record builder and sink. */
function logSummary({ acted, candidates, reason }) {
  const ctx = getLogContext() ?? {};
  const record = {
    ...buildLogRecord({
      timestamp: new Date().toISOString(),
      level: reason === 'completed' || reason === 'flag_off' || reason === 'no_candidates' ? 'info' : 'warn',
      service: ctx.service ?? 'catalog',
      version: ctx.version ?? 'dev',
      environment: ctx.environment ?? 'dev',
      traceId: ctx.traceId,
      requestId: ctx.requestId,
      message: 'agent run summary',
    }),
    job: CART_REMINDER_JOB,
    acted,
    candidates,
    reason,
  };
  const sink = setLogSink(() => {});
  setLogSink(sink);
  sink(serialize(record));
  return { acted, candidates, reason };
}

/** Everything the guardrails need about one user's cart, read with the existing code. */
export async function loadCandidate(userId, now) {
  const [items, enrolments, notifications] = await Promise.all([
    listCartItems(userId), listEnrolmentsForUser(userId), listNotifications(userId),
  ]);
  const enrolled = new Set(enrolments.map((e) => e.course_id));
  const open = items.filter((i) => !enrolled.has(i.course_id));
  const stalled = open.filter((i) => now - new Date(i.added_at) >= STALL_DAYS * DAY_MS);
  const reminders = notifications.filter((n) => n.type === REMINDER_TYPE && n.applied_by_agent === true); // newest first
  const oldest = stalled.reduce((min, i) => (i.added_at < min ? i.added_at : min), stalled[0]?.added_at ?? null);
  const newestChange = open.reduce((max, i) => (i.added_at > max ? i.added_at : max), open[0]?.added_at ?? null);
  return {
    userId,
    stalled,
    reminders,
    stallMs: oldest ? now - new Date(oldest) : 0,
    newestChange,
    cartReminders: oldest ? reminders.filter((n) => n.created_at >= oldest).length : 0,
  };
}

/** Deterministic guardrails, checked before the model is asked anything. */
export function eligibility(candidate, now) {
  if (candidate.stalled.length === 0) return 'not_stalled';
  const last = candidate.reminders[0];
  if (last && now - new Date(last.created_at) < REMIND_EVERY_DAYS * DAY_MS) return 'reminded_recently';
  if (candidate.cartReminders >= MAX_REMINDERS_PER_CART) return 'cart_reminder_limit';
  return 'eligible';
}

/** Most at risk first: the longest stall, then the most stalled courses. */
export function orderByRisk(candidates) {
  return [...candidates].sort((a, b) => b.stallMs - a.stallMs || b.stalled.length - a.stalled.length);
}

export function selectForRun(candidates, slots) {
  return orderByRisk(candidates).slice(0, Math.max(0, slots));
}

async function toModelItem(candidate, ref, now) {
  const cart = await getCart(candidate.userId);
  const stalledIds = new Set(candidate.stalled.map((i) => i.course_id));
  const courses = cart.items.filter((e) => stalledIds.has(e.courseId)).map((e) => ({
    title: e.course.title,
    category: e.course.category,
    level: e.course.level,
    summary: e.course.summary,
    lessonCount: e.course.lessonCount,
    durationMin: e.course.durationMin,
    daysInCart: Math.floor((now - new Date(e.addedAt)) / DAY_MS),
  }));
  const last = candidate.reminders[0];
  return {
    ref,
    courses,
    daysSinceLastCartChange: candidate.newestChange ? Math.floor((now - new Date(candidate.newestChange)) / DAY_MS) : null,
    remindersSentForThisCart: candidate.cartReminders,
    daysSinceLastReminder: last ? Math.floor((now - new Date(last.created_at)) / DAY_MS) : null,
  };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  return '';
}

/** The decisions array, or null when the reply is not the expected JSON. */
export function parseDecisions(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(value?.decisions) ? value.decisions : null;
  } catch {
    return null;
  }
}

async function callModel(model, items) {
  let reply;
  try {
    reply = await model.invoke([['system', SYSTEM_PROMPT], ['human', JSON.stringify({ items })]]);
  } catch (error) {
    logWarn('cart reminder model call failed', { errorType: error?.name ?? 'Error' });
    return { reason: 'model_call_failed' };
  }
  if (reply?.response_metadata?.stopReason === 'max_tokens') {
    logWarn('cart reminder model reply truncated', { errorType: 'MaxTokens' });
    return { reason: 'model_reply_truncated' };
  }
  const decisions = parseDecisions(textOf(reply?.content));
  if (!decisions) {
    logWarn('cart reminder model reply unparseable', { errorType: 'Unparseable' });
    return { reason: 'model_reply_unparseable' };
  }
  return { decisions };
}

/** Message checks in code: lengths, only courses in this cart, no prices or offers. */
export function checkMessage(decision, item, allTitles) {
  if (!decision || decision.send !== true) return null;
  const title = String(decision.title ?? '').trim();
  const body = String(decision.body ?? '').trim();
  if (!title || !body || title.length > TITLE_MAX || body.length > BODY_MAX) return null;
  const text = `${title} ${body}`.toLowerCase();
  if (FORBIDDEN_OFFER_RE.test(text)) return null;
  const inCart = new Set(item.courses.map((c) => c.title.toLowerCase()));
  if (allTitles.some((t) => !inCart.has(t.toLowerCase()) && text.includes(t.toLowerCase()))) return null;
  return { title, body };
}

async function runBounded(chunks, fn) {
  const results = new Array(chunks.length);
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const index = next++;
      results[index] = await fn(chunks[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MODEL_CONCURRENCY, chunks.length) }, worker));
  return results;
}

/** The scheduled job. Returns the summary it logs. */
export async function nudgeStalledCarts(now = new Date(), { model } = {}) {
  if (!(await isEnabled(FLAG_KEY))) return logSummary({ acted: 0, candidates: 0, reason: 'flag_off' });

  const userIds = [...new Set((await getStore().read('carts')).map((c) => c.user_id))];
  const loaded = await Promise.all(userIds.map((id) => loadCandidate(id, now)));
  const sentToday = loaded.reduce((n, c) => n + c.reminders.filter((r) => now - new Date(r.created_at) < DAY_MS).length, 0);
  const eligible = loaded.filter((c) => eligibility(c, now) === 'eligible');
  if (eligible.length === 0) return logSummary({ acted: 0, candidates: 0, reason: 'no_candidates' });
  const slots = DAILY_CAP - sentToday;
  if (slots <= 0) return logSummary({ acted: 0, candidates: eligible.length, reason: 'daily_cap' });

  const selected = selectForRun(eligible, slots);
  const entries = [];
  for (const candidate of selected) {
    const item = await toModelItem(candidate, `c${entries.length + 1}`, now);
    if (item.courses.length > 0) entries.push({ candidate, item });
  }
  if (entries.length === 0) return logSummary({ acted: 0, candidates: eligible.length, reason: 'no_candidates' });

  let llm = model;
  if (!llm) {
    try {
      llm = await createModel();
    } catch (error) {
      logWarn('cart reminder model setup failed', { errorType: error?.name ?? 'Error' });
      return logSummary({ acted: 0, candidates: eligible.length, reason: 'model_call_failed' });
    }
  }

  const chunks = [];
  for (let i = 0; i < entries.length; i += MODEL_BATCH_SIZE) chunks.push(entries.slice(i, i + MODEL_BATCH_SIZE));
  const results = await runBounded(chunks, (chunk) => callModel(llm, chunk.map((e) => e.item)));

  const allTitles = (await listCourses()).map((c) => c.title);
  const byRef = new Map(entries.map((e) => [e.item.ref, e]));
  const parent = getLogContext() ?? {};
  let failure = null;
  let acted = 0;
  for (const result of results) {
    if (result.reason) {
      failure ??= result.reason;
      continue;
    }
    for (const decision of result.decisions) {
      const entry = byRef.get(decision?.ref);
      if (!entry) continue;
      byRef.delete(decision.ref);
      const message = checkMessage(decision, entry.item, allTitles);
      if (!message) continue;
      const { userId } = entry.candidate;
      const link = isActive(await getSubscription(userId), now) ? '/checkout' : '/cart';
      const ctx = { ...parent, userId, sessionId: undefined, role: 'system' };
      await runWithLogContext(ctx, () => createNotification(userId, { type: REMINDER_TYPE, ...message, link, appliedByAgent: true }, now));
      acted += 1;
    }
  }
  return logSummary({ acted, candidates: eligible.length, reason: failure ?? 'completed' });
}
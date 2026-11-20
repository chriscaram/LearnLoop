// Daily re-engagement reminders ("lesson_reminders"). EventBridge invokes the
// learning function with { "job": "lesson_reminders" }; handler.js routes that
// here, like billing's renew_subscriptions. Nothing happens unless the feature
// flag "ga-find_2db62e8d3f36" is enabled.
//
// Code decides WHO is eligible (active subscription, unfinished course, inactive
// for INACTIVE_DAYS, at most one nudge per 7 days, at most 3 unanswered nudges,
// a daily cap) and builds the link from nextLessonFor. The model only decides
// whether a nudge helps now, which unfinished course to point to, and drafts
// the title and body, from activity and progress data only.
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { ChatBedrockConverse } from '@langchain/aws';
import { isEnabled } from '@learnloop/shared/flags';
import {
  buildLogRecord, getLogContext, logWarn, newTraceId, runWithLogContext, serialize, setLogSink,
} from '@learnloop/shared/logger';
import { latestSubscriptionByUser } from '@learnloop/admin/services/learners';
import { validateMessage } from '@learnloop/admin/services/messages';
import { listSubscriptions, listUsersByRole } from '@learnloop/admin/repositories/learners';
import { createNotification, listNotifications } from '@learnloop/notifications/services/inbox';
import { sendEmail } from '@learnloop/notifications/services/email';
import { daysSinceLastActivity, getLastActivityAt, listProgressOverview, nextLessonFor } from '../services/progress.js';

export const LESSON_REMINDER_JOB = 'lesson_reminders';
export const FLAG_KEY = 'ga-find_2db62e8d3f36';
export const REMINDER_TYPE = 'lesson_reminder';

// Guardrails (deterministic, checked before the model is called).
export const INACTIVE_DAYS = 7;
export const MIN_DAYS_BETWEEN_NUDGES = 7;
export const MAX_UNANSWERED_NUDGES = 3;
export const DAILY_NUDGE_CAP = 40;
export const RUN_LIMIT = 40;

// Model budget: one decision with a title and a short body is about 200 tokens.
export const OUTPUT_TOKENS_PER_ITEM = 200;
export const MODEL_BATCH_SIZE = 10;
export const MAX_OUTPUT_TOKENS = Math.ceil(OUTPUT_TOKENS_PER_ITEM * MODEL_BATCH_SIZE * 1.5); // 3000
export const MODEL_CONCURRENCY = 2;
export const MODEL_CALL_TIMEOUT_MS = 45_000;
export const DEFAULT_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

const DAY_MS = 86_400_000;
const SUMMARY_MESSAGE = 'lesson_reminders_summary';
const FAILURE_REASONS = new Set(['model_reply_truncated', 'model_reply_unparseable', 'model_call_failed']);
/** The model may not invent links, prices, offers or discounts. */
const FORBIDDEN_CONTENT = /(https?:\/\/|www\.|[$€£]\s*\d|\b\d+(\.\d+)?\s*(usd|eur|gbp)\b|discount|coupon|promo|\boffer|\bprice|free\s+(month|trial)|%\s*off)/i;

const SYSTEM_PROMPT = [
  'You help an online-course platform re-engage paying learners who have stopped taking lessons.',
  'For each learner in the input decide whether a short reminder would help today or would be noise,',
  'weighing how far they got, whether they are close to finishing, how long they have been away and when they were last reminded.',
  'If you nudge, pick ONE of the listed unfinished courses (by its courseId) and draft a friendly title (at most 100 characters)',
  'and body (at most 400 characters) that names the course, the next lesson title, the lessons left and the progress so far.',
  'Use only the data given. Never include links, URLs, prices, offers, discounts or promises. Do not address the learner by name.',
  'Reply with JSON only, no prose, exactly: {"decisions":[{"ref":"L1","nudge":true,"courseId":"...","title":"...","body":"..."},{"ref":"L2","nudge":false}]}',
  'with one decision per learner ref.',
].join(' ');

/** Builds the Bedrock chat model; assumes BEDROCK_ROLE_ARN first when it is set. */
export async function createBedrockModel() {
  const region = process.env.AWS_REGION;
  const options = {
    model: process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID,
    region,
    maxTokens: MAX_OUTPUT_TOKENS,
    temperature: 0.3,
  };
  const roleArn = process.env.BEDROCK_ROLE_ARN;
  if (roleArn) {
    const out = await new STSClient({ region }).send(new AssumeRoleCommand({
      RoleArn: roleArn, RoleSessionName: 'learnloop-lesson-reminders', DurationSeconds: 900,
    }));
    options.credentials = {
      accessKeyId: out.Credentials.AccessKeyId,
      secretAccessKey: out.Credentials.SecretAccessKey,
      sessionToken: out.Credentials.SessionToken,
    };
  }
  return new ChatBedrockConverse(options);
}

export const DEFAULT_DEPS = Object.freeze({
  isEnabled,
  listUsersByRole,
  listSubscriptions,
  latestSubscriptionByUser,
  listNotifications,
  daysSinceLastActivity,
  getLastActivityAt,
  listProgressOverview,
  nextLessonFor,
  validateMessage,
  createNotification,
  sendEmail,
  createModel: createBedrockModel,
  dailyCap: DAILY_NUDGE_CAP,
  runLimit: RUN_LIMIT,
});

const isAgentReminder = (n) => n.type === REMINDER_TYPE && n.applied_by_agent === true;
const bestPercent = (c) => Math.max(...c.courses.map((x) => x.percent));
const errorName = (error) => (/^[A-Za-z][A-Za-z0-9_.]{0,63}$/.test(error?.name ?? '') ? error.name : 'Error');

/** Most at risk first: the longest stall, then the closest to finishing. */
export function orderByRisk(candidates) {
  return [...candidates].sort((a, b) => b.daysInactive - a.daysInactive
    || bestPercent(b) - bestPercent(a)
    || a.user.id.localeCompare(b.user.id));
}

/** Eligible learners, checked entirely in code, plus how many agent nudges went out today. */
export async function collectCandidates(now, deps) {
  const [learners, subscriptions] = await Promise.all([deps.listUsersByRole('learner'), deps.listSubscriptions()]);
  const subs = deps.latestSubscriptionByUser(subscriptions);
  const today = now.toISOString().slice(0, 10);
  let sentToday = 0;
  const rows = await Promise.all(learners.filter((u) => subs.get(u.id)?.status === 'active').map(async (user) => {
    const history = (await deps.listNotifications(user.id)).filter(isAgentReminder); // newest first
    sentToday += history.filter((n) => n.created_at.slice(0, 10) === today).length;
    const daysInactive = await deps.daysSinceLastActivity(user.id, now);
    if (daysInactive === null || daysInactive < INACTIVE_DAYS) return null;
    const lastNudge = history[0];
    if (lastNudge && now - new Date(lastNudge.created_at) < MIN_DAYS_BETWEEN_NUDGES * DAY_MS) return null;
    const lastActivityAt = await deps.getLastActivityAt(user.id);
    const unanswered = history.filter((n) => n.created_at > lastActivityAt).length;
    if (unanswered >= MAX_UNANSWERED_NUDGES) return null;
    const courses = (await deps.listProgressOverview(user.id)).filter((c) => c.nextLesson && c.totalLessons > 0);
    if (courses.length === 0) return null;
    return {
      user,
      daysInactive,
      nudgesSinceLastActivity: unanswered,
      daysSinceLastNudge: lastNudge ? Math.floor((now - new Date(lastNudge.created_at)) / DAY_MS) : null,
      courses,
    };
  }));
  return { candidates: orderByRisk(rows.filter(Boolean)), sentToday };
}

/** What the model sees: activity and progress only, under an opaque ref. */
export function toModelItem(candidate, ref) {
  return {
    ref,
    daysInactive: candidate.daysInactive,
    nudgesSinceLastActivity: candidate.nudgesSinceLastActivity,
    daysSinceLastNudge: candidate.daysSinceLastNudge,
    courses: candidate.courses.map((c) => ({
      courseId: c.courseId,
      courseTitle: c.courseTitle,
      percent: c.percent,
      completedLessons: c.completedLessons,
      totalLessons: c.totalLessons,
      lessonsLeft: Math.max(0, c.totalLessons - c.completedLessons),
      nextLessonTitle: c.nextLesson.title,
      lastLessonTitle: c.lastLesson?.title ?? null,
      lastActivityAt: c.lastActivityAt,
    })),
  };
}

function replyText(response) {
  const { content } = response ?? {};
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('');
  return '';
}

/** The decisions array, or null when the reply is not the expected JSON. */
export function parseDecisions(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed?.decisions) ? parsed.decisions : null;
  } catch {
    return null;
  }
}

async function decideBatch(model, items) {
  let response;
  try {
    response = await model.invoke(
      [['system', SYSTEM_PROMPT], ['human', JSON.stringify({ learners: items })]],
      { signal: AbortSignal.timeout(MODEL_CALL_TIMEOUT_MS) },
    );
  } catch (error) {
    logWarn('lesson reminder model call failed', { errorType: errorName(error) });
    return { failure: 'model_call_failed', decisions: [] };
  }
  if (response?.response_metadata?.stopReason === 'max_tokens') {
    logWarn('lesson reminder model reply truncated', { errorType: 'ModelReplyTruncated' });
    return { failure: 'model_reply_truncated', decisions: [] };
  }
  const decisions = parseDecisions(replyText(response));
  if (!decisions) {
    logWarn('lesson reminder model reply unparseable', { errorType: 'ModelReplyUnparseable' });
    return { failure: 'model_reply_unparseable', decisions: [] };
  }
  return { failure: null, decisions };
}

async function mapBounded(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i], i);
    }
  }));
  return results;
}

/** Checks one model decision in code and, if it passes, sends the nudge. True when sent. */
async function actOnDecision(candidate, decision, now, deps) {
  const course = candidate.courses.find((c) => c.courseId === decision.courseId);
  if (!course) return false;
  let message;
  try {
    message = deps.validateMessage({ title: decision.title, body: decision.body });
  } catch {
    return false;
  }
  if (FORBIDDEN_CONTENT.test(`${message.title} ${message.body}`)) return false;
  const next = await deps.nextLessonFor(candidate.user.id, course.courseId);
  if (!next) return false;
  await deps.createNotification(candidate.user.id, {
    type: REMINDER_TYPE, title: message.title, body: message.body, link: `/lessons/${next.id}`, appliedByAgent: true,
  }, now);
  await deps.sendEmail({
    to: candidate.user.email,
    template: 'staff_message',
    data: { name: candidate.user.name, title: message.title, body: message.body, staffName: 'The LearnLoop team' },
  });
  return true;
}

/** The single structured summary line of a run, written through the repository's log sink. */
function logRunSummary({ reason, acted, candidates, selected = 0 }) {
  const ctx = getLogContext() ?? {};
  const record = {
    ...buildLogRecord({
      timestamp: new Date().toISOString(),
      level: FAILURE_REASONS.has(reason) ? 'warn' : 'info',
      service: ctx.service ?? 'learning',
      version: ctx.version ?? 'dev',
      environment: ctx.environment ?? 'dev',
      traceId: ctx.traceId ?? newTraceId(),
      requestId: ctx.requestId,
      message: SUMMARY_MESSAGE,
    }),
    job: LESSON_REMINDER_JOB,
    reason,
    acted,
    candidates,
    selected,
  };
  // The shared logger has no free-field line; reuse its current sink so the line
  // goes wherever every other line goes (stdout in Lambda, the capture in tests).
  const sink = setLogSink(() => {});
  setLogSink(sink);
  sink(serialize(record));
  return record;
}

/** The scheduled job. `overrides` replaces dependencies in tests. */
export async function runLessonReminders(now = new Date(), overrides = {}) {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  if (!(await deps.isEnabled(FLAG_KEY))) return logRunSummary({ reason: 'flag_off', acted: 0, candidates: 0 });

  const { candidates, sentToday } = await collectCandidates(now, deps);
  if (candidates.length === 0) return logRunSummary({ reason: 'no_candidates', acted: 0, candidates: 0 });
  const room = Math.min(deps.runLimit, deps.dailyCap - sentToday);
  if (room <= 0) return logRunSummary({ reason: 'daily_cap', acted: 0, candidates: candidates.length });
  const selected = candidates.slice(0, room);

  let model;
  try {
    model = await deps.createModel();
  } catch (error) {
    logWarn('lesson reminder model setup failed', { errorType: errorName(error) });
    return logRunSummary({ reason: 'model_call_failed', acted: 0, candidates: candidates.length, selected: selected.length });
  }

  const batches = [];
  for (let i = 0; i < selected.length; i += MODEL_BATCH_SIZE) batches.push(selected.slice(i, i + MODEL_BATCH_SIZE));
  const results = await mapBounded(batches, MODEL_CONCURRENCY,
    (batch) => decideBatch(model, batch.map((c, i) => toModelItem(c, `L${i + 1}`))));

  const parent = getLogContext() ?? {};
  let acted = 0;
  let failure = null;
  for (const [k, batch] of batches.entries()) {
    const { failure: batchFailure, decisions } = results[k];
    if (batchFailure) {
      failure ??= batchFailure;
      continue;
    }
    const byRef = new Map(batch.map((c, i) => [`L${i + 1}`, c]));
    const done = new Set();
    for (const decision of decisions) {
      if (!decision || decision.nudge !== true || done.has(decision.ref) || !byRef.has(decision.ref)) continue;
      done.add(decision.ref);
      const candidate = byRef.get(decision.ref);
      const ctx = { ...parent, userId: candidate.user.id, sessionId: undefined, role: 'system' };
      if (await runWithLogContext(ctx, () => actOnDecision(candidate, decision, now, deps))) acted += 1;
    }
  }
  return logRunSummary({ reason: failure ?? 'completed', acted, candidates: candidates.length, selected: selected.length });
}
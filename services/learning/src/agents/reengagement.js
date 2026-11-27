// Daily re-engagement agent (finding find_42f472c7e4c8). The scheduler invokes the
// learning function with { "job": "learning_reengagement" }; handler.js routes it here.
// Code decides WHO may be nudged (inactivity threshold, enrolment, unfinished course,
// frequency and daily caps) and builds the link; the model only decides nudge/skip,
// which enrolled course to name, and writes the title and body.
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { ChatBedrockConverse } from '@langchain/aws';
import { isEnabled } from '@learnloop/shared/flags';
import { buildLogRecord, getLogContext, logWarn, serialize, setLogSink } from '@learnloop/shared/logger';
import { AGENT_NOTIFICATION_TYPES, createNotification, listNotifications } from '@learnloop/notifications/services/inbox';
import { validateMessage } from '@learnloop/admin/services/messages';
import { listUsersByRole } from '@learnloop/admin/repositories/learners';
import { listEnrolledCourseIds } from '../repositories/enrolments.js';
import { daysSinceLastActivity, getLastActivityAt, listProgressOverview, nextLessonFor } from '../services/progress.js';

export const FLAG_KEY = 'ga-find_42f472c7e4c8';
export const REENGAGEMENT_JOB = 'learning_reengagement';
export const NUDGE_TYPE = AGENT_NOTIFICATION_TYPES[0];

export const INACTIVITY_DAYS = 7;
export const NUDGE_INTERVAL_DAYS = 7;
export const MAX_NUDGES_PER_STREAK = 3;
export const DAILY_SEND_CAP = 50;
export const MAX_PER_RUN = 40;

// Output budget: one decision with a title and a two-sentence body is about 150 tokens.
export const OUTPUT_TOKENS_PER_ITEM = 150;
export const MODEL_BATCH_SIZE = 10;
export const MAX_OUTPUT_TOKENS = Math.ceil(OUTPUT_TOKENS_PER_ITEM * MODEL_BATCH_SIZE * 1.5);
export const MODEL_CONCURRENCY = 2;

const DEFAULT_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const DAY_MS = 86_400_000;
const FAILURES = new Set(['model_reply_truncated', 'model_reply_unparseable', 'model_call_failed']);

/** The existing deterministic functions the agent calls (overridable in tests). */
export const DEFAULT_DEPS = Object.freeze({
  listUsersByRole, listEnrolledCourseIds, daysSinceLastActivity, getLastActivityAt,
  listProgressOverview, nextLessonFor, listNotifications, createNotification,
});

const SYSTEM_PROMPT = [
  'You help lapsed learners on LearnLoop get back to their courses.',
  'You receive JSON {"learners":[{ref, daysInactive, pastNudges, pastNudgesRead, courses:[{courseId, courseTitle, percent, nextLessonTitle}]}]}.',
  'For each learner decide "nudge" or "skip" (skip, for example, when earlier nudges went unread and another would be noise).',
  'When nudging, pick ONE courseId from that learner\'s own courses and write a short title (max 80 characters) and a body of at most two sentences naming that course and its next lesson title.',
  'Do not invent links, numbers, discounts or deadlines.',
  'Reply with JSON only: {"decisions":[{"ref":"...","action":"nudge"|"skip","courseId":"...","title":"...","body":"..."}]}',
].join('\n');

/** Exactly one structured summary line per run, through the shared logger's sink. */
export function logRunSummary({ acted, candidates, reason }) {
  const ctx = getLogContext() ?? {};
  const record = buildLogRecord({
    timestamp: new Date().toISOString(),
    level: FAILURES.has(reason) ? 'warn' : 'info',
    service: ctx.service ?? 'learning',
    version: ctx.version ?? 'dev',
    environment: ctx.environment ?? 'dev',
    traceId: ctx.traceId,
    requestId: ctx.requestId,
    message: 'reengagement agent run',
  });
  const sink = setLogSink(() => {});
  setLogSink(sink);
  sink(serialize({ ...record, job: REENGAGEMENT_JOB, acted, candidates, reason }));
  return { acted, candidates, reason };
}

async function buildModel() {
  const region = process.env.AWS_REGION;
  const model = process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID;
  let credentials;
  if (process.env.BEDROCK_ROLE_ARN) {
    const out = await new STSClient({ region }).send(new AssumeRoleCommand({
      RoleArn: process.env.BEDROCK_ROLE_ARN, RoleSessionName: 'learnloop-reengagement',
    }));
    credentials = {
      accessKeyId: out.Credentials.AccessKeyId,
      secretAccessKey: out.Credentials.SecretAccessKey,
      sessionToken: out.Credentials.SessionToken,
    };
  }
  return new ChatBedrockConverse({ model, region, maxTokens: MAX_OUTPUT_TOKENS, temperature: 0, ...(credentials ? { credentials } : {}) });
}

async function evaluate(user, nudges, now, deps) {
  const days = await deps.daysSinceLastActivity(user.id, now);
  if (days === null || days < INACTIVITY_DAYS) return null;
  if ((await deps.listEnrolledCourseIds(user.id)).length === 0) return null;
  const lastActivityAt = await deps.getLastActivityAt(user.id);
  if (nudges.some((n) => now - new Date(n.created_at) < NUDGE_INTERVAL_DAYS * DAY_MS)) return null;
  const streak = nudges.filter((n) => !lastActivityAt || n.created_at > lastActivityAt);
  if (streak.length >= MAX_NUDGES_PER_STREAK) return null;
  const courses = (await deps.listProgressOverview(user.id)).filter((c) => c.nextLesson);
  if (courses.length === 0) return null;
  return {
    userId: user.id,
    daysInactive: days,
    pastNudges: streak.length,
    pastNudgesRead: streak.filter((n) => n.read_at).length,
    courses: courses.map((c) => ({ courseId: c.courseId, courseTitle: c.courseTitle, percent: c.percent, nextLessonTitle: c.nextLesson.title })),
  };
}

/** Eligible learners (deterministic) and how many nudges were already sent today. */
export async function findCandidates(now = new Date(), deps = DEFAULT_DEPS) {
  const today = now.toISOString().slice(0, 10);
  const learners = await deps.listUsersByRole('learner');
  const rows = await Promise.all(learners.map(async (user) => {
    const nudges = (await deps.listNotifications(user.id)).filter((n) => n.type === NUDGE_TYPE && n.applied_by_agent === true);
    return { sentToday: nudges.filter((n) => n.created_at.slice(0, 10) === today).length, candidate: await evaluate(user, nudges, now, deps) };
  }));
  return {
    candidates: rows.map((r) => r.candidate).filter(Boolean),
    sentToday: rows.reduce((sum, r) => sum + r.sentToday, 0),
  };
}

/** Most at risk first: longest stall, then closest to finishing. */
export function rankCandidates(candidates) {
  const best = (c) => Math.max(...c.courses.map((x) => x.percent));
  return [...candidates].sort((a, b) => b.daysInactive - a.daysInactive || best(b) - best(a) || a.userId.localeCompare(b.userId));
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  return '';
}

export function parseDecisions(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed?.decisions) ? parsed.decisions : null;
  } catch {
    return null;
  }
}

async function decideChunk(llm, chunk) {
  const byRef = new Map(chunk.map((c, i) => [`c${i + 1}`, c]));
  const learners = [...byRef].map(([ref, c]) => ({ ref, daysInactive: c.daysInactive, pastNudges: c.pastNudges, pastNudgesRead: c.pastNudgesRead, courses: c.courses }));
  let response;
  try {
    response = await llm.invoke([['system', SYSTEM_PROMPT], ['human', JSON.stringify({ learners })]]);
  } catch (error) {
    logWarn('reengagement model call failed', { errorType: error?.name ?? 'Error' });
    return { error: 'model_call_failed' };
  }
  if (response?.response_metadata?.stopReason === 'max_tokens') {
    logWarn('reengagement model reply truncated', { errorType: 'MaxTokens' });
    return { error: 'model_reply_truncated' };
  }
  const decisions = parseDecisions(textOf(response?.content));
  if (!decisions) {
    logWarn('reengagement model reply unparseable', { errorType: 'Unparseable' });
    return { error: 'model_reply_unparseable' };
  }
  return { decisions: decisions.map((d) => ({ ...d, candidate: byRef.get(d?.ref) })).filter((d) => d.candidate) };
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function applyDecision(decision, now, deps) {
  if (decision.action !== 'nudge') return false;
  const { candidate } = decision;
  const course = candidate.courses.find((c) => c.courseId === decision.courseId);
  if (!course) return false;
  let message;
  try {
    message = validateMessage({ title: decision.title, body: decision.body });
  } catch {
    return false;
  }
  const lesson = await deps.nextLessonFor(candidate.userId, course.courseId);
  if (!lesson) return false;
  await deps.createNotification(candidate.userId, { type: NUDGE_TYPE, title: message.title, body: message.body, link: `/lessons/${lesson.id}` }, now);
  return true;
}

export async function runReengagement(now = new Date(), { model, deps = DEFAULT_DEPS, dailyCap = DAILY_SEND_CAP } = {}) {
  if (!(await isEnabled(FLAG_KEY))) return logRunSummary({ acted: 0, candidates: 0, reason: 'flag_off' });
  const { candidates, sentToday } = await findCandidates(now, deps);
  if (candidates.length === 0) return logRunSummary({ acted: 0, candidates: 0, reason: 'no_candidates' });
  const remaining = Math.max(0, dailyCap - sentToday);
  if (remaining === 0) return logRunSummary({ acted: 0, candidates: candidates.length, reason: 'daily_cap' });
  const batch = rankCandidates(candidates).slice(0, Math.min(remaining, MAX_PER_RUN));
  let llm = model;
  if (!llm) {
    try {
      llm = await buildModel();
    } catch (error) {
      logWarn('reengagement model setup failed', { errorType: error?.name ?? 'Error' });
      return logRunSummary({ acted: 0, candidates: candidates.length, reason: 'model_call_failed' });
    }
  }
  const chunks = [];
  for (let i = 0; i < batch.length; i += MODEL_BATCH_SIZE) chunks.push(batch.slice(i, i + MODEL_BATCH_SIZE));
  const results = await mapWithConcurrency(chunks, MODEL_CONCURRENCY, (chunk) => decideChunk(llm, chunk));
  let acted = 0;
  let failure = null;
  const done = new Set();
  for (const result of results) {
    if (result.error) { failure ??= result.error; continue; }
    for (const decision of result.decisions) {
      if (done.has(decision.candidate.userId) || acted >= remaining) continue;
      if (await applyDecision(decision, now, deps)) { done.add(decision.candidate.userId); acted += 1; }
    }
  }
  return logRunSummary({ acted, candidates: candidates.length, reason: failure ?? 'completed' });
}

/** Entry point registered in the jobs map. */
export const runReengagementJob = (now) => runReengagement(now);
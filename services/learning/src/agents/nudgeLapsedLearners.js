// Daily re-engagement agent (finding find_02688b9ceef7). The scheduled rule invokes
// the learning function with { "job": "nudge_lapsed_learners" }; handler.js routes
// it here. Everything is behind the feature flag ga-find_02688b9ceef7 (off by default).
// Code picks the candidates and enforces every guardrail. The model only decides
// nudge/skip, picks one in-progress course and writes the short body text.
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { ChatBedrockConverse } from '@langchain/aws';
import { isEnabled } from '@learnloop/shared/flags';
import { buildLogRecord, getLogContext, newTraceId, runWithLogContext, serialize, setLogSink } from '@learnloop/shared/logger';
import { getStore } from '@learnloop/shared/store';
import { createNotification, listNotifications } from '@learnloop/notifications/services/inbox';
import { sendEmail } from '@learnloop/notifications/services/email';
import { validateMessage } from '@learnloop/admin/services/messages';
import { daysSinceLastActivity, getCourseRecord, listProgressOverview, nextLessonFor } from '../services/progress.js';
import { listCourseActivity } from '../repositories/progress.js';

export const NUDGE_JOB = 'nudge_lapsed_learners';
export const FLAG_KEY = 'ga-find_02688b9ceef7';
export const NUDGE_TYPE = 'learning_nudge';
/** Fixed subject/title and sign-off: the model never writes these. */
export const NUDGE_TITLE = 'Your next lesson is ready';
export const NUDGE_SIGN_OFF = 'The team';
export const DEFAULT_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

export const INACTIVITY_DAYS = 7;
export const COOLDOWN_DAYS = 14;
export const MAX_NUDGES_WITHOUT_LESSON = 3;
export const DAILY_SEND_CAP = 50;
export const MAX_PER_RUN = 50;

// Output budget: one decision with a short body is about 150 tokens.
export const OUTPUT_TOKENS_PER_ITEM = 150;
export const MODEL_BATCH_SIZE = 10;
export const MAX_OUTPUT_TOKENS = Math.ceil(OUTPUT_TOKENS_PER_ITEM * MODEL_BATCH_SIZE * 1.5); // 2250
export const MODEL_CONCURRENCY = 3;
const READ_CONCURRENCY = 10;

const DAY_MS = 86_400_000;
const FAILURES = new Set(['model_reply_truncated', 'model_reply_unparseable', 'model_call_failed']);
const FORBIDDEN_CONTENT = /(https?:\/\/|www\.|[$€£]|discount|coupon|promo|voucher|price|free trial)/i;

const SYSTEM_PROMPT = [
  'You help an online learning platform re-engage learners who stopped taking lessons.',
  'For each learner you get only their learning progress: days since their last lesson and their in-progress courses',
  '(percent complete, lessons done, last and next lesson titles, quiz attempts and last quiz score).',
  'Decide per learner: "nudge" or "skip". Skip when a nudge is unlikely to help. When nudging, pick exactly one course by its "course" reference,',
  'for example the one nearly finished, or the one where a quiz was failed and encouragement helps.',
  'Write "body": 1-2 short, warm sentences (under 300 characters) naming that course title and its next lesson title exactly as given.',
  'Never include links, prices, discounts, offers, or course names not in the data. No greeting and no sign-off.',
  'Reply with JSON only: {"decisions":[{"learner":"L1","action":"nudge","course":"C1","body":"..."},{"learner":"L2","action":"skip"}]}',
].join(' ');

/** Writes exactly one structured summary line through the repository logger's sink. */
function logSummary(reason, acted, candidates) {
  const ctx = getLogContext();
  const record = buildLogRecord({
    timestamp: new Date().toISOString(),
    level: FAILURES.has(reason) ? 'warn' : 'info',
    service: ctx?.service ?? 'learning',
    version: ctx?.version ?? 'dev',
    environment: ctx?.environment ?? 'dev',
    traceId: ctx?.traceId ?? newTraceId(),
    requestId: ctx?.requestId ?? '-',
    errorType: FAILURES.has(reason) ? reason : undefined,
    message: `${NUDGE_JOB} ${JSON.stringify({ job: NUDGE_JOB, reason, acted, candidates })}`,
  });
  const sink = setLogSink(() => {});
  setLogSink(sink);
  sink(serialize(record));
  return { reason, acted, candidates };
}

async function mapBounded(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const k = next++;
      out[k] = await fn(items[k], k);
    }
  });
  await Promise.all(workers);
  return out;
}

const isAgentNudge = (n) => n.type === NUDGE_TYPE && n.applied_by_agent === true;

/** Fixed rules: enrolled, earlier activity, lapsed, cooldown, max nudges without a lesson in between. */
async function scanLearner(user, now) {
  const today = now.toISOString().slice(0, 10);
  const notes = (await listNotifications(user.id)).filter(isAgentNudge);
  const sentToday = notes.filter((n) => n.created_at.slice(0, 10) === today).length;
  const overview = await listProgressOverview(user.id);
  if (overview.length === 0) return { sentToday, candidate: null };
  const [days, activity] = await Promise.all([daysSinceLastActivity(user.id, now), listCourseActivity(user.id)]);
  if (days === null || days < INACTIVITY_DAYS) return { sentToday, candidate: null };
  const lastActivityAt = activity.map((a) => a.last_activity_at).filter(Boolean).sort().at(-1);
  const cooldownStart = new Date(now.getTime() - COOLDOWN_DAYS * DAY_MS).toISOString();
  if (notes.some((n) => n.created_at > cooldownStart)) return { sentToday, candidate: null };
  if (notes.filter((n) => n.created_at > lastActivityAt).length >= MAX_NUDGES_WITHOUT_LESSON) return { sentToday, candidate: null };
  const courses = overview.filter((c) => c.nextLesson && c.percent < 100);
  if (courses.length === 0) return { sentToday, candidate: null };
  return { sentToday, candidate: { user, days, courses, risk: Math.max(...courses.map((c) => c.percent)) } };
}

/** Most at risk first: closest to finishing a course, then the most recently lapsed. */
export function rankCandidates(candidates) {
  return [...candidates].sort((a, b) => b.risk - a.risk || a.days - b.days || a.user.id.localeCompare(b.user.id));
}

async function enrich(candidate, index) {
  const courses = await Promise.all(candidate.courses.map(async (c, j) => {
    const record = await getCourseRecord(candidate.user.id, c.courseId);
    const quizzes = record?.quizResults ?? [];
    return {
      ref: `C${j + 1}`,
      courseId: c.courseId,
      prompt: {
        course: `C${j + 1}`,
        title: c.courseTitle,
        percent: c.percent,
        completedLessons: c.completedLessons,
        totalLessons: c.totalLessons,
        lastLesson: c.lastLesson?.title ?? null,
        nextLesson: c.nextLesson.title,
        quizAttempts: quizzes.length,
        lastQuizScore: quizzes.at(-1)?.score ?? null,
      },
    };
  }));
  return { ref: `L${index + 1}`, user: candidate.user, days: candidate.days, courses, done: false };
}

async function buildModel() {
  const region = process.env.AWS_REGION;
  let credentials;
  if (process.env.BEDROCK_ROLE_ARN) {
    const out = await new STSClient({ region }).send(new AssumeRoleCommand({
      RoleArn: process.env.BEDROCK_ROLE_ARN,
      RoleSessionName: 'learnloop-nudge-agent',
    }));
    credentials = {
      accessKeyId: out.Credentials.AccessKeyId,
      secretAccessKey: out.Credentials.SecretAccessKey,
      sessionToken: out.Credentials.SessionToken,
    };
  }
  return new ChatBedrockConverse({
    model: process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID,
    region,
    maxTokens: MAX_OUTPUT_TOKENS,
    temperature: 0.3,
    ...(credentials ? { credentials } : {}),
  });
}

function replyText(reply) {
  if (typeof reply?.content === 'string') return reply.content;
  if (Array.isArray(reply?.content)) return reply.content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
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

async function decideChunk(model, chunk) {
  const payload = { learners: chunk.map((i) => ({ learner: i.ref, daysSinceLastLesson: i.days, courses: i.courses.map((c) => c.prompt) })) };
  let reply;
  try {
    reply = await model.invoke([['system', SYSTEM_PROMPT], ['human', JSON.stringify(payload)]]);
  } catch {
    return { ok: false, reason: 'model_call_failed' };
  }
  if (reply?.response_metadata?.stopReason === 'max_tokens') return { ok: false, reason: 'model_reply_truncated' };
  const decisions = parseDecisions(replyText(reply));
  if (!decisions) return { ok: false, reason: 'model_reply_unparseable' };
  return { ok: true, decisions };
}

async function act(decision, byRef, now, parent) {
  if (decision?.action !== 'nudge') return false;
  const item = byRef.get(decision.learner);
  if (!item || item.done) return false;
  const course = item.courses.find((c) => c.ref === decision.course);
  if (!course) return false;
  const next = await nextLessonFor(item.user.id, course.courseId); // the only link target
  if (!next) return false;
  let message;
  try {
    message = validateMessage({ title: NUDGE_TITLE, body: decision.body });
  } catch {
    return false;
  }
  if (FORBIDDEN_CONTENT.test(message.body)) return false;
  item.done = true;
  const ctx = { ...parent, userId: item.user.id, sessionId: undefined, role: 'system' };
  return runWithLogContext(ctx, async () => {
    await createNotification(item.user.id, {
      type: NUDGE_TYPE, title: message.title, body: message.body, link: `/lessons/${next.id}`, appliedByAgent: true,
    }, now);
    await sendEmail({
      to: item.user.email,
      template: 'staff_message',
      data: { name: item.user.name, title: NUDGE_TITLE, body: `${message.body}\n\nNext lesson: ${next.title}`, staffName: NUDGE_SIGN_OFF },
    });
    return true;
  });
}

/** The scheduled job. Returns and logs { reason, acted, candidates }. */
export async function nudgeLapsedLearners(now = new Date(), options = {}) {
  const dailyCap = options.dailyCap ?? DAILY_SEND_CAP;
  if (!(await isEnabled(FLAG_KEY))) return logSummary('flag_off', 0, 0);

  const learners = (await getStore().read('users')).filter((u) => u.role === 'learner');
  const scanned = await mapBounded(learners, READ_CONCURRENCY, (u) => scanLearner(u, now));
  const sentToday = scanned.reduce((sum, s) => sum + s.sentToday, 0);
  const candidates = rankCandidates(scanned.map((s) => s.candidate).filter(Boolean));
  if (candidates.length === 0) return logSummary('no_candidates', 0, 0);
  const room = Math.min(dailyCap - sentToday, MAX_PER_RUN);
  if (room <= 0) return logSummary('daily_cap', 0, candidates.length);

  const selected = await mapBounded(candidates.slice(0, room), READ_CONCURRENCY, enrich);
  let model;
  try {
    model = options.model ?? await buildModel();
  } catch {
    return logSummary('model_call_failed', 0, candidates.length);
  }
  const chunks = [];
  for (let k = 0; k < selected.length; k += MODEL_BATCH_SIZE) chunks.push(selected.slice(k, k + MODEL_BATCH_SIZE));
  const results = await mapBounded(chunks, MODEL_CONCURRENCY, (chunk) => decideChunk(model, chunk));

  const parent = getLogContext() ?? {};
  let acted = 0;
  let failure = null;
  for (const [k, result] of results.entries()) {
    if (!result.ok) {
      failure ??= result.reason;
      continue;
    }
    const byRef = new Map(chunks[k].map((i) => [i.ref, i]));
    for (const decision of result.decisions) {
      if (acted >= room) break;
      if (await act(decision, byRef, now, parent)) acted += 1;
    }
  }
  return logSummary(failure ?? 'completed', acted, candidates.length);
}
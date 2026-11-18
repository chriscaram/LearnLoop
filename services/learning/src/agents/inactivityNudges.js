// Daily re-engagement agent (finding find_99c029aac886). The learning function
// is invoked with { "job": "inactivity_nudges" } and handler.js routes it here,
// the same way billing runs renew_subscriptions. Shipped dark behind the
// feature flag "ga-find_99c029aac886".
//
// The existing code computes every fact (days inactive, next lesson, completion
// percent, enrolments); the guardrails are enforced here in code; the model
// only decides whether to nudge, which course, and writes subject + body.
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { ChatBedrockConverse } from '@langchain/aws';
import { isEnabled } from '@learnloop/shared/flags';
import {
  buildLogRecord, getLogContext, logWarn, newTraceId, runWithLogContext, serialize, setLogSink,
} from '@learnloop/shared/logger';
import { createNotification } from '@learnloop/notifications/services/inbox';
import { sendEmail } from '@learnloop/notifications/services/email';
import { listEnrolledCourseIds } from '../repositories/enrolments.js';
import { findCourseById, listLessonsForCourse } from '../repositories/lessons.js';
import { listLessonProgress } from '../repositories/progress.js';
import { completionPercent, daysSinceLastActivity, nextLessonFor } from '../services/progress.js';
import { listAgentNudges, listLearnerUsers, markAppliedByAgent } from './nudgeRecords.js';

export const NUDGE_JOB = 'inactivity_nudges';
export const FLAG_KEY = 'ga-find_99c029aac886';

// Guardrails
export const MIN_DAYS_INACTIVE = 7;
export const LEARNER_COOLDOWN_DAYS = 14;
export const MAX_NUDGES_PER_ENROLMENT = 3;
export const MAX_NUDGES_PER_DAY = 50;
export const MAX_TITLE_LENGTH = 120;
export const MAX_BODY_LENGTH = 2000;

// Model budget: one decision with a subject line and a 2-3 sentence body.
export const OUTPUT_TOKENS_PER_ITEM = 200;
export const MODEL_BATCH_SIZE = 10;
export const MODEL_MAX_TOKENS = Math.ceil(OUTPUT_TOKENS_PER_ITEM * MODEL_BATCH_SIZE * 1.5); // 3000
export const MODEL_CONCURRENCY = 3;
const DEFAULT_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

const DAY_MS = 86_400_000;
const LINK_RE = /(https?:\/\/|www\.|\/lessons\/|\.(com|net|org|io)\b)/i;

const SYSTEM_PROMPT = [
  'You help learners on LearnLoop who have stopped opening their lessons get back on track.',
  'For each learner in the input decide whether to send ONE short, friendly nudge now, and about which ONE of their courses',
  '(prefer the course closest to completion). Skip a learner when a nudge would not help.',
  'Write only from the facts given: course title, next lesson title and completion percent. Do not add links, URLs, prices,',
  'offers, dates or any other number. Subject under 80 characters; body two or three sentences, under 400 characters.',
  'Reply with JSON only, one entry per learner:',
  '{"decisions":[{"ref":"L1","nudge":true,"courseRef":"C1","subject":"...","body":"..."}]}',
  'Use "nudge": false with empty subject and body to skip a learner.',
].join(' ');

/** Bedrock chat model through LangChain; default credential chain, optional role from BEDROCK_ROLE_ARN. */
export async function buildModel() {
  const region = process.env.AWS_REGION;
  let credentials;
  if (process.env.BEDROCK_ROLE_ARN) {
    const out = await new STSClient({ region }).send(new AssumeRoleCommand({
      RoleArn: process.env.BEDROCK_ROLE_ARN,
      RoleSessionName: 'learnloop-inactivity-nudges',
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
    maxTokens: MODEL_MAX_TOKENS,
    temperature: 0.2,
    ...(credentials ? { credentials } : {}),
  });
}

/** Most at risk first: longest stall, then closest to finishing. */
export function byRisk(a, b) {
  const best = (c) => Math.max(...c.courses.map((k) => k.percent));
  return b.daysInactive - a.daysInactive || best(b) - best(a) || a.user.id.localeCompare(b.user.id);
}

/** Eligible learners with their nudgeable courses, computed by the existing progress code. */
export async function findCandidates(now, history) {
  const cooldownStart = now.getTime() - LEARNER_COOLDOWN_DAYS * DAY_MS;
  const candidates = [];
  for (const user of await listLearnerUsers()) {
    const mine = history.filter((n) => n.user_id === user.id);
    if (mine.some((n) => new Date(n.created_at).getTime() > cooldownStart)) continue;
    const daysInactive = await daysSinceLastActivity(user.id, now);
    if (daysInactive === null || daysInactive < MIN_DAYS_INACTIVE) continue;
    const courses = [];
    for (const courseId of await listEnrolledCourseIds(user.id)) {
      const previous = mine.filter((n) => n.course_id === courseId).length;
      if (previous >= MAX_NUDGES_PER_ENROLMENT) continue;
      const records = await listLessonProgress(user.id, courseId);
      if (records.length === 0) continue; // never started this course
      const next = await nextLessonFor(user.id, courseId);
      if (!next) continue; // course finished
      const course = await findCourseById(courseId);
      if (!course) continue;
      const percent = completionPercent(records, { lessons: await listLessonsForCourse(courseId) });
      courses.push({ courseId, courseTitle: course.title, nextLesson: { id: next.id, title: next.title }, percent, previousNudges: previous });
    }
    if (courses.length > 0) candidates.push({ user, daysInactive, previousNudges: mine.length, courses });
  }
  return candidates.sort(byRisk);
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  return '';
}

/** The decisions list from a model reply, or null when it does not parse. */
export function parseDecisions(text) {
  const cleaned = String(text ?? '').replace(/```(?:json)?/g, '').trim();
  const start = cleaned.search(/[[{]/);
  if (start < 0) return null;
  const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
  try {
    const value = JSON.parse(cleaned.slice(start, end + 1));
    const list = Array.isArray(value) ? value : value?.decisions;
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

/** Length/type checks plus: no links and no number except the supplied facts. Null drops the message. */
export function validateNudge({ subject, body }, candidate, course) {
  const title = typeof subject === 'string' ? subject.trim() : '';
  const text = typeof body === 'string' ? body.trim() : '';
  if (!title || title.length > MAX_TITLE_LENGTH || !text || text.length > MAX_BODY_LENGTH) return null;
  const all = `${title}\n${text}`;
  if (LINK_RE.test(all)) return null;
  let rest = all;
  for (const fact of [course.courseTitle, course.nextLesson.title]) rest = rest.split(fact).join(' ');
  const allowed = new Set([course.percent, candidate.daysInactive]);
  if (!(rest.match(/\d+/g) ?? []).every((n) => allowed.has(Number(n)))) return null;
  return { title, body: text };
}

/** One bounded model call for up to MODEL_BATCH_SIZE candidates. */
export async function decideBatch(model, items) {
  const learners = items.map((c, i) => ({
    ref: `L${i + 1}`,
    daysInactive: c.daysInactive,
    previousNudges: c.previousNudges,
    courses: c.courses.map((k, j) => ({
      ref: `C${j + 1}`, courseTitle: k.courseTitle, nextLessonTitle: k.nextLesson.title, completionPercent: k.percent, previousNudges: k.previousNudges,
    })),
  }));
  let reply;
  try {
    reply = await model.invoke([['system', SYSTEM_PROMPT], ['human', JSON.stringify({ learners })]]);
  } catch (error) {
    logWarn('inactivity nudge model call failed', { errorType: error?.name ?? 'Error' });
    return { error: 'model_call_failed' };
  }
  if (reply?.response_metadata?.stopReason === 'max_tokens') {
    logWarn('inactivity nudge model reply truncated', { errorType: 'MaxTokens' });
    return { error: 'model_reply_truncated' };
  }
  const parsed = parseDecisions(textOf(reply?.content));
  if (!parsed) {
    logWarn('inactivity nudge model reply unparseable', { errorType: 'Unparseable' });
    return { error: 'model_reply_unparseable' };
  }
  const decisions = [];
  const seen = new Set();
  for (const d of parsed) {
    const i = learners.findIndex((l) => l.ref === d?.ref);
    if (i < 0 || seen.has(i) || d.nudge !== true) continue;
    const j = learners[i].courses.findIndex((k) => k.ref === d.courseRef);
    if (j < 0) continue;
    const candidate = items[i];
    const course = candidate.courses[j];
    const message = validateNudge(d, candidate, course);
    if (!message) continue;
    seen.add(i);
    decisions.push({ candidate, course, ...message });
  }
  return { decisions };
}

async function mapBounded(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Inbox notification + email for one decision; the link comes from nextLessonFor, never the model. */
async function act({ candidate, course, title, body }, now) {
  const parent = getLogContext() ?? {};
  const ctx = { ...parent, userId: candidate.user.id, sessionId: undefined, role: 'system' };
  return runWithLogContext(ctx, async () => {
    try {
      const link = `/lessons/${course.nextLesson.id}`;
      const notification = await createNotification(candidate.user.id, { type: 'staff_message', title, body, link }, now);
      await markAppliedByAgent(notification.id, { course_id: course.courseId, lesson_id: course.nextLesson.id, email_status: 'pending' });
      const email = {
        to: candidate.user.email,
        template: 'staff_message',
        data: { name: candidate.user.name, title, body: `${body}\n\nResume "${course.nextLesson.title}": ${link}`, staffName: 'The team' },
      };
      let sent = await sendEmail(email);
      if (!sent.ok) sent = await sendEmail(email); // one retry, never more
      await markAppliedByAgent(notification.id, { email_status: sent.ok ? 'sent' : 'failed' });
      return true;
    } catch (error) {
      logWarn('inactivity nudge could not be delivered', { errorType: error?.name ?? 'Error' });
      return false;
    }
  });
}

/** The one structured summary line of a run, through the shared logger's record builder and sink. */
function logRunSummary({ acted, candidates, reason }) {
  const ctx = getLogContext() ?? {};
  const record = buildLogRecord({
    timestamp: new Date().toISOString(),
    level: ['completed', 'flag_off', 'no_candidates', 'daily_cap'].includes(reason) ? 'info' : 'warn',
    service: ctx.service ?? 'learning',
    version: ctx.version ?? 'dev',
    environment: ctx.environment ?? 'dev',
    traceId: ctx.traceId ?? newTraceId(),
    requestId: ctx.requestId,
    message: 'inactivity nudge run',
  });
  const sink = setLogSink(() => {});
  setLogSink(sink);
  sink(serialize({ ...record, job: NUDGE_JOB, actor_type: 'system', acted, candidates, reason }));
  return { acted, candidates, reason };
}

/** The scheduled job. Options are for tests: an injected model and a smaller cap. */
export async function runInactivityNudges(now = new Date(), { model, maxPerRun = MAX_NUDGES_PER_DAY } = {}) {
  if (!(await isEnabled(FLAG_KEY))) return logRunSummary({ acted: 0, candidates: 0, reason: 'flag_off' });

  const history = await listAgentNudges();
  const today = now.toISOString().slice(0, 10);
  const remaining = maxPerRun - history.filter((n) => n.created_at.slice(0, 10) === today).length;
  const candidates = await findCandidates(now, history);
  if (candidates.length === 0) return logRunSummary({ acted: 0, candidates: 0, reason: 'no_candidates' });
  if (remaining <= 0) return logRunSummary({ acted: 0, candidates: candidates.length, reason: 'daily_cap' });

  const selected = candidates.slice(0, remaining); // already most at risk first
  let llm = model;
  if (!llm) {
    try {
      llm = await buildModel();
    } catch (error) {
      logWarn('inactivity nudge model could not be created', { errorType: error?.name ?? 'Error' });
      return logRunSummary({ acted: 0, candidates: candidates.length, reason: 'model_call_failed' });
    }
  }

  const chunks = [];
  for (let i = 0; i < selected.length; i += MODEL_BATCH_SIZE) chunks.push(selected.slice(i, i + MODEL_BATCH_SIZE));
  const results = await mapBounded(chunks, MODEL_CONCURRENCY, (items) => decideBatch(llm, items));

  let acted = 0;
  for (const result of results) {
    for (const decision of result.decisions ?? []) {
      if (await act(decision, now)) acted += 1; // sequential: one writer on the state store
    }
  }
  const failure = results.find((r) => r.error)?.error;
  return logRunSummary({ acted, candidates: candidates.length, reason: failure ?? 'completed' });
}
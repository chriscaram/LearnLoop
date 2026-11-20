// Daily AI re-engagement agent (finding find_9c5cee13064a). EventBridge invokes the
// learning function with { "job": "reengagement_nudges" }; handler.js routes that here.
// Switched off unless the feature flag "ga-find_9c5cee13064a" is enabled.
//
// Deterministic code decides who is eligible (existing progress and notification
// functions) and enforces every guardrail BEFORE the model is called. The model only
// decides nudge/skip and which listed course, and writes the title and body. It never
// sees names, emails, organization, department or manager.
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { ChatBedrockConverse } from '@langchain/aws';
import { listUsersByRole } from '@learnloop/admin/repositories/learners';
import { validateMessage } from '@learnloop/admin/services/messages';
import { sendEmail } from '@learnloop/notifications/services/email';
import { createNotification, listNotifications } from '@learnloop/notifications/services/inbox';
import { isEnabled } from '@learnloop/shared/flags';
import { getLogContext, logWarn, runWithLogContext } from '@learnloop/shared/logger';
import { daysSinceLastActivity, getLastActivityAt, listProgressOverview, nextLessonFor } from '../services/progress.js';

export const REENGAGEMENT_JOB = 'reengagement_nudges';
export const FLAG_KEY = 'ga-find_9c5cee13064a';
export const DEFAULT_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

// Guardrails (deterministic)
export const INACTIVITY_DAYS = 7;
export const NUDGE_INTERVAL_DAYS = 14;
export const MAX_NUDGES_WITHOUT_ACTIVITY = 3;
export const DAILY_SEND_CAP = 50;
export const MAX_PER_RUN = 50;

// Model budget: one decision with a title and a short body is about 250 output tokens.
export const OUTPUT_TOKENS_PER_ITEM = 250;
export const MODEL_BATCH_SIZE = 10;
export const MAX_OUTPUT_TOKENS = Math.ceil(OUTPUT_TOKENS_PER_ITEM * MODEL_BATCH_SIZE * 1.5); // 3750
export const MODEL_CONCURRENCY = 2;

export const SUMMARY_PREFIX = 'reengagement_job_summary';
const FAILURE_ORDER = ['model_reply_truncated', 'model_reply_unparseable', 'model_call_failed'];
const DAY_MS = 86_400_000;
const EMAIL_SIGNATURE = 'The LearnLoop team';

const SYSTEM_PROMPT = [
  'You help learners of LearnLoop, an online course platform, return to a course they started.',
  'For each learner in the list, decide "nudge" or "skip". When nudging, choose ONE course from that learner\'s list.',
  'Use only the facts given. Never invent numbers, dates, lessons or courses.',
  'Write a short, warm, personal message in the second person: a title of at most 80 characters and a body of at most 400 characters',
  'that names the course title, the next lesson title and the percent complete exactly as given. Do not greet by name and do not sign off.',
  'Reply with ONLY a JSON array, one object per learner:',
  '{"ref": string, "action": "nudge" | "skip", "courseId": string | null, "title": string | null, "body": string | null}',
].join('\n');

/** Bedrock chat model via LangChain; assumes BEDROCK_ROLE_ARN first when it is set. */
export async function buildModel() {
  const region = process.env.AWS_REGION;
  const options = {
    model: process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID,
    region,
    maxTokens: MAX_OUTPUT_TOKENS,
    temperature: 0.3,
  };
  if (process.env.BEDROCK_ROLE_ARN) {
    const out = await new STSClient({ region }).send(new AssumeRoleCommand({
      RoleArn: process.env.BEDROCK_ROLE_ARN,
      RoleSessionName: 'learnloop-reengagement-agent',
    }));
    options.credentials = {
      accessKeyId: out.Credentials.AccessKeyId,
      secretAccessKey: out.Credentials.SecretAccessKey,
      sessionToken: out.Credentials.SessionToken,
    };
  }
  return new ChatBedrockConverse(options);
}

const maxPercent = (c) => Math.max(...c.courses.map((x) => x.percent));

/** Risk order: longest inactivity first, then closest to finishing. */
export function byRisk(a, b) {
  return b.daysInactive - a.daysInactive || maxPercent(b) - maxPercent(a) || a.userId.localeCompare(b.userId);
}

/**
 * Eligible learners, most at risk first, plus how many agent nudges were already
 * sent today (for the daily cap). Uses only activity, progress and past nudges.
 */
export async function collectCandidates(now = new Date()) {
  const learners = await listUsersByRole('learner');
  const today = now.toISOString().slice(0, 10);
  let sentToday = 0;
  const rows = await Promise.all(learners.map(async (u) => {
    const nudges = (await listNotifications(u.id)).filter((n) => n.applied_by_agent === true);
    sentToday += nudges.filter((n) => n.created_at.startsWith(today)).length;
    const daysInactive = await daysSinceLastActivity(u.id, now);
    if (daysInactive === null || daysInactive < INACTIVITY_DAYS) return null;
    if (nudges.some((n) => now - new Date(n.created_at) < NUDGE_INTERVAL_DAYS * DAY_MS)) return null;
    const lastActivityAt = await getLastActivityAt(u.id);
    const nudgesWithoutActivity = nudges.filter((n) => n.created_at > lastActivityAt).length;
    if (nudgesWithoutActivity >= MAX_NUDGES_WITHOUT_ACTIVITY) return null;
    const courses = (await listProgressOverview(u.id))
      .filter((c) => c.nextLesson && c.percent < 100)
      .map((c) => ({ courseId: c.courseId, courseTitle: c.courseTitle, percent: c.percent, nextLessonTitle: c.nextLesson.title }));
    if (courses.length === 0) return null;
    return { userId: u.id, name: u.name, email: u.email, daysInactive, nudgesWithoutActivity, courses };
  }));
  return { candidates: rows.filter(Boolean).sort(byRisk), sentToday };
}

function replyText(response) {
  const { content } = response ?? {};
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  return '';
}

/** JSON array of decisions, or null when the reply is not one. */
export function parseDecisions(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end < start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function decideBatch(model, batch) {
  const refs = new Map(batch.map((c, i) => [`c${i + 1}`, c]));
  const facts = [...refs].map(([ref, c]) => ({
    ref, daysInactive: c.daysInactive, nudgesWithoutActivity: c.nudgesWithoutActivity, courses: c.courses,
  }));
  let response;
  try {
    response = await model.invoke([['system', SYSTEM_PROMPT], ['human', `Learners:\n${JSON.stringify(facts)}`]]);
  } catch {
    return { failure: 'model_call_failed' };
  }
  if (response.response_metadata?.stopReason === 'max_tokens') return { failure: 'model_reply_truncated' };
  const decisions = parseDecisions(replyText(response));
  if (!decisions) return { failure: 'model_reply_unparseable' };
  return { refs, decisions };
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

function finish({ reason, acted = 0, candidates = 0, selected = 0, failedBatches = 0 }) {
  const summary = { job: REENGAGEMENT_JOB, reason, acted, candidates, selected, failedBatches };
  logWarn(`${SUMMARY_PREFIX} ${JSON.stringify(summary)}`, FAILURE_ORDER.includes(reason) ? { errorType: reason } : {});
  return summary;
}

async function sendNudge(candidate, courseId, message, now) {
  const next = await nextLessonFor(candidate.userId, courseId); // the link is always the real next lesson
  if (!next) return false;
  const parent = getLogContext() ?? {};
  const ctx = { ...parent, userId: candidate.userId, sessionId: undefined, role: 'system' };
  await runWithLogContext(ctx, async () => {
    await createNotification(candidate.userId, {
      type: 'staff_message', title: message.title, body: message.body, link: `/lessons/${next.id}`, appliedByAgent: true,
    }, now);
    await sendEmail({
      to: candidate.email,
      template: 'staff_message',
      data: { name: candidate.name, title: message.title, body: message.body, staffName: EMAIL_SIGNATURE },
    });
  });
  return true;
}

/** The scheduled job. Options exist for tests: an injected model and a daily cap. */
export async function runReengagementJob(now = new Date(), { model, dailyCap = DAILY_SEND_CAP } = {}) {
  if (!(await isEnabled(FLAG_KEY))) return finish({ reason: 'flag_off' });
  const { candidates, sentToday } = await collectCandidates(now);
  if (candidates.length === 0) return finish({ reason: 'no_candidates' });
  const room = Math.min(dailyCap - sentToday, MAX_PER_RUN);
  if (room <= 0) return finish({ reason: 'daily_cap', candidates: candidates.length });
  const selected = candidates.slice(0, room);

  let chat = model;
  if (!chat) {
    try {
      chat = await buildModel();
    } catch {
      return finish({ reason: 'model_call_failed', candidates: candidates.length, selected: selected.length });
    }
  }

  const batches = [];
  for (let i = 0; i < selected.length; i += MODEL_BATCH_SIZE) batches.push(selected.slice(i, i + MODEL_BATCH_SIZE));
  const results = await mapPool(batches, MODEL_CONCURRENCY, (batch) => decideBatch(chat, batch));

  const failures = new Set();
  let acted = 0;
  for (const result of results) {
    if (result.failure) {
      failures.add(result.failure);
      continue;
    }
    const seen = new Set();
    for (const d of result.decisions) {
      if (d?.action !== 'nudge' || seen.has(d.ref)) continue;
      const candidate = result.refs.get(d.ref);
      if (!candidate || !candidate.courses.some((c) => c.courseId === d.courseId)) continue;
      seen.add(d.ref);
      let message;
      try {
        message = validateMessage({ title: d.title, body: d.body });
      } catch {
        continue; // generated text that fails the existing validation is never sent
      }
      if (acted >= room) break;
      if (await sendNudge(candidate, d.courseId, message, now)) acted += 1;
    }
  }
  const reason = FAILURE_ORDER.find((f) => failures.has(f)) ?? 'completed';
  return finish({ reason, acted, candidates: candidates.length, selected: selected.length, failedBatches: results.filter((r) => r.failure).length });
}
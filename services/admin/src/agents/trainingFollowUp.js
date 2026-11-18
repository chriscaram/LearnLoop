// AI agent for finding find_a52857d8153f: daily follow-up on mandatory training.
// A scheduled invocation { "job": "training_follow_up" } (07:00 UTC) is routed here by
// handler.js, the same way billing routes renew_subscriptions. Every state, due date and
// lesson count comes from the existing training code (getLearnerTraining -> trainingState);
// the model only chooses nudge / skip / escalate per learner and words the nudge.
// Guardrails are enforced here, in code, before anything is sent.
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { ChatBedrockConverse } from '@langchain/aws';
import { isEnabled } from '@learnloop/shared/flags';
import { buildLogRecord, getLogContext, logWarn, newTraceId, serialize, setLogSink } from '@learnloop/shared/logger';
import { getStore } from '@learnloop/shared/store';
import { createNotification, listNotifications } from '@learnloop/notifications/services/inbox';
import { listUsersByRole } from '../repositories/learners.js';
import { listOrganizations } from '../repositories/organizations.js';
import { listAssignmentsForOrganization } from '../repositories/trainingAssignments.js';
import { listLearners } from '../services/learners.js';
import { sendStaffMessage, validateMessage } from '../services/messages.js';
import { getLearnerTraining } from '../services/training.js';

export const FOLLOW_UP_JOB = 'training_follow_up';
export const FLAG_KEY = 'ga-find_a52857d8153f';
export const DEFAULT_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
/** Not a user id, so sendStaffMessage signs the email as "LearnLoop staff". */
export const AGENT_SENDER_ID = 'ga_training_agent';

const DAY_MS = 86_400_000;
export const DUE_SOON_DAYS = 14;
export const LEARNER_WINDOW_DAYS = 7;
export const MAX_NUDGES_PER_ASSIGNMENT = 3;
export const ESCALATE_AFTER_UNOPENED = 2;
export const MAX_MESSAGES_PER_RUN = 200;
export const MAX_LEARNERS_PER_RUN = 200;

// Output budget: one decision with a title and a 2-4 sentence body is about 250 tokens.
export const OUTPUT_TOKENS_PER_ITEM = 250;
export const MODEL_BATCH_SIZE = 10;
export const MODEL_MAX_TOKENS = Math.ceil(OUTPUT_TOKENS_PER_ITEM * MODEL_BATCH_SIZE * 1.5); // 3750
export const MODEL_CONCURRENCY = 4;

const FAILURE_LEVEL = new Set(['model_reply_truncated', 'model_reply_unparseable', 'model_call_failed', 'daily_cap']);
const FORBIDDEN = /%|@|https?:|\bscores?\b|\brank|\bcolleagues?\b|\bpeers?\b|\baverage\b|\bcompar|\bother (people|learners|employees)\b/i;

export const SYSTEM_PROMPT = `You help LearnLoop staff follow up on mandatory training for enterprise employees.
For EACH learner in the input choose exactly one action:
- "nudge": pick ONE assignment whose "allowed" list contains "nudge" (prefer the most urgent: overdue first, then the soonest due) and write a reminder;
- "skip": no message now, for example when daysSinceActivity is 0-2 so the learner is already working on it;
- "escalate": only for an assignment whose "allowed" list contains "escalate" (earlier nudges went unopened); it proposes a manager follow-up to staff, nothing is sent to anyone.
A nudge has a title (at most 80 characters) and a body (2-4 short sentences, at most 600 characters) addressed to firstName.
Use ONLY the facts given: the exact course title, the due date, lessons left, and whether a quiz is still to pass. Never mention scores, percentages, other people, comparisons or personal details. Vary the wording from priorAgentNudges.
Reply with JSON only: {"decisions":[{"userId":"...","action":"nudge|skip|escalate","assignmentId":"...","title":"...","body":"...","reason":"few words"}]}`;

export const FOLLOW_UP_DEPS = Object.freeze({
  listOrganizations, listAssignmentsForOrganization, listLearners, getLearnerTraining,
  listNotifications, sendStaffMessage, createNotification, listUsersByRole,
});

// ---------------------------------------------------------------------------
// One structured summary line per run, in the shared logger's record format and sink.

function emitLine(line) {
  const current = setLogSink(() => {});
  setLogSink(current);
  current(line);
}

function logSummary(fields) {
  const ctx = getLogContext() ?? {};
  const record = buildLogRecord({
    timestamp: new Date().toISOString(),
    level: FAILURE_LEVEL.has(fields.reason) ? 'warn' : 'info',
    service: ctx.service ?? 'admin',
    version: ctx.version ?? 'dev',
    environment: ctx.environment ?? 'dev',
    traceId: ctx.traceId ?? newTraceId(),
    requestId: ctx.requestId,
    message: 'agent run summary',
  });
  emitLine(serialize({ ...record, job: FOLLOW_UP_JOB, flag_key: FLAG_KEY, ...fields }));
}

// ---------------------------------------------------------------------------
// Candidates (deterministic)

async function escalatedAssignments(deps) {
  const done = new Set();
  for (const staff of await deps.listUsersByRole('staff')) {
    for (const n of await deps.listNotifications(staff.id)) {
      if (n.applied_by_agent && n.agent_kind === 'escalation') for (const id of n.assignment_ids ?? []) done.add(id);
    }
  }
  return done;
}

async function buildCandidate(row, now, deps, escalated) {
  const [{ learner, assignments }, notes] = await Promise.all([deps.getLearnerTraining(row.userId, now), deps.listNotifications(row.userId)]);
  const staffNotes = notes.filter((n) => n.type === 'staff_message'); // newest first
  const last = staffNotes[0]?.created_at;
  const recentlyMessaged = Boolean(last) && now.getTime() - Date.parse(last) < LEARNER_WINDOW_DAYS * DAY_MS;
  const items = [];
  for (const a of assignments) {
    if (a.status === 'completed') continue;
    const dueInDays = (Date.parse(a.dueAt) - now.getTime()) / DAY_MS;
    if (a.status !== 'overdue' && dueInDays > DUE_SOON_DAYS) continue;
    const prior = staffNotes.filter((n) => n.applied_by_agent && n.agent_kind === 'nudge' && n.assignment_id === a.id);
    const allowed = [];
    if (!recentlyMessaged && prior.length < MAX_NUDGES_PER_ASSIGNMENT) allowed.push('nudge');
    if (learner.manager && !escalated.has(a.id) && prior.length >= ESCALATE_AFTER_UNOPENED && prior.every((n) => !n.read_at)) allowed.push('escalate');
    if (!allowed.length) continue;
    items.push({
      assignmentId: a.id,
      courseId: a.courseId,
      dueAt: a.dueAt,
      courseTitle: a.courseTitle,
      dueDate: a.dueAt.slice(0, 10),
      overdue: a.status === 'overdue',
      lessonsLeft: a.totalLessons - a.completedLessons,
      quizStillToPass: a.totalLessons > 0 && a.completedLessons === a.totalLessons,
      daysSinceActivity: a.lastActivityAt ? Math.floor((now.getTime() - Date.parse(a.lastActivityAt)) / DAY_MS) : null,
      priorAgentNudges: prior.map((n) => ({ sentOn: n.created_at.slice(0, 10), opened: Boolean(n.read_at), title: n.title })),
      allowed,
    });
  }
  if (!items.length) return null;
  return {
    userId: row.userId,
    name: learner.name,
    firstName: String(learner.name ?? '').split(' ')[0],
    organizationName: row.organization?.name ?? null,
    managerName: row.managerName ?? learner.manager?.name ?? null,
    riskAt: items[0].dueAt, // assignments come soonest due first: the longest overdue is the most at risk
    lessonsLeftTotal: items.reduce((s, i) => s + i.lessonsLeft, 0),
    assignments: items,
  };
}

/** Learners with at least one assignment the guardrails let the agent act on, most at risk first. */
export async function collectCandidates(now, deps = FOLLOW_UP_DEPS) {
  const escalated = await escalatedAssignments(deps);
  const candidates = [];
  for (const org of await deps.listOrganizations()) {
    const [assignments, learners] = await Promise.all([deps.listAssignmentsForOrganization(org.id), deps.listLearners(now, { organizationId: org.id })]);
    const assigned = new Set(assignments.map((a) => a.user_id));
    for (const row of learners.filter((l) => assigned.has(l.userId))) {
      const candidate = await buildCandidate(row, now, deps, escalated);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates.sort((a, b) => a.riskAt.localeCompare(b.riskAt) || b.lessonsLeftTotal - a.lessonsLeftTotal || a.userId.localeCompare(b.userId));
}

// ---------------------------------------------------------------------------
// Model

async function createModel() {
  const region = process.env.AWS_REGION;
  const options = { model: process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID, region, maxTokens: MODEL_MAX_TOKENS, temperature: 0.4 };
  if (process.env.BEDROCK_ROLE_ARN) {
    const out = await new STSClient({ region }).send(new AssumeRoleCommand({ RoleArn: process.env.BEDROCK_ROLE_ARN, RoleSessionName: 'ga-training-follow-up' }));
    options.credentials = { accessKeyId: out.Credentials.AccessKeyId, secretAccessKey: out.Credentials.SecretAccessKey, sessionToken: out.Credentials.SessionToken };
  }
  return new ChatBedrockConverse(options);
}

function textOf(response) {
  const c = response?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
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

const toModelItem = (c) => ({
  userId: c.userId,
  firstName: c.firstName,
  assignments: c.assignments.map(({ courseId, dueAt, ...facts }) => facts),
});

async function decide(llm, chunk, now) {
  let response;
  try {
    response = await llm.invoke([['system', SYSTEM_PROMPT], ['human', JSON.stringify({ today: now.toISOString().slice(0, 10), learners: chunk.map(toModelItem) })]]);
  } catch (error) {
    logWarn('training follow-up model call failed', { errorType: error?.name ?? 'Error' });
    return { ok: false, reason: 'model_call_failed' };
  }
  if (response?.response_metadata?.stopReason === 'max_tokens') {
    logWarn('training follow-up model reply truncated', { errorType: 'MaxTokens' });
    return { ok: false, reason: 'model_reply_truncated' };
  }
  const decisions = parseDecisions(textOf(response));
  if (!decisions) {
    logWarn('training follow-up model reply unparseable', { errorType: 'Unparseable' });
    return { ok: false, reason: 'model_reply_unparseable' };
  }
  const ids = new Set(chunk.map((c) => c.userId));
  return { ok: true, decisions: decisions.filter((d) => d && ids.has(d.userId)) };
}

async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

// ---------------------------------------------------------------------------
// Acting (deterministic checks first)

/** The generated nudge must pass validateMessage, name the course and carry no scores, comparisons or contact details. */
export function checkMessage(decision, item) {
  let message;
  try { message = validateMessage({ title: decision.title, body: decision.body }); } catch { return null; }
  const text = `${message.title} ${message.body}`;
  if (FORBIDDEN.test(text) || !text.includes(item.courseTitle)) return null;
  return message;
}

async function markAgentRecord(notificationId, fields) {
  await getStore().update('notifications', (all) => {
    const found = all.find((n) => n.id === notificationId);
    if (found) Object.assign(found, { applied_by_agent: true, flag_key: FLAG_KEY, ...fields });
  });
}

async function proposeEscalations(escalations, now, deps) {
  const lines = escalations.map(({ c, item }) => `- ${c.name} (${c.organizationName ?? 'no account'}): ${item.courseTitle}, due ${item.dueDate}, ${item.priorAgentNudges.length} reminders unopened. Manager: ${c.managerName}.`);
  const title = `AI agent: ${escalations.length} manager follow-up${escalations.length === 1 ? '' : 's'} to confirm`;
  const body = `The AI agent suggests asking these managers to follow up. Nothing has been sent to them; please confirm and contact them yourself.\n${lines.join('\n')}`;
  const assignmentIds = escalations.map((e) => e.item.assignmentId);
  for (const staff of await deps.listUsersByRole('staff')) {
    const n = await deps.createNotification(staff.id, { type: 'staff_message', title, body, link: '/admin/agent-follow-ups' }, now);
    await markAgentRecord(n.id, { agent_kind: 'escalation', assignment_ids: assignmentIds });
  }
}

/** The scheduled job. Returns the summary it logged. */
export async function runTrainingFollowUp(now = new Date(), { model, deps = FOLLOW_UP_DEPS, maxMessages = MAX_MESSAGES_PER_RUN } = {}) {
  const tally = { acted: 0, candidates: 0, nudged: 0, escalated: 0, skipped: 0, rejected: 0 };
  const finish = (reason) => {
    tally.acted = tally.nudged + tally.escalated;
    logSummary({ ...tally, reason });
    return { ...tally, reason };
  };
  if (!(await isEnabled(FLAG_KEY))) return finish('flag_off');

  const all = await collectCandidates(now, deps);
  tally.candidates = all.length;
  if (!all.length) return finish('no_candidates');
  const batch = all.slice(0, MAX_LEARNERS_PER_RUN); // the rest wait for the next run

  let llm;
  try { llm = model ?? await createModel(); } catch (error) {
    logWarn('training follow-up model setup failed', { errorType: error?.name ?? 'Error' });
    return finish('model_call_failed');
  }
  const chunks = [];
  for (let i = 0; i < batch.length; i += MODEL_BATCH_SIZE) chunks.push(batch.slice(i, i + MODEL_BATCH_SIZE));
  const replies = await mapLimited(chunks, MODEL_CONCURRENCY, (chunk) => decide(llm, chunk, now));
  const failure = replies.find((r) => !r.ok)?.reason ?? null;
  const decisions = new Map();
  for (const r of replies) if (r.ok) for (const d of r.decisions) if (!decisions.has(d.userId)) decisions.set(d.userId, d);

  const escalations = [];
  let capHit = false;
  for (const c of batch) {
    const d = decisions.get(c.userId);
    if (!d) continue;
    if (d.action === 'skip') { tally.skipped += 1; continue; }
    const item = c.assignments.find((a) => a.assignmentId === d.assignmentId);
    if (!item || !item.allowed.includes(d.action)) { tally.rejected += 1; continue; }
    if (d.action === 'escalate') { escalations.push({ c, item }); continue; }
    if (tally.nudged >= maxMessages) { capHit = true; break; }
    const message = checkMessage(d, item);
    if (!message) { tally.rejected += 1; continue; }
    try {
      const sent = await deps.sendStaffMessage(AGENT_SENDER_ID, c.userId, message, now);
      await markAgentRecord(sent.notificationId, { agent_kind: 'nudge', assignment_id: item.assignmentId, course_id: item.courseId });
      tally.nudged += 1;
    } catch (error) {
      logWarn('training follow-up send failed', { errorType: error?.name ?? 'Error' });
      tally.rejected += 1;
    }
  }
  if (escalations.length) {
    await proposeEscalations(escalations, now, deps);
    tally.escalated = escalations.length;
  }
  return finish(failure ?? (capHit ? 'daily_cap' : 'completed'));
}
// AI agent: daily follow-up on mandatory training (finding find_79bbfbd64764).
//
// The scheduler invokes the admin function with { "job": "training_follow_up" };
// handler.js routes that here, the same way billing routes its renewal job.
// Everything is behind the runtime flag "ga-find_79bbfbd64764": with it off the job
// and the review/oversight routes do nothing.
//
// Code decides who may be contacted (trainingState via getLearnerTraining, the
// 7-day and pending-draft guardrails, the escalation rule, the daily cap and the
// risk order). The model only chooses nudge / wait / escalate and writes the text.
// Its output becomes a DRAFT (human_in_the_loop: review_before_send); staff approve
// it and only then is it sent, through the existing sendStaffMessage path.
// The agent never changes assignments, due dates, progress or quiz results.
import { randomBytes } from 'node:crypto';
import { ChatBedrockConverse } from '@langchain/aws';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { isEnabled } from '@learnloop/shared/flags';
import { conflict, notFound, ok } from '@learnloop/shared/http';
import { buildLogRecord, getLogContext, logWarn, serialize, setLogSink } from '@learnloop/shared/logger';
import { getStore } from '@learnloop/shared/store';
import { listNotifications } from '@learnloop/notifications/services/inbox';
import { daysSinceLastActivity, getCourseProgress } from '../clients/learning.js';
import { findUserById } from '../repositories/learners.js';
import { listOrganizations } from '../repositories/organizations.js';
import { listAssignmentsForOrganization } from '../repositories/trainingAssignments.js';
import { sendStaffMessage, validateMessage } from '../services/messages.js';
import { getLearnerTraining } from '../services/training.js';

export const TRAINING_FOLLOW_UP_JOB = 'training_follow_up';
export const FLAG_KEY = 'ga-find_79bbfbd64764';
export const DEFAULT_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

export const DUE_SOON_DAYS = 14;
export const MIN_DAYS_BETWEEN_MESSAGES = 7;
export const ESCALATE_AFTER_UNREAD_NUDGES = 2;
export const DAILY_DRAFT_CAP = 40;
export const MAX_LEARNERS_PER_RUN = 40;

// Output budget: one decision with a title and a short body is about 220 tokens.
export const OUTPUT_TOKENS_PER_ITEM = 220;
export const MODEL_BATCH_SIZE = 8;
export const MODEL_MAX_TOKENS = Math.ceil(OUTPUT_TOKENS_PER_ITEM * MODEL_BATCH_SIZE * 1.5);
export const MODEL_CONCURRENCY = 2;

const DAY_MS = 86_400_000;
const DECISIONS = new Set(['nudge', 'wait', 'escalate']);
const FOCUSES = new Set(['not_started', 'stalled', 'failed_quiz']);
const FAILURE_ORDER = ['model_reply_truncated', 'model_reply_unparseable', 'model_call_failed'];

const SYSTEM_PROMPT = `You help LearnLoop staff follow up on mandatory training that is overdue or due soon.
For each learner in the input JSON decide one of:
- "nudge": write to the learner now;
- "wait": no message now, because recent activity shows they are already working on it;
- "escalate": write to the learner's manager (manager_name) about the learner. Only allowed when escalation_allowed is true.
Choose a focus: "not_started", "stalled" (partway through) or "failed_quiz".
Use only the fields given: assignment state, activity recency and unread earlier nudges. Never mention or infer personal attributes.
For nudge or escalate write a title (at most 100 characters) and a plain-text body (at most 600 characters, 2 to 4 sentences)
that names the course, the due date exactly as given in due_date, and the concrete next step from next_step
(for a failed quiz, the score needed is required_pass_score). Do not invent numbers or dates.
Reply with JSON only, one entry per learner:
{"decisions":[{"ref":"L1","decision":"nudge","focus":"stalled","title":"...","body":"..."}]}
For "wait" omit title and body.`;

// ---------------------------------------------------------------------------
// Drafts (state domain agent_drafts): the staff review queue.
// [{ id, learner_id, recipient_id, kind: 'nudge'|'escalation', focus, assignment_id, course_id,
//    course_title, due_at, title, body, status: 'pending'|'sending'|'sent'|'rejected'|'failed',
//    created_at, reviewed_by, reviewed_at, sent_at, notification_id, applied_by_agent: true }]

const newDraftId = () => `agd_${randomBytes(6).toString('hex')}`;

export async function listAgentDrafts() {
  return getStore().read('agent_drafts');
}

async function insertDrafts(drafts) {
  if (drafts.length === 0) return;
  await getStore().update('agent_drafts', (all) => { all.push(...drafts); });
}

/** Mutates one draft; mutate returning false leaves it unchanged. Returns a copy or null. */
async function updateDraft(id, mutate) {
  return getStore().update('agent_drafts', (all) => {
    const draft = all.find((d) => d.id === id);
    if (!draft || mutate(draft) === false) return null;
    return { ...draft };
  });
}

export async function requireAgentFlag() {
  if (!(await isEnabled(FLAG_KEY))) throw notFound('route_not_found');
}

// ---------------------------------------------------------------------------
// One structured summary line per run, in the shared logger's record format.

function logRunSummary(acted, candidates, reason) {
  const ctx = getLogContext() ?? {};
  const record = {
    ...buildLogRecord({
      timestamp: new Date().toISOString(),
      level: FAILURE_ORDER.includes(reason) ? 'warn' : 'info',
      service: ctx.service ?? 'admin',
      version: ctx.version ?? 'dev',
      environment: ctx.environment ?? 'dev',
      traceId: ctx.traceId,
      requestId: ctx.requestId,
      message: 'training follow-up agent run',
    }),
    'agent.job': TRAINING_FOLLOW_UP_JOB,
    'agent.acted': acted,
    'agent.candidates': candidates,
    'agent.reason': reason,
  };
  // The shared logger exposes its sink only through setLogSink; read it and put it straight back.
  const sink = setLogSink(() => {});
  setLogSink(sink);
  sink(serialize(record));
}

function finish(acted, candidates, reason) {
  logRunSummary(acted, candidates, reason);
  return { acted, candidates, reason };
}

// ---------------------------------------------------------------------------
// Deterministic selection

/** Every enterprise employee's training, as getLearnerTraining (trainingState) works it out. */
export async function collectTraining(now = new Date()) {
  const userIds = new Set();
  for (const organization of await listOrganizations()) {
    for (const a of await listAssignmentsForOrganization(organization.id)) userIds.add(a.user_id);
  }
  const out = [];
  for (const userId of [...userIds].sort()) {
    try {
      out.push(await getLearnerTraining(userId, now));
    } catch (error) {
      if (error?.status !== 404) throw error;
    }
  }
  return out;
}

/** Not completed, and overdue or due within DUE_SOON_DAYS; soonest due first. */
export function openAssignments(training, now = new Date()) {
  const horizon = now.getTime() + DUE_SOON_DAYS * DAY_MS;
  return training.assignments.filter((a) => a.status !== 'completed' && (a.status === 'overdue' || Date.parse(a.dueAt) <= horizon));
}

/** Guardrails from earlier messages: 7-day spacing, pending drafts, escalation eligibility. */
export function learnerHistory(userId, drafts, notifications, now = new Date()) {
  const mine = drafts.filter((d) => d.learner_id === userId && d.applied_by_agent === true);
  const readAt = new Map(notifications.map((n) => [n.id, n.read_at]));
  const sent = mine.filter((d) => d.status === 'sent' && d.sent_at).sort((a, b) => a.sent_at.localeCompare(b.sent_at));
  const nudges = sent.filter((d) => d.kind === 'nudge');
  const lastNudge = nudges.at(-1);
  const unreadNudges = nudges.filter((d) => !readAt.get(d.notification_id)).length;
  const escalatedSinceNudge = sent.some((d) => d.kind === 'escalation' && lastNudge && d.sent_at > lastNudge.sent_at);
  const contacts = [...notifications.filter((n) => n.type === 'staff_message').map((n) => n.created_at), ...sent.map((d) => d.sent_at)].sort();
  const lastContact = contacts.at(-1) ?? null;
  const recent = lastContact !== null && now.getTime() - Date.parse(lastContact) < MIN_DAYS_BETWEEN_MESSAGES * DAY_MS;
  const pending = mine.some((d) => d.status === 'pending' || d.status === 'sending');
  return {
    blocked: recent || pending,
    unreadNudges,
    escalationPossible: unreadNudges >= ESCALATE_AFTER_UNREAD_NUDGES && !escalatedSinceNudge,
  };
}

/** Most at risk first: earliest (most overdue) due date, then longest without activity (never = longest). */
export function rankCandidates(candidates) {
  const idle = (c) => (c.daysSinceActivity === null || c.daysSinceActivity === undefined ? Infinity : c.daysSinceActivity);
  return [...candidates].sort((x, y) => Date.parse(x.focus.dueAt) - Date.parse(y.focus.dueAt)
    || idle(y) - idle(x)
    || x.userId.localeCompare(y.userId));
}

function modelItem(c, ref, now) {
  const a = c.focus;
  const due = Date.parse(a.dueAt);
  const overdue = a.status === 'overdue';
  const item = {
    ref,
    learner_name: c.training.learner.name,
    course: a.courseTitle,
    due_date: new Date(due).toUTCString().slice(0, 16),
    status: a.status,
    days_overdue: overdue ? Math.floor((now.getTime() - due) / DAY_MS) : 0,
    days_until_due: overdue ? 0 : Math.max(0, Math.floor((due - now.getTime()) / DAY_MS)),
    percent_complete: a.percent,
    completed_lessons: a.completedLessons,
    total_lessons: a.totalLessons,
    quiz_attempts: a.quizAttempts,
    failed_quiz_attempts: a.failedQuizAttempts,
    best_quiz_score: a.bestQuizScore,
    required_pass_score: a.requiredPassScore,
    next_step: c.nextStep,
    days_since_last_activity: c.daysSinceActivity,
    other_open_courses: c.open.length - 1,
    unread_agent_nudges: c.history.unreadNudges,
    escalation_allowed: c.escalationAllowed,
  };
  if (c.escalationAllowed) item.manager_name = c.training.learner.manager.name;
  return item;
}

// ---------------------------------------------------------------------------
// Model

async function createModel() {
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
      RoleSessionName: 'learnloop-training-follow-up',
    }));
    options.credentials = {
      accessKeyId: out.Credentials.AccessKeyId,
      secretAccessKey: out.Credentials.SecretAccessKey,
      sessionToken: out.Credentials.SessionToken,
    };
  }
  return new ChatBedrockConverse(options);
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

async function callModel(model, learners) {
  let response;
  try {
    response = await model.invoke([['system', SYSTEM_PROMPT], ['human', JSON.stringify({ learners })]]);
  } catch (error) {
    logWarn('training follow-up model call failed', { errorType: error?.name ?? 'Error' });
    return { failure: 'model_call_failed' };
  }
  if (response?.response_metadata?.stopReason === 'max_tokens') {
    logWarn('training follow-up model reply truncated', { errorType: 'MaxTokens' });
    return { failure: 'model_reply_truncated' };
  }
  const decisions = parseDecisions(textOf(response?.content));
  if (!decisions) {
    logWarn('training follow-up model reply unparseable', { errorType: 'Unparseable' });
    return { failure: 'model_reply_unparseable' };
  }
  return { decisions };
}

async function draftChunk(model, chunk, now) {
  const byRef = new Map(chunk.map((c, i) => [`L${i + 1}`, c]));
  const reply = await callModel(model, [...byRef].map(([ref, c]) => modelItem(c, ref, now)));
  if (reply.failure) return { drafts: [], failure: reply.failure };
  const drafts = [];
  const seen = new Set();
  for (const d of reply.decisions) {
    const c = byRef.get(d?.ref);
    if (!c || seen.has(d.ref) || !DECISIONS.has(d.decision)) continue;
    seen.add(d.ref);
    if (d.decision === 'wait') continue;
    if (d.decision === 'escalate' && !c.escalationAllowed) continue; // guardrail: only after two unread nudges
    let message;
    try {
      message = validateMessage({ title: d.title, body: d.body });
    } catch {
      continue;
    }
    const escalation = d.decision === 'escalate';
    drafts.push({
      id: newDraftId(),
      learner_id: c.userId,
      recipient_id: escalation ? c.training.learner.manager.userId : c.userId,
      kind: escalation ? 'escalation' : 'nudge',
      focus: FOCUSES.has(d.focus) ? d.focus : null,
      assignment_id: c.focus.id,
      course_id: c.focus.courseId,
      course_title: c.focus.courseTitle,
      due_at: c.focus.dueAt,
      title: message.title,
      body: message.body,
      status: 'pending',
      created_at: now.toISOString(),
      reviewed_by: null,
      reviewed_at: null,
      sent_at: null,
      notification_id: null,
      applied_by_agent: true,
    });
  }
  return { drafts };
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i]);
    }
  }));
  return results;
}

// ---------------------------------------------------------------------------
// The scheduled job

export async function runTrainingFollowUp(now = new Date(), { model } = {}) {
  if (!(await isEnabled(FLAG_KEY))) return finish(0, 0, 'flag_off');
  const [trainings, drafts] = await Promise.all([collectTraining(now), listAgentDrafts()]);
  const eligible = [];
  for (const training of trainings) {
    const open = openAssignments(training, now);
    if (open.length === 0) continue;
    const userId = training.learner.userId;
    const history = learnerHistory(userId, drafts, await listNotifications(userId), now);
    if (history.blocked) continue;
    eligible.push({
      userId,
      training,
      open,
      focus: open[0],
      history,
      escalationAllowed: history.escalationPossible && Boolean(training.learner.manager),
      daysSinceActivity: await daysSinceLastActivity(userId, now),
    });
  }
  if (eligible.length === 0) return finish(0, 0, 'no_candidates');

  const today = now.toISOString().slice(0, 10);
  const usedToday = drafts.filter((d) => d.created_at?.slice(0, 10) === today).length;
  const room = Math.min(MAX_LEARNERS_PER_RUN, DAILY_DRAFT_CAP - usedToday);
  if (room <= 0) return finish(0, eligible.length, 'daily_cap');

  const chosen = rankCandidates(eligible).slice(0, room);
  for (const c of chosen) {
    const progress = await getCourseProgress(c.userId, c.focus.courseId);
    c.nextStep = progress?.nextLesson?.title ?? 'Retake the course quiz';
  }
  const chunks = [];
  for (let i = 0; i < chosen.length; i += MODEL_BATCH_SIZE) chunks.push(chosen.slice(i, i + MODEL_BATCH_SIZE));

  let llm = model;
  if (!llm) {
    try {
      llm = await createModel();
    } catch (error) {
      logWarn('training follow-up model setup failed', { errorType: error?.name ?? 'Error' });
      return finish(0, eligible.length, 'model_call_failed');
    }
  }
  const results = await mapPool(chunks, MODEL_CONCURRENCY, (chunk) => draftChunk(llm, chunk, now));
  const created = results.flatMap((r) => r.drafts);
  await insertDrafts(created);
  const failure = FAILURE_ORDER.find((f) => results.some((r) => r.failure === f));
  return finish(created.length, eligible.length, failure ?? 'completed');
}

// ---------------------------------------------------------------------------
// Staff review queue (staff-only routes)

function toPublicDraft(d, names = new Map()) {
  return {
    id: d.id,
    kind: d.kind,
    focus: d.focus,
    learnerId: d.learner_id,
    learnerName: names.get(d.learner_id) ?? null,
    recipientId: d.recipient_id,
    recipientName: names.get(d.recipient_id) ?? null,
    courseTitle: d.course_title,
    dueAt: d.due_at,
    title: d.title,
    body: d.body,
    status: d.status,
    createdAt: d.created_at,
    sentAt: d.sent_at,
    appliedByAgent: d.applied_by_agent === true,
  };
}

async function listDrafts() {
  await requireAgentFlag();
  const pending = (await listAgentDrafts()).filter((d) => d.status === 'pending' && d.applied_by_agent === true)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const ids = [...new Set(pending.flatMap((d) => [d.learner_id, d.recipient_id]))];
  const names = new Map(await Promise.all(ids.map(async (id) => [id, (await findUserById(id))?.name ?? null])));
  return ok({ drafts: pending.map((d) => toPublicDraft(d, names)) });
}

async function approveDraft({ user, params, body, now }) {
  await requireAgentFlag();
  const drafts = await listAgentDrafts();
  const draft = drafts.find((d) => d.id === params.draftId);
  if (!draft) throw notFound('draft_not_found');
  if (draft.status !== 'pending') throw conflict('draft_not_pending');
  const message = validateMessage({ title: body.title ?? draft.title, body: body.body ?? draft.body });
  const recent = drafts.some((d) => d.learner_id === draft.learner_id && d.status === 'sent' && d.sent_at
    && now.getTime() - Date.parse(d.sent_at) < MIN_DAYS_BETWEEN_MESSAGES * DAY_MS);
  if (recent) throw conflict('recently_messaged');
  const claimed = await updateDraft(draft.id, (d) => {
    if (d.status !== 'pending') return false;
    d.status = 'sending';
    return true;
  });
  if (!claimed) throw conflict('draft_not_pending');
  let result;
  try {
    result = await sendStaffMessage(user.userId, draft.recipient_id, message, now);
  } catch (error) {
    await updateDraft(draft.id, (d) => { d.status = 'failed'; d.reviewed_by = user.userId; d.reviewed_at = now.toISOString(); });
    throw error;
  }
  const sent = await updateDraft(draft.id, (d) => {
    Object.assign(d, {
      status: 'sent',
      edited: message.title !== draft.title || message.body !== draft.body,
      title: message.title,
      body: message.body,
      reviewed_by: user.userId,
      reviewed_at: now.toISOString(),
      sent_at: now.toISOString(),
      notification_id: result.notificationId,
      email: result.email,
    });
  });
  return ok({ draft: toPublicDraft(sent), email: result.email });
}

async function rejectDraft({ user, params, now }) {
  await requireAgentFlag();
  const updated = await updateDraft(params.draftId, (d) => {
    if (d.status !== 'pending') return false;
    Object.assign(d, { status: 'rejected', reviewed_by: user.userId, reviewed_at: now.toISOString() });
  });
  if (!updated) throw notFound('draft_not_found');
  return ok({ draft: toPublicDraft(updated) });
}

export const agentRoutes = [
  { method: 'GET', path: '/api/admin/agent-drafts', auth: 'staff', handler: listDrafts },
  { method: 'POST', path: '/api/admin/agent-drafts/{draftId}/approve', auth: 'staff', handler: approveDraft },
  { method: 'POST', path: '/api/admin/agent-drafts/{draftId}/reject', auth: 'staff', handler: rejectDraft },
];
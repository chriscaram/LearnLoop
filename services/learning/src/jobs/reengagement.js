// Daily re-engagement nudge job (finding find_a431764685ac).
//
// The scheduler invokes the learning function with { "job": "reengagement_nudges" };
// handler.js routes that here, the same way billing routes renew_subscriptions.
// Logs go through the shared logger with actor_type "system" and the learner as
// user.id, like the renewal job.
//
// Division of labour: this file does every calculation, read and guardrail with
// the existing deterministic code (progress.js, enrolments.js, inbox.js,
// email.js). The model only decides nudge/skip, picks one course and drafts the
// words - see src/agents/reengagementAgent.js.
import { isEnabled } from '@learnloop/shared/flags';
import { getLogContext, logEvent, logWarn, runWithLogContext } from '@learnloop/shared/logger';
import { createNotification, listNotifications } from '@learnloop/notifications/services/inbox';
import { sendEmail } from '@learnloop/notifications/services/email';
import { daysSinceLastActivity, listProgressOverview } from '../services/progress.js';
import { listLearners } from '../repositories/learners.js';

export const REENGAGEMENT_NUDGE_JOB = 'reengagement_nudges';

/** Kill switch: the whole job is dark until this flag is switched on. */
export const AGENT_FLAG_KEY = 'ga-find_a431764685ac';

/** Guardrails (deterministic, checked before the agent is called). */
export const MIN_STALL_DAYS = 7;
export const NUDGE_COOLDOWN_DAYS = 14;
export const DAILY_SEND_CAP = 50;

const DAY_MS = 86_400_000;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const NUMBER_RE = /\b\d+(?:[.,]\d+)?%?/g;

/** Courses the learner started and has not finished. Zero progress is never nudged. */
export function eligibleCourses(overview) {
  return overview.filter((c) => c.lastLesson && c.nextLesson && c.percent < 100 && c.lastActivityAt);
}

/** Only the deterministic facts the model is allowed to see. */
export function courseFact(course) {
  return {
    courseId: course.courseId,
    courseTitle: course.courseTitle,
    percent: course.percent,
    completedLessons: course.completedLessons,
    totalLessons: course.totalLessons,
    lessonsRemaining: course.totalLessons - course.completedLessons,
    nextLessonTitle: course.nextLesson.title,
    lastLessonTitle: course.lastLesson.title,
    lastActivityAt: course.lastActivityAt,
  };
}

/** Drops any URL and any number the model wrote: numbers come from the code only. */
export function sanitizeModelText(value, max) {
  return String(value ?? '')
    .replace(URL_RE, ' ')
    .replace(NUMBER_RE, ' ')
    .replace(/[\r\n]{2,}/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

/** Model wording plus the deterministic percent, lesson counts, lesson title and link. */
export function composeMessage(course, draft) {
  const title = sanitizeModelText(draft?.subject, 120) || `Pick up ${course.courseTitle} where you left off`;
  const intro = sanitizeModelText(draft?.body, 1200);
  const facts = `You are ${course.percent}% through ${course.courseTitle} (${course.completedLessons} of ${course.totalLessons} lessons). Next up: ${course.nextLesson.title}.`;
  return {
    title,
    body: intro ? `${intro}\n\n${facts}` : facts,
    link: `/lessons/${course.nextLesson.id}`,
  };
}

/** Guardrail: at most one agent message per learner per NUDGE_COOLDOWN_DAYS. */
async function nudgedRecently(userId, now) {
  const items = await listNotifications(userId, { limit: 50 });
  return items.some((n) => n.applied_by_agent && now - new Date(n.created_at) < NUDGE_COOLDOWN_DAYS * DAY_MS);
}

async function loadAgent() {
  const { createReengagementAgent } = await import('../agents/reengagementAgent.js');
  return createReengagementAgent();
}

/** One learner: ask the agent, then send through the existing inbox + email path. */
async function nudgeLearner(agent, learner, courses, stallDays, now) {
  const facts = { daysSinceLastActivity: stallDays, courses: courses.map(courseFact) };
  let draft;
  try {
    draft = await agent.planNudge(facts);
  } catch (error) {
    logWarn('re-engagement agent call failed', { errorType: error?.name ?? 'Error' });
    return false;
  }
  if (!draft || draft.action !== 'nudge') return false;
  const course = courses.find((c) => c.courseId === draft.courseId);
  if (!course) {
    logWarn('re-engagement agent chose a course outside the candidate list', { errorType: 'InvalidChoice' });
    return false;
  }
  const { title, body, link } = composeMessage(course, draft);
  const notification = await createNotification(
    learner.id,
    { type: 'staff_message', title, body, link, appliedByAgent: true },
    now,
  );
  logEvent({ event: 'staff_message_sent', entityType: 'notification', entityId: notification.id, actorType: 'system' });
  await sendEmail({
    to: learner.email,
    template: 'staff_message',
    data: { name: learner.name, title, body, staffName: 'The LearnLoop team' },
  });
  return true;
}

/**
 * Scans learners for stalled course progress and sends at most one nudge each.
 * Returns { sent, considered } - or { reason: 'flag_off' } when the flag is off,
 * in which case nothing at all happens and no model client is created.
 */
export async function runReengagementNudges(now = new Date(), { agent = null } = {}) {
  if (!(await isEnabled(AGENT_FLAG_KEY))) return { sent: 0, considered: 0, reason: 'flag_off' };

  const learners = await listLearners();
  const parent = getLogContext() ?? {};
  let planner = agent;
  let sent = 0;
  let considered = 0;

  for (const learner of learners) {
    if (sent >= DAILY_SEND_CAP) break;
    const courses = eligibleCourses(await listProgressOverview(learner.id));
    if (courses.length === 0) continue;
    const stallDays = await daysSinceLastActivity(learner.id, now);
    if (stallDays === null || stallDays < MIN_STALL_DAYS) continue;
    if (await nudgedRecently(learner.id, now)) continue;
    considered += 1;
    planner ??= await loadAgent();
    const ctx = { ...parent, userId: learner.id, sessionId: undefined, role: 'system' };
    if (await runWithLogContext(ctx, () => nudgeLearner(planner, learner, courses, stallDays, now))) sent += 1;
  }

  return { sent, considered };
}
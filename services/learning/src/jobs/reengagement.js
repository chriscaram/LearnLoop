// Daily learner re-engagement job (agent). Registered in the learning
// service's jobs map as "reengagement_nudges" and invoked once a day at
// 09:00 UTC with { "job": "reengagement_nudges" } — the same scheduled-job
// path billing's renewal job uses (packages/shared/src/http.js, createHandler).
//
// Everything here is gated on the feature flag "ga-find_a431764685ac": with
// the flag absent or off the job does nothing at all. Guardrails (stall
// threshold, one message per learner per 14 days, one course per message,
// enrolment and started-progress requirement, global daily cap) are checked in
// this file before the agent is consulted. The agent may only create a
// notification and send an email; it never writes progress, enrolment,
// subscription or billing data.
import { isEnabled } from '@learnloop/shared/flags';
import { getLogContext, logEvent, logWarn, runWithLogContext } from '@learnloop/shared/logger';
import { createNotification, listNotifications } from '@learnloop/notifications/services/inbox';
import { sendEmail } from '@learnloop/notifications/services/email';
import { listEnrolledCourseIds } from '../repositories/enrolments.js';
import { listLearners } from '../repositories/learners.js';
import { daysSinceLastActivity, listProgressOverview, nextLessonFor } from '../services/progress.js';
import { createNudgeAgent, sanitiseDraft } from '../agents/reengagement.js';

export const REENGAGEMENT_JOB = 'reengagement_nudges';
export const REENGAGEMENT_FLAG = 'ga-find_a431764685ac';
/** Whole days without lesson activity before a learner counts as stalled. */
export const MIN_STALL_DAYS = 7;
/** At most one agent message per learner in this window. */
export const NUDGE_COOLDOWN_DAYS = 14;
/** Upper bound on messages one run may send. */
export const DAILY_SEND_CAP = 50;

const DAY_MS = 86_400_000;
const SENDER_NAME = 'The LearnLoop team';

/** Started-but-unfinished enrolled courses with a known next lesson. */
export function eligibleCourses(overview, enrolledCourseIds) {
  const enrolled = new Set(enrolledCourseIds);
  return overview.filter((c) => enrolled.has(c.courseId)
    && c.completedLessons > 0
    && c.percent > 0
    && c.percent < 100
    && c.nextLesson);
}

/** True when this learner already got an agent message inside the cooldown. */
export function recentlyNudged(notifications, now = new Date()) {
  return notifications.some((n) => n.applied_by_agent === true
    && now - new Date(n.created_at) < NUDGE_COOLDOWN_DAYS * DAY_MS);
}

function courseFacts(course) {
  return {
    courseId: course.courseId,
    courseTitle: course.courseTitle,
    percent: course.percent,
    completedLessons: course.completedLessons,
    totalLessons: course.totalLessons,
    lessonsRemaining: Math.max(0, course.totalLessons - course.completedLessons),
    nextLessonTitle: course.nextLesson.title,
    lastLessonTitle: course.lastLesson?.title ?? null,
    lastActivityAt: course.lastActivityAt,
  };
}

/** Nudges one learner if every guardrail allows it. Returns true when a message was sent. */
async function nudgeLearner(learner, agent, now) {
  const enrolledCourseIds = await listEnrolledCourseIds(learner.id);
  if (enrolledCourseIds.length === 0) return false;

  const days = await daysSinceLastActivity(learner.id, now);
  if (days === null || days < MIN_STALL_DAYS) return false;

  const candidates = eligibleCourses(await listProgressOverview(learner.id), enrolledCourseIds);
  if (candidates.length === 0) return false;

  if (recentlyNudged(await listNotifications(learner.id), now)) return false;

  const decision = await agent.decide({
    daysSinceLastActivity: days,
    priorAgentNudges: 0,
    courses: candidates.map(courseFacts),
  });
  const chosen = candidates.find((c) => c.courseId === decision?.courseId);
  if (!decision?.nudge || !chosen) return false;

  // Re-read the exact next lesson from the deterministic code; it, the course
  // title and the percent are the only facts that reach the learner.
  const next = await nextLessonFor(learner.id, chosen.courseId);
  if (!next) return false;

  const draft = sanitiseDraft(await agent.draft({
    daysSinceLastActivity: days,
    courseTitle: chosen.courseTitle,
    percent: chosen.percent,
    lessonsRemaining: Math.max(0, chosen.totalLessons - chosen.completedLessons),
    nextLessonTitle: next.title,
  }));
  const link = `/lessons/${next.id}`;
  const body = `${draft.body}\n\nYou are ${chosen.percent}% through "${chosen.courseTitle}". Your next lesson is "${next.title}".`;

  const notification = await createNotification(learner.id, {
    type: 'staff_message',
    title: draft.subject,
    body,
    link,
    appliedByAgent: true,
  }, now);
  logEvent({ event: 'staff_message_sent', entityType: 'notification', entityId: notification.id, actorType: 'system' });

  const email = await sendEmail({
    to: learner.email,
    template: 'staff_message',
    data: { name: learner.name, title: draft.subject, body, staffName: SENDER_NAME },
  });
  if (!email.ok) logWarn('re-engagement email could not be sent', { errorType: email.errorType });
  return true;
}

/**
 * Scans learners and sends at most one nudge each, up to `cap` per run.
 * Returns { enabled, considered, sent }.
 */
export async function runReengagementNudges(now = new Date(), { agent, cap = DAILY_SEND_CAP } = {}) {
  if (!(await isEnabled(REENGAGEMENT_FLAG))) return { enabled: false, considered: 0, sent: 0 };

  const learners = await listLearners();
  const worker = agent ?? createNudgeAgent();
  const parent = getLogContext() ?? {};
  let sent = 0;

  for (const learner of learners) {
    if (sent >= cap) break;
    const ctx = { ...parent, userId: learner.id, sessionId: undefined, role: 'system' };
    const nudged = await runWithLogContext(ctx, async () => {
      try {
        return await nudgeLearner(learner, worker, now);
      } catch (error) {
        logWarn('re-engagement nudge skipped after an error', { errorType: error?.name ?? 'Error' });
        return false;
      }
    });
    if (nudged) sent += 1;
  }

  return { enabled: true, considered: learners.length, sent };
}
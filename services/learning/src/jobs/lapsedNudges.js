// Daily lapsed-learner nudge job. EventBridge invokes the learning function
// with { "job": "nudge_lapsed_learners" }; handler.js routes that here, the
// same way billing routes its renewals job. Everything is off unless the
// feature flag ga-find_137394cd3691 is enabled.
//
// All facts are read through the existing deterministic code: enrolments,
// daysSinceLastActivity (inactivity) and listProgressOverview (percent
// complete, lesson counts, exact next lesson). The model only decides whom to
// nudge among the qualified candidates and drafts the wording.
import { isEnabled } from '@learnloop/shared/flags';
import { getLogContext, logEvent, runWithLogContext } from '@learnloop/shared/logger';
import { createNotification, listNotifications } from '@learnloop/notifications/services/inbox';
import { sendEmail } from '@learnloop/notifications/services/email';
import { listEnrolledCourseIds } from '../repositories/enrolments.js';
import { listLearnerUsers, markNotificationAppliedByAgent } from '../repositories/nudges.js';
import { daysSinceLastActivity, listProgressOverview } from '../services/progress.js';
import { planNudges } from '../agents/lapsedNudge.js';

export const LAPSED_NUDGE_JOB = 'nudge_lapsed_learners';
export const NUDGE_FLAG_KEY = 'ga-find_137394cd3691';

/** Guardrails, all enforced in code before the agent acts. */
export const INACTIVE_DAYS = 14;
export const COOLDOWN_DAYS = 14;
export const DAILY_NUDGE_CAP = 20;
export const MAX_LEARNERS_SCANNED = 200;
export const MAX_CANDIDATES = 25;

const DAY_MS = 86_400_000;

/** The deterministic code the agent is allowed to use; tests inject wrappers. */
export const defaultDeps = Object.freeze({
  listLearnerUsers,
  listEnrolledCourseIds,
  daysSinceLastActivity,
  listProgressOverview,
  listNotifications,
  createNotification,
  markNotificationAppliedByAgent,
  sendEmail,
});

const daysBetween = (iso, now) => (now - new Date(iso)) / DAY_MS;
const sameUtcDay = (iso, now) => String(iso).slice(0, 10) === now.toISOString().slice(0, 10);

function priorAgentNudges(notifications) {
  return notifications.filter((n) => n.applied_by_agent === true);
}

/** Courses the learner is mid-way through: active once, not finished, a next lesson left. */
function openCourses(overview) {
  return overview.filter((c) => c.lastActivityAt && c.nextLesson && c.percent < 100);
}

/** Only facts computed by the platform ever reach the model. No name, no email. */
function toModelFacts(candidate) {
  return {
    userId: candidate.userId,
    daysInactive: candidate.daysInactive,
    priorNudges: candidate.priorNudges,
    courses: candidate.courses.map((c) => ({
      courseId: c.courseId,
      courseTitle: c.courseTitle,
      percentComplete: c.percent,
      completedLessons: c.completedLessons,
      totalLessons: c.totalLessons,
      lastLessonTitle: c.lastLessonTitle,
      nextLessonTitle: c.nextLessonTitle,
      lastActivityAt: c.lastActivityAt,
    })),
  };
}

/**
 * Qualified candidates, most at risk first: longest stall, then closest to
 * finishing. Also returns how many nudges the agent already sent today.
 */
export async function collectCandidates(now, deps = defaultDeps, { maxCandidates = MAX_CANDIDATES } = {}) {
  const learners = (await deps.listLearnerUsers()).slice(0, MAX_LEARNERS_SCANNED);
  const candidates = [];
  let sentToday = 0;

  for (const user of learners) {
    const courseIds = await deps.listEnrolledCourseIds(user.id);
    if (courseIds.length === 0) continue;

    const daysInactive = await deps.daysSinceLastActivity(user.id, now);
    if (daysInactive === null || daysInactive < INACTIVE_DAYS) continue;

    const notifications = await deps.listNotifications(user.id);
    const prior = priorAgentNudges(notifications);
    sentToday += prior.filter((n) => sameUtcDay(n.created_at, now)).length;
    if (prior.some((n) => daysBetween(n.created_at, now) < COOLDOWN_DAYS)) continue;

    const open = openCourses(await deps.listProgressOverview(user.id));
    if (open.length === 0) continue;

    candidates.push({
      userId: user.id,
      name: user.name,
      email: user.email,
      daysInactive,
      priorNudges: prior.length,
      courses: open.map((c) => ({
        courseId: c.courseId,
        courseTitle: c.courseTitle,
        percent: c.percent,
        completedLessons: c.completedLessons,
        totalLessons: c.totalLessons,
        lastLessonTitle: c.lastLesson?.title ?? null,
        nextLessonId: c.nextLesson.id,
        nextLessonTitle: c.nextLesson.title,
        lastActivityAt: c.lastActivityAt,
      })),
    });
  }

  const bestPercent = (c) => Math.max(...c.courses.map((x) => x.percent));
  candidates.sort((a, b) => b.daysInactive - a.daysInactive
    || bestPercent(b) - bestPercent(a)
    || a.userId.localeCompare(b.userId));

  return { candidates: candidates.slice(0, maxCandidates), sentToday };
}

async function deliver(candidate, course, nudge, now, deps) {
  const notification = await deps.createNotification(candidate.userId, {
    type: 'staff_message',
    title: nudge.subject,
    body: nudge.body,
    link: `/lessons/${course.nextLessonId}`,
  }, now);
  await deps.markNotificationAppliedByAgent(notification.id);
  logEvent({
    event: 'staff_message_sent',
    entityType: 'notification',
    entityId: notification.id,
    actorType: 'system',
    value: candidate.daysInactive,
  });
  const email = await deps.sendEmail({
    to: candidate.email,
    template: 'staff_message',
    data: {
      name: candidate.name,
      title: nudge.subject,
      body: nudge.body,
      staffName: 'The LearnLoop team',
    },
  });
  return { notificationId: notification.id, email: email.ok ? 'sent' : 'failed' };
}

/**
 * Nudges lapsed learners once per cooldown window. Returns a small summary.
 * Does nothing at all while the feature flag is off.
 */
export async function runLapsedLearnerNudges(now = new Date(), options = {}) {
  const {
    model,
    deps = defaultDeps,
    dailyCap = DAILY_NUDGE_CAP,
    maxCandidates = MAX_CANDIDATES,
  } = options;

  if (!(await isEnabled(NUDGE_FLAG_KEY))) return { sent: 0, candidates: 0, reason: 'flag_off' };

  const { candidates, sentToday } = await collectCandidates(now, deps, { maxCandidates });
  const budget = Math.max(0, dailyCap - sentToday);
  if (candidates.length === 0) return { sent: 0, candidates: 0, reason: 'no_candidates' };
  if (budget === 0) return { sent: 0, candidates: candidates.length, reason: 'daily_cap' };

  const nudges = await planNudges(candidates.map(toModelFacts), { model });
  const byUser = new Map(candidates.map((c) => [c.userId, c]));
  const parent = getLogContext() ?? {};
  let sent = 0;

  for (const nudge of nudges) {
    if (sent >= budget) break;
    const candidate = byUser.get(nudge.userId);
    const course = candidate?.courses.find((c) => c.courseId === nudge.courseId);
    if (!candidate || !course) continue;
    const ctx = { ...parent, userId: candidate.userId, sessionId: undefined, role: 'system' };
    await runWithLogContext(ctx, () => deliver(candidate, course, nudge, now, deps));
    sent += 1;
  }

  return { sent, candidates: candidates.length };
}
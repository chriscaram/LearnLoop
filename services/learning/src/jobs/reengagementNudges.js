/**
 * Scheduled job: re-engagement nudges for stalled learners.
 * Finding find_a431764685ac (NBF-USAGE-ACTOR_INACTIVITY). Flag: ga-find_a431764685ac
 *
 * Pattern copied from services/billing/src/jobs/renewals.js (batch loop with
 * per-user log context). Registered via the exported `jobs` map for the shared
 * handler's scheduled-job path (event.job), and additionally runnable by the
 * minimal in-process scheduler below.
 *
 * All facts come from existing deterministic code:
 *   services/learning/src/services/progress.js  - completionPercent, nextLessonFor,
 *                                                 daysSinceLastActivity, listProgressOverview
 *   services/learning/src/repositories/enrolments.js - listEnrolledCourseIds
 * All delivery goes through existing code:
 *   services/notifications/src/services/inbox.js - createNotification
 *   services/notifications/src/services/email.js - sendEmail
 *
 * The agent may ONLY create a notification and send an email. It never writes
 * progress, enrolment, subscription or billing records.
 */

import { createNudgeModel, decideNudge, draftNudgeMessage, composeMessage } from '../agents/reengagementAgent.js';

export const FLAG_KEY = 'ga-find_a431764685ac';
export const JOB_NAME = 'reengagement-nudges';

/* ------------------------------ guardrails ------------------------------ */

export const GUARDRAILS = {
  // At most one re-engagement message per learner per 14 days.
  cooldownDays: 14,
  // Only learners who look genuinely stalled.
  minStallDays: 7,
  // Never nudge a finished course or one with zero progress.
  minPercent: 1,
  maxPercent: 99,
  // Global cap per run / per day.
  maxSendsPerRun: 50,
  // Never more than one course per message.
  maxCoursesPerMessage: 1
};

const NUDGE_TAG = 'reengagement_nudge';
const NOTIFICATION_TYPE = process.env.NUDGE_NOTIFICATION_TYPE || 'message';

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  const n = Number.parseInt(raw == null ? '' : raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/* ------------------------------ flag read ------------------------------- */

function envFlagOn() {
  const direct = process.env.GA_FIND_A431764685AC;
  if (direct != null) return /^(1|true|on|yes)$/i.test(String(direct).trim());
  const bag = process.env.FEATURE_FLAGS;
  if (bag) {
    try {
      const parsed = JSON.parse(bag);
      if (parsed && Object.prototype.hasOwnProperty.call(parsed, FLAG_KEY)) {
        return parsed[FLAG_KEY] === true || /^(1|true|on|yes)$/i.test(String(parsed[FLAG_KEY]));
      }
    } catch {
      /* ignore malformed bag; treated as off */
    }
  }
  return false;
}

/** Runtime feature-flag read. Absent or off => the job does nothing. */
export async function isAgentEnabled(flagClient) {
  try {
    const client = flagClient || (await import('@learnloop/shared/src/flags.js').catch(() => null));
    if (client) {
      const fn =
        client.isEnabled ||
        client.isFlagEnabled ||
        client.getFlag ||
        client.flagEnabled ||
        (client.default && (client.default.isEnabled || client.default.getFlag));
      if (typeof fn === 'function') {
        const value = await fn(FLAG_KEY);
        if (value != null) return value === true || /^(1|true|on|yes)$/i.test(String(value));
      }
    }
  } catch {
    /* fall through to env read */
  }
  return envFlagOn();
}

/* ------------------------------ deps ------------------------------------ */

async function resolveDeps(partial) {
  const deps = { ...(partial || {}) };
  if (!deps.listProgressOverview || !deps.completionPercent || !deps.nextLessonFor || !deps.daysSinceLastActivity) {
    const progress = await import('../services/progress.js');
    deps.listProgressOverview = deps.listProgressOverview || progress.listProgressOverview;
    deps.completionPercent = deps.completionPercent || progress.completionPercent;
    deps.nextLessonFor = deps.nextLessonFor || progress.nextLessonFor;
    deps.daysSinceLastActivity = deps.daysSinceLastActivity || progress.daysSinceLastActivity;
  }
  if (!deps.listEnrolledCourseIds) {
    const enrolments = await import('../repositories/enrolments.js');
    deps.listEnrolledCourseIds = enrolments.listEnrolledCourseIds;
  }
  if (!deps.createNotification) {
    const inbox = await import('../../../notifications/src/services/inbox.js');
    deps.createNotification = inbox.createNotification;
  }
  if (!deps.sendEmail) {
    const email = await import('../../../notifications/src/services/email.js');
    deps.sendEmail = email.sendEmail;
  }
  if (!deps.listNotifications) {
    const repo = await import('../../../notifications/src/repositories/notifications.js').catch(() => null);
    deps.listNotifications =
      (repo && (repo.listNotifications || repo.listForUser || repo.list)) || (async () => []);
  }
  return deps;
}

/* ------------------------------ helpers --------------------------------- */

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pick(obj, names) {
  for (const name of names) {
    if (obj && obj[name] != null) return obj[name];
  }
  return undefined;
}

function lessonTitle(lesson) {
  if (!lesson) return null;
  if (typeof lesson === 'string') return lesson;
  return pick(lesson, ['title', 'name', 'lessonTitle']) || null;
}

function lessonId(lesson) {
  if (!lesson) return null;
  if (typeof lesson === 'string') return lesson;
  return pick(lesson, ['id', 'lessonId', 'lesson_id']) || null;
}

/**
 * Deterministic eligibility. Everything here is computed by existing code.
 */
export async function eligibleCourses({ learner, deps, now }) {
  const learnerId = pick(learner, ['id', 'userId', 'user_id']);
  const enrolledIds = (await deps.listEnrolledCourseIds(learnerId)) || [];
  const enrolled = new Set(enrolledIds.map((id) => String(pick(id, ['courseId', 'id']) || id)));
  if (enrolled.size === 0) return [];

  const overview = (await deps.listProgressOverview(learnerId)) || [];
  const out = [];

  for (const row of overview) {
    const courseId = String(pick(row, ['courseId', 'course_id', 'id']) || '');
    if (!courseId || !enrolled.has(courseId)) continue;

    const course = pick(row, ['course']) || row;
    const courseTitle = pick(row, ['courseTitle', 'title']) || pick(course, ['title', 'name']);

    let percent = num(pick(row, ['percentComplete', 'percent', 'completionPercent']));
    if (percent == null && typeof deps.completionPercent === 'function') {
      percent = num(await deps.completionPercent(learnerId, courseId));
    }
    if (percent == null) continue;
    if (percent < GUARDRAILS.minPercent || percent > GUARDRAILS.maxPercent) continue;

    const lessonsCompleted = num(pick(row, ['lessonsCompleted', 'completedLessons', 'completed'])) || 0;
    const lessonsTotal = num(pick(row, ['lessonsTotal', 'totalLessons', 'total'])) || 0;
    if (lessonsCompleted < 1) continue; // never a learner with zero progress

    let days = num(pick(row, ['daysSinceLastActivity']));
    if (days == null && typeof deps.daysSinceLastActivity === 'function') {
      days = num(await deps.daysSinceLastActivity(learnerId, courseId, now));
    }
    if (days == null || days < GUARDRAILS.minStallDays) continue;

    let next = pick(row, ['nextLesson']);
    if (!next && typeof deps.nextLessonFor === 'function') {
      next = await deps.nextLessonFor(learnerId, courseId);
    }
    const title = lessonTitle(next);
    if (!title) continue; // nothing left to point at

    const id = lessonId(next);
    out.push({
      courseId,
      courseTitle: String(courseTitle || courseId),
      percentComplete: Math.round(percent),
      lessonsCompleted,
      lessonsTotal,
      lessonsRemaining: Math.max(0, lessonsTotal - lessonsCompleted),
      daysSinceLastActivity: Math.round(days),
      nextLessonId: id,
      nextLessonTitle: String(title),
      nextLessonUrl: id ? `/lessons/${id}` : null
    });
  }

  // Deterministic fallback order: closest to completion, then longest stalled.
  out.sort((a, b) => b.percentComplete - a.percentComplete || b.daysSinceLastActivity - a.daysSinceLastActivity);
  return out;
}

/** 14-day per-learner cooldown, derived from notifications already sent. */
export async function daysSinceLastNudge({ learnerId, deps, now }) {
  const existing = (await deps.listNotifications(learnerId)) || [];
  let newest = null;
  for (const n of existing) {
    const meta = n && (n.metadata || n.meta || {});
    const tagged =
      (meta && (meta.agent === NUDGE_TAG || meta.tag === NUDGE_TAG || meta.applied_by_agent === true)) ||
      n.applied_by_agent === true ||
      n.tag === NUDGE_TAG;
    if (!tagged) continue;
    const at = new Date(pick(n, ['createdAt', 'created_at', 'sentAt', 'at']) || 0).getTime();
    if (Number.isFinite(at) && (newest == null || at > newest)) newest = at;
  }
  if (newest == null) return null;
  return Math.floor((now.getTime() - newest) / 86400000);
}

/* ------------------------------ the job --------------------------------- */

export async function runReengagementNudges(options = {}) {
  const logger = options.logger || console;
  const now = options.now ? new Date(options.now) : new Date();
  const result = { enabled: false, considered: 0, skipped: 0, sent: 0, errors: 0 };

  if (!(await isAgentEnabled(options.flagClient))) {
    logger.info ? logger.info({ job: JOB_NAME, flag: FLAG_KEY, enabled: false }) : null;
    return result; // flag absent or off: existing behaviour unchanged
  }
  result.enabled = true;

  const deps = await resolveDeps(options.deps);
  const learners = (await (options.listLearners || deps.listLearners || (async () => []))()) || [];
  const cap = Math.min(intFromEnv('NUDGE_MAX_PER_RUN', GUARDRAILS.maxSendsPerRun), GUARDRAILS.maxSendsPerRun);

  let model = options.model || null;

  for (const learner of learners) {
    if (result.sent >= cap) break; // global daily send cap
    const learnerId = pick(learner, ['id', 'userId', 'user_id']);
    if (!learnerId) continue;
    result.considered += 1;

    try {
      const candidates = await eligibleCourses({ learner, deps, now });
      if (candidates.length === 0) {
        result.skipped += 1;
        continue;
      }

      const sinceNudge = await daysSinceLastNudge({ learnerId, deps, now });
      if (sinceNudge != null && sinceNudge < GUARDRAILS.cooldownDays) {
        result.skipped += 1;
        continue;
      }

      if (!model) model = await createNudgeModel();

      const decision = await decideNudge({ model, candidates, daysSinceLastNudge: sinceNudge });
      if (!decision.nudge) {
        result.skipped += 1;
        continue;
      }

      // The model may only pick from the deterministic set; one course only.
      const chosen =
        candidates.find((c) => c.courseId === decision.courseId) ||
        candidates.slice(0, GUARDRAILS.maxCoursesPerMessage)[0];

      const drafted = await draftNudgeMessage({
        model,
        course: chosen,
        learnerName: pick(learner, ['firstName', 'givenName', 'name'])
      });
      const message = composeMessage({ drafted, course: chosen });

      await deps.createNotification({
        userId: learnerId,
        type: NOTIFICATION_TYPE,
        title: message.subject,
        body: message.body,
        applied_by_agent: true,
        metadata: {
          applied_by_agent: true,
          agent: NUDGE_TAG,
          flag_key: FLAG_KEY,
          finding_id: 'find_a431764685ac',
          course_id: chosen.courseId,
          percent_complete: chosen.percentComplete,
          next_lesson_id: chosen.nextLessonId
        }
      });

      const email = pick(learner, ['email', 'emailAddress']);
      if (email) {
        try {
          await deps.sendEmail({
            to: email,
            subject: message.subject,
            body: message.body,
            text: message.body,
            type: NUDGE_TAG,
            applied_by_agent: true,
            metadata: { applied_by_agent: true, agent: NUDGE_TAG, course_id: chosen.courseId }
          });
        } catch (err) {
          result.errors += 1;
          logger.warn
            ? logger.warn({ job: JOB_NAME, userId: learnerId, event: 'email_failed', error: String(err && err.message) })
            : null;
        }
      }

      result.sent += 1;
      logger.info
        ? logger.info({
            job: JOB_NAME,
            userId: learnerId,
            courseId: chosen.courseId,
            percentComplete: chosen.percentComplete,
            daysSinceLastActivity: chosen.daysSinceLastActivity,
            event: 'reengagement_nudge_sent',
            applied_by_agent: true
          })
        : null;
    } catch (err) {
      result.errors += 1;
      logger.error
        ? logger.error({ job: JOB_NAME, userId: learnerId, error: String(err && err.message) })
        : null;
    }
  }

  logger.info ? logger.info({ job: JOB_NAME, ...result }) : null;
  return result;
}

/* ------------------------------ trigger --------------------------------- */

/** jobs map entry for the shared handler's scheduled-job path (event.job). */
export const jobs = { [JOB_NAME]: runReengagementNudges };

/**
 * Minimal in-process scheduler (no cloud scheduler): checks once per interval
 * and runs at most once per UTC day at/after the configured hour. Does nothing
 * while the flag is off.
 */
export function startReengagementScheduler(options = {}) {
  const intervalMs = options.intervalMs || 15 * 60 * 1000;
  const hourUtc = options.hourUtc == null ? 9 : options.hourUtc;
  let lastRunDay = null;
  let running = false;

  const tick = async () => {
    if (running) return;
    const now = options.now ? new Date(options.now()) : new Date();
    const day = now.toISOString().slice(0, 10);
    if (lastRunDay === day || now.getUTCHours() < hourUtc) return;
    running = true;
    lastRunDay = day;
    try {
      await runReengagementNudges({ ...options, now });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return { stop: () => clearInterval(timer), tick };
}

export default { jobs, runReengagementNudges, startReengagementScheduler, FLAG_KEY, JOB_NAME };
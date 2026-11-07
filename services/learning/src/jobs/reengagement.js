'use strict';

/**
 * Daily scheduled job for finding find_a431764685ac (stalled learners).
 *
 * Registered in the learning service jobs map (see src/handler.js) and invoked
 * by the shared handler's scheduled-job path (packages/shared/src/http.js,
 * createHandler -> event.job), the same pattern as
 * services/billing/src/jobs/renewals.js (renewDueSubscriptions).
 *
 * Schedule: 0 9 * * * (daily, 09:00 UTC).
 *
 * All guardrails below are deterministic and evaluated BEFORE the agent acts.
 * The whole job is gated on the runtime feature flag "ga-find_a431764685ac":
 * when the flag is absent or off the job does nothing at all.
 */

const { planNudge } = require('../agents/reengagementAgent');

const FLAG_KEY = 'ga-find_a431764685ac';

const GUARDRAILS = {
  flagKey: FLAG_KEY,
  minStallDays: 7,
  minPercentComplete: 1,
  maxPercentComplete: 99,
  nudgeCooldownDays: 14,
  maxCoursesPerMessage: 1,
  dailySendCap: Number(process.env.REENGAGEMENT_DAILY_CAP || 200),
  auditSampleSize: 5
};

const NOTIFICATION_TYPE = process.env.REENGAGEMENT_NOTIFICATION_TYPE || 'message';
const DAY_MS = 24 * 60 * 60 * 1000;

function noop() {}

function defaultLogger() {
  try {
    const logger = require('@learnloop/shared/src/logger');
    if (logger && typeof logger.info === 'function') return logger;
    if (logger && typeof logger.log === 'function') {
      return { info: logger.log, warn: logger.log, error: logger.log };
    }
  } catch (err) {
    /* fall through to console */
  }
  return {
    info: (...args) => console.log(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args)
  };
}

function tryRequire(paths) {
  for (const path of paths) {
    try {
      // eslint-disable-next-line import/no-dynamic-require, global-require
      return require(path);
    } catch (err) {
      /* try the next candidate */
    }
  }
  return {};
}

function pick(moduleRef, names) {
  for (const name of names) {
    if (moduleRef && typeof moduleRef[name] === 'function') return moduleRef[name].bind(moduleRef);
  }
  return null;
}

function defaultDeps() {
  const progress = tryRequire(['../services/progress']);
  const enrolments = tryRequire(['../repositories/enrolments']);
  const inbox = tryRequire(['../../../notifications/src/services/inbox']);
  const email = tryRequire(['../../../notifications/src/services/email']);
  const notificationsRepo = tryRequire(['../../../notifications/src/repositories/notifications']);
  const learnersRepo = tryRequire(['../../../admin/src/repositories/learners']);

  return {
    listProgressOverview: pick(progress, ['listProgressOverview']),
    completionPercent: pick(progress, ['completionPercent']),
    nextLessonFor: pick(progress, ['nextLessonFor']),
    daysSinceLastActivity: pick(progress, ['daysSinceLastActivity']),
    listEnrolledCourseIds: pick(enrolments, ['listEnrolledCourseIds']),
    createNotification: pick(inbox, ['createNotification']),
    sendEmail: pick(email, ['sendEmail']),
    listNotifications: pick(notificationsRepo, [
      'listForUser',
      'listNotificationsForUser',
      'listByUser',
      'list'
    ]),
    listLearners: pick(learnersRepo, ['listLearners', 'listAll', 'list'])
  };
}

async function readFlag(deps) {
  if (typeof deps.isEnabled === 'function') {
    return Boolean(await deps.isEnabled(FLAG_KEY));
  }
  try {
    const flags = require('@learnloop/shared/src/flags');
    const read = pick(flags, ['isEnabled', 'isFlagEnabled', 'getFlag', 'enabled']);
    if (read) return Boolean(await read(FLAG_KEY));
  } catch (err) {
    /* fall back to a plain env read below */
  }
  const envName = `FLAG_${FLAG_KEY.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
  const raw = process.env[envName] || process.env[FLAG_KEY];
  return raw === 'true' || raw === '1' || raw === 'on';
}

function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function courseIdOf(row) {
  return row.courseId || row.course_id || row.id || null;
}

function titleOf(row) {
  return row.courseTitle || row.course_title || row.title || 'your course';
}

async function safeCall(fn, args, fallback) {
  if (typeof fn !== 'function') return fallback;
  try {
    const value = await fn(...args);
    return value === undefined || value === null ? fallback : value;
  } catch (err) {
    return fallback;
  }
}

/** Deterministic eligibility: enrolled, started, unfinished, stalled. */
async function eligibleCandidates({ learnerId, deps }) {
  const enrolledIds = (await safeCall(deps.listEnrolledCourseIds, [learnerId], [])) || [];
  if (!enrolledIds.length) return [];

  const overview = (await safeCall(deps.listProgressOverview, [learnerId], [])) || [];
  const candidates = [];

  for (const row of overview) {
    const courseId = courseIdOf(row);
    if (!courseId || !enrolledIds.includes(courseId)) continue;

    const percentComplete =
      asNumber(await safeCall(deps.completionPercent, [learnerId, courseId], null)) ??
      asNumber(row.percentComplete) ??
      asNumber(row.percent_complete);
    const daysSince =
      asNumber(await safeCall(deps.daysSinceLastActivity, [learnerId, courseId], null)) ??
      asNumber(row.daysSinceLastActivity) ??
      asNumber(row.days_since_last_activity);
    const nextLesson =
      (await safeCall(deps.nextLessonFor, [learnerId, courseId], null)) ||
      row.nextLesson ||
      row.next_lesson ||
      null;

    if (percentComplete === null || daysSince === null || !nextLesson) continue;
    if (percentComplete < GUARDRAILS.minPercentComplete) continue; // no progress at all
    if (percentComplete > GUARDRAILS.maxPercentComplete) continue; // already finished
    if (daysSince < GUARDRAILS.minStallDays) continue; // activity resumed recently

    candidates.push({
      courseId,
      courseTitle: titleOf(row),
      percentComplete,
      daysSinceLastActivity: daysSince,
      completedLessons: asNumber(row.completedLessons) ?? asNumber(row.completed_lessons),
      totalLessons: asNumber(row.totalLessons) ?? asNumber(row.total_lessons),
      nextLesson
    });
  }

  // Deterministic ordering: closest to completion, then longest stalled.
  candidates.sort(
    (a, b) => b.percentComplete - a.percentComplete || b.daysSinceLastActivity - a.daysSinceLastActivity
  );
  return candidates.slice(0, 10);
}

/** Guardrail: at most one agent re-engagement message per learner per 14 days. */
async function nudgedRecently({ learnerId, deps, now }) {
  const existing = (await safeCall(deps.listNotifications, [learnerId], [])) || [];
  const cutoff = now.getTime() - GUARDRAILS.nudgeCooldownDays * DAY_MS;
  return existing.some((item) => {
    if (!item) return false;
    const byAgent = item.applied_by_agent === true || item.appliedByAgent === true;
    if (!byAgent) return false;
    const stamp = Date.parse(item.createdAt || item.created_at || item.sentAt || item.sent_at || '');
    return Number.isNaN(stamp) ? true : stamp >= cutoff;
  });
}

async function resolveLearners({ deps, learners }) {
  if (Array.isArray(learners)) return learners;
  const listed = (await safeCall(deps.listLearners, [], [])) || [];
  return listed
    .map((learner) =>
      typeof learner === 'string'
        ? { id: learner }
        : { id: learner.id || learner.userId || learner.user_id, email: learner.email }
    )
    .filter((learner) => Boolean(learner.id));
}

/**
 * The job entry point. Returns a summary; never throws for a single learner.
 */
async function runReengagementNudges(options = {}) {
  const log = options.logger || defaultLogger();
  const deps = Object.assign(defaultDeps(), options.deps || {});
  const now = options.now ? new Date(options.now) : new Date();

  const enabled = await readFlag(deps);
  if (!enabled) {
    log.info('reengagement_job_skipped', { flag: FLAG_KEY, reason: 'flag_off' });
    return { flag: FLAG_KEY, enabled: false, skipped: 'flag_off', considered: 0, sent: 0, samples: [] };
  }

  const learners = await resolveLearners({ deps, learners: options.learners });
  const summary = {
    flag: FLAG_KEY,
    enabled: true,
    considered: 0,
    skipped: 0,
    sent: 0,
    failed: 0,
    capped: false,
    samples: []
  };

  for (const learner of learners) {
    if (summary.sent >= GUARDRAILS.dailySendCap) {
      summary.capped = true;
      log.warn('reengagement_daily_cap_reached', { cap: GUARDRAILS.dailySendCap });
      break;
    }

    summary.considered += 1;
    const logContext = { job: 'reengagement-nudges', userId: learner.id };

    try {
      const candidates = await eligibleCandidates({ learnerId: learner.id, deps });
      if (!candidates.length) {
        summary.skipped += 1;
        continue;
      }
      if (await nudgedRecently({ learnerId: learner.id, deps, now })) {
        summary.skipped += 1;
        log.info('reengagement_skipped_cooldown', logContext);
        continue;
      }

      const plan = await planNudge({ learner, candidates, model: options.model });
      if (plan.action !== 'nudge') {
        summary.skipped += 1;
        log.info('reengagement_skipped', Object.assign({ reason: plan.reason }, logContext));
        continue;
      }

      // Guardrail: exactly one course per message.
      const courses = [plan.candidate.courseId].slice(0, GUARDRAILS.maxCoursesPerMessage);

      if (typeof deps.createNotification === 'function') {
        await deps.createNotification({
          userId: learner.id,
          type: NOTIFICATION_TYPE,
          title: plan.message.subject,
          body: plan.message.body,
          link: plan.message.link,
          applied_by_agent: true
        });
      }

      if (typeof deps.sendEmail === 'function') {
        try {
          await deps.sendEmail({
            userId: learner.id,
            to: learner.email,
            subject: plan.message.subject,
            body: plan.message.body,
            text: plan.message.body,
            applied_by_agent: true
          });
        } catch (err) {
          log.warn('reengagement_email_failed', Object.assign({ error: err.message }, logContext));
        }
      }

      summary.sent += 1;
      if (summary.samples.length < GUARDRAILS.auditSampleSize) {
        // sample_audit: staff review a daily sample of generated nudges.
        summary.samples.push({
          userId: learner.id,
          courseId: courses[0],
          percentComplete: plan.candidate.percentComplete,
          daysSinceLastActivity: plan.candidate.daysSinceLastActivity,
          nextLesson: plan.candidate.nextLesson && plan.candidate.nextLesson.title,
          subject: plan.message.subject,
          body: plan.message.body,
          usedFallbackDraft: plan.message.usedFallbackDraft,
          applied_by_agent: true
        });
      }
      log.info('reengagement_sent', Object.assign({ courseId: courses[0] }, logContext));
    } catch (err) {
      summary.failed += 1;
      log.error('reengagement_failed', Object.assign({ error: err.message }, logContext));
    }
  }

  log.info('reengagement_job_done', {
    flag: FLAG_KEY,
    considered: summary.considered,
    sent: summary.sent,
    skipped: summary.skipped,
    failed: summary.failed
  });
  return summary;
}

const jobs = {
  'reengagement-nudges': runReengagementNudges
};

module.exports = {
  FLAG_KEY,
  GUARDRAILS,
  eligibleCandidates,
  jobs,
  noop,
  runReengagementNudges
};
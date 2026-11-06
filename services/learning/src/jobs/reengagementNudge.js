/**
 * Re-engagement nudge agent (finding find_a431764685ac, NBF-USAGE-ACTOR_INACTIVITY).
 *
 * Every number, title and eligibility fact comes from the existing deterministic code:
 *   services/learning/src/services/progress.js    completionPercent, nextLessonFor,
 *                                                 daysSinceLastActivity, listProgressOverview
 *   services/learning/src/repositories/enrolments.js  listEnrolledCourseIds
 *   services/notifications/src/services/inbox.js      createNotification
 *   services/notifications/src/services/email.js      sendEmail
 *
 * The model only decides nudge/skip (+ which single course) and drafts wording.
 * All guardrails below are deterministic and checked BEFORE the agent acts.
 */

export const FLAG_KEY = "ga-find_a431764685ac";

export const MIN_STALL_DAYS = 7;
export const NUDGE_COOLDOWN_DAYS = 14;
export const DAILY_SEND_CAP = 200;
export const NOTIFICATION_TYPE = "reengagement";
const DAY_MS = 24 * 60 * 60 * 1000;

const noopLogger = {
  info() {},
  warn() {},
  error() {}
};

function pick(mod, names) {
  if (!mod) return null;
  for (const name of names) {
    if (typeof mod[name] === "function") return mod[name].bind(mod);
  }
  const def = mod.default;
  if (def) {
    for (const name of names) {
      if (typeof def[name] === "function") return def[name].bind(def);
    }
  }
  return null;
}

async function tryImport(specifier) {
  try {
    return await import(specifier);
  } catch {
    return null;
  }
}

function envFlagEnabled(key) {
  const direct = process.env[`FLAG_${key.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`];
  if (direct != null) return /^(1|true|on|yes|enabled)$/i.test(String(direct).trim());
  const list = process.env.FEATURE_FLAGS || process.env.ENABLED_FLAGS || "";
  return String(list)
    .split(/[,\s]+/)
    .filter(Boolean)
    .includes(key);
}

async function defaultFlagEnabled(key) {
  const flags =
    (await tryImport("@learnloop/shared/flags")) ||
    (await tryImport("../../../../packages/shared/src/flags.js"));
  const read = pick(flags, ["isEnabled", "isFlagEnabled", "flagEnabled", "getFlag", "get"]);
  if (read) {
    try {
      const value = await read(key);
      if (value && typeof value === "object") return Boolean(value.enabled ?? value.value);
      if (value != null) return Boolean(value);
    } catch {
      /* fall through to the env read below */
    }
  }
  return envFlagEnabled(key);
}

async function resolveDeps(overrides) {
  const deps = { ...overrides };

  if (!deps.flagEnabled) deps.flagEnabled = defaultFlagEnabled;
  if (!deps.logger) deps.logger = noopLogger;
  if (!deps.now) deps.now = () => new Date();
  if (typeof deps.dailyCap !== "number") deps.dailyCap = DAILY_SEND_CAP;

  const needsProgress =
    !deps.listProgressOverview ||
    !deps.completionPercent ||
    !deps.nextLessonFor ||
    !deps.daysSinceLastActivity;

  if (needsProgress) {
    const progress = await tryImport("../services/progress.js");
    deps.listProgressOverview =
      deps.listProgressOverview || pick(progress, ["listProgressOverview"]);
    deps.completionPercent = deps.completionPercent || pick(progress, ["completionPercent"]);
    deps.nextLessonFor = deps.nextLessonFor || pick(progress, ["nextLessonFor"]);
    deps.daysSinceLastActivity =
      deps.daysSinceLastActivity || pick(progress, ["daysSinceLastActivity"]);
  }

  if (!deps.listEnrolledCourseIds) {
    const enrolments = await tryImport("../repositories/enrolments.js");
    deps.listEnrolledCourseIds = pick(enrolments, ["listEnrolledCourseIds"]);
  }

  if (!deps.createNotification) {
    const inbox = await tryImport("../../../notifications/src/services/inbox.js");
    deps.createNotification = pick(inbox, ["createNotification"]);
  }

  if (!deps.sendEmail) {
    const email = await tryImport("../../../notifications/src/services/email.js");
    deps.sendEmail = pick(email, ["sendEmail"]);
  }

  if (!deps.listNotifications) {
    const repo = await tryImport("../../../notifications/src/repositories/notifications.js");
    deps.listNotifications =
      pick(repo, ["listNotifications", "listForUser", "listByUser", "list"]) || (async () => []);
  }

  if (!deps.agent) {
    const module = await import("../agents/reengagementModel.js");
    deps.agent = await module.createDefaultReengagementAgent();
  }

  return deps;
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function call(fn, args, fallback) {
  if (typeof fn !== "function") return fallback;
  try {
    return await fn(...args);
  } catch {
    return fallback;
  }
}

function courseIdOf(entry) {
  return String(entry.courseId ?? entry.course_id ?? entry.id ?? "");
}

function courseTitleOf(entry) {
  return String(entry.courseTitle ?? entry.course_title ?? entry.title ?? "").trim();
}

function lessonTitleOf(lesson) {
  if (!lesson) return "";
  return String(lesson.title ?? lesson.lessonTitle ?? lesson.name ?? "").trim();
}

function lessonIdOf(lesson) {
  if (!lesson) return "";
  return String(lesson.lessonId ?? lesson.id ?? "");
}

/** Deterministic cooldown guardrail: one re-engagement message per learner per 14 days. */
export function nudgedRecently(notifications, now, cooldownDays = NUDGE_COOLDOWN_DAYS) {
  const cutoff = now.getTime() - cooldownDays * DAY_MS;
  return (notifications || []).some((n) => {
    if (!n) return false;
    const type = String(n.type ?? n.notificationType ?? "");
    const isNudge = type === NOTIFICATION_TYPE || n.applied_by_agent === true;
    if (!isNudge) return false;
    const at = Date.parse(n.createdAt ?? n.created_at ?? n.sentAt ?? n.sent_at ?? "");
    return Number.isFinite(at) ? at >= cutoff : true;
  });
}

/** Strip every digit and URL the model may have written: numbers are injected by code. */
function sanitiseModelText(text) {
  return String(text || "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\{\s*(course|percent|lesson)\s*\}/gi, (_m, key) => `{${key.toLowerCase()}}`)
    .replace(/\d+(?:[.,]\d+)?%?/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function renderWithFacts(text, facts) {
  const safe = sanitiseModelText(text);
  const filled = safe
    .replace(/\{course\}/g, facts.courseTitle)
    .replace(/\{percent\}/g, `${facts.percentComplete}%`)
    .replace(/\{lesson\}/g, facts.nextLessonTitle);
  return filled.replace(/\s{2,}/g, " ").trim();
}

function fallbackCopy(facts) {
  return {
    subject: `Pick up ${facts.courseTitle} where you left off`,
    body: `You are ${facts.percentComplete}% through ${facts.courseTitle}. Your next lesson is "${facts.nextLessonTitle}".`
  };
}

/**
 * Build the deterministic candidate facts for one learner.
 * Eligible = enrolled, started (at least one completed lesson), unfinished, and stalled.
 */
async function candidatesFor(learner, deps) {
  const learnerId = String(learner.userId ?? learner.id ?? learner);
  const enrolledIds = (await call(deps.listEnrolledCourseIds, [learnerId], [])) || [];
  const enrolled = new Set(enrolledIds.map((id) => String(id && id.courseId ? id.courseId : id)));
  if (enrolled.size === 0) return [];

  const overview = (await call(deps.listProgressOverview, [learnerId], [])) || [];
  const now = deps.now();
  const candidates = [];

  for (const entry of overview) {
    if (!entry) continue;
    const courseId = courseIdOf(entry);
    if (!courseId || !enrolled.has(courseId)) continue;

    const percent =
      asNumber(await call(deps.completionPercent, [entry, learnerId], null)) ??
      asNumber(entry.percentComplete ?? entry.percent);
    if (percent == null || percent <= 0 || percent >= 100) continue;

    const completedLessons = asNumber(entry.completedLessons ?? entry.completed_lessons);
    if (completedLessons != null && completedLessons < 1) continue;

    const nextLesson =
      (await call(deps.nextLessonFor, [entry, learnerId], null)) || entry.nextLesson || null;
    const nextLessonTitle = lessonTitleOf(nextLesson);
    if (!nextLessonTitle) continue;

    const stallDays = asNumber(
      await call(deps.daysSinceLastActivity, [entry, learnerId], null)
    );
    if (stallDays == null || stallDays < MIN_STALL_DAYS) continue;

    candidates.push({
      learnerId,
      courseId,
      courseTitle: courseTitleOf(entry) || courseId,
      percentComplete: Math.round(percent),
      nextLessonTitle,
      nextLessonId: lessonIdOf(nextLesson),
      totalLessons: asNumber(entry.totalLessons ?? entry.total_lessons),
      completedLessons,
      daysSinceLastActivity: Math.round(stallDays),
      evaluatedAt: now.toISOString()
    });
  }

  return candidates;
}

async function listLearners(deps) {
  if (deps.learners) return deps.learners;
  if (typeof deps.listLearnerIds === "function") return (await deps.listLearnerIds()) || [];
  return null;
}

/**
 * Daily agent job. Does nothing at all while the feature flag is off.
 * Mirrors the batch-loop / per-user log context pattern of
 * services/billing/src/jobs/renewals.js (renewDueSubscriptions).
 */
export async function runReengagementNudgeJob(overrides = {}) {
  const deps = await resolveDeps(overrides);
  const { logger } = deps;

  const enabled = await deps.flagEnabled(FLAG_KEY);
  if (!enabled) {
    logger.info("reengagement_nudge_skipped", { flag: FLAG_KEY, reason: "flag_off" });
    return { enabled: false, considered: 0, sent: 0, skipped: 0, results: [] };
  }

  const learners = await listLearners(deps);
  if (!learners) {
    logger.warn("reengagement_nudge_no_learner_source", { flag: FLAG_KEY });
    return { enabled: true, considered: 0, sent: 0, skipped: 0, results: [] };
  }

  if (typeof deps.createNotification !== "function" || typeof deps.sendEmail !== "function") {
    logger.warn("reengagement_nudge_no_delivery_path", { flag: FLAG_KEY });
    return { enabled: true, considered: 0, sent: 0, skipped: 0, results: [] };
  }

  const summary = { enabled: true, considered: 0, sent: 0, skipped: 0, results: [] };

  for (const learner of learners) {
    if (summary.sent >= deps.dailyCap) {
      logger.warn("reengagement_nudge_daily_cap_reached", { cap: deps.dailyCap });
      break;
    }

    const learnerId = String(learner.userId ?? learner.id ?? learner);
    const log = { userId: learnerId, flag: FLAG_KEY };

    try {
      const candidates = await candidatesFor(learner, deps);
      if (candidates.length === 0) {
        summary.skipped += 1;
        summary.results.push({ userId: learnerId, action: "skip", reason: "not_stalled" });
        continue;
      }
      summary.considered += 1;

      const history = (await call(deps.listNotifications, [learnerId], [])) || [];
      if (nudgedRecently(history, deps.now())) {
        summary.skipped += 1;
        summary.results.push({ userId: learnerId, action: "skip", reason: "cooldown" });
        logger.info("reengagement_nudge_cooldown", log);
        continue;
      }

      const decision = await deps.agent.decide({
        candidates,
        minStallDays: MIN_STALL_DAYS,
        nudgedInLast14Days: false
      });

      if (!decision || decision.action !== "nudge") {
        summary.skipped += 1;
        summary.results.push({
          userId: learnerId,
          action: "skip",
          reason: (decision && decision.reason) || "model_skip"
        });
        continue;
      }

      // One course per message, and only a course the deterministic code produced.
      const facts =
        candidates.find((c) => c.courseId === decision.courseId) || candidates[0];

      const drafted = await deps.agent.draft({
        courseTitle: facts.courseTitle,
        percentPlaceholder: "{percent}",
        lessonPlaceholder: "{lesson}",
        daysSinceLastActivity: facts.daysSinceLastActivity
      });

      const copy = drafted
        ? {
            subject: renderWithFacts(drafted.subject, facts) || fallbackCopy(facts).subject,
            body: renderWithFacts(drafted.body, facts) || fallbackCopy(facts).body
          }
        : fallbackCopy(facts);

      const lessonPath = facts.nextLessonId ? `/lessons/${facts.nextLessonId}` : `/courses/${facts.courseId}`;
      const body = `${copy.body}\n\nContinue: ${lessonPath}`;

      await deps.createNotification({
        userId: learnerId,
        type: NOTIFICATION_TYPE,
        title: copy.subject,
        body,
        link: lessonPath,
        courseId: facts.courseId,
        applied_by_agent: true
      });

      await deps.sendEmail({
        userId: learnerId,
        to: learner.email,
        template: NOTIFICATION_TYPE,
        subject: copy.subject,
        body,
        text: body,
        applied_by_agent: true
      });

      summary.sent += 1;
      summary.results.push({
        userId: learnerId,
        action: "nudge",
        courseId: facts.courseId,
        percentComplete: facts.percentComplete,
        nextLessonTitle: facts.nextLessonTitle,
        daysSinceLastActivity: facts.daysSinceLastActivity,
        subject: copy.subject,
        applied_by_agent: true
      });
      logger.info("reengagement_nudge_sent", { ...log, courseId: facts.courseId });
    } catch (err) {
      summary.skipped += 1;
      summary.results.push({ userId: learnerId, action: "error", reason: String(err && err.message) });
      logger.error("reengagement_nudge_failed", { ...log, error: String(err && err.message) });
    }
  }

  logger.info("reengagement_nudge_done", {
    flag: FLAG_KEY,
    considered: summary.considered,
    sent: summary.sent,
    skipped: summary.skipped,
    cap: deps.dailyCap
  });

  return summary;
}

export default runReengagementNudgeJob;
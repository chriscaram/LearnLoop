/**
 * Re-engagement nudge agent (governance finding find_a431764685ac).
 *
 * Every number, lesson title and link in the message comes from the existing
 * deterministic code (services/learning/src/services/progress.js,
 * services/learning/src/repositories/enrolments.js) and the message is delivered
 * by the existing notification + email services. The model only chooses
 * nudge/skip for one course and drafts the wording.
 *
 * All new behaviour is gated on the runtime feature flag below.
 */

export const FLAG_KEY = "ga-find_a431764685ac";

export const DEFAULTS = {
  minStallDays: 7,
  nudgeCooldownDays: 14,
  dailySendCap: 50,
  maxLearnersPerRun: 500,
  notificationType: "reminder",
  lessonUrlBase: "/lessons/",
  maxBodyChars: 400,
  maxSubjectChars: 120,
};

const AGENT_SOURCE = "agent:find_a431764685ac";
const DAY_MS = 24 * 60 * 60 * 1000;

const nudgeLedger = new Map(); // learnerId -> epoch ms of last agent nudge
const dailyCounters = new Map(); // yyyy-mm-dd (UTC) -> sends

export function resetAgentState() {
  nudgeLedger.clear();
  dailyCounters.clear();
}

async function loadModule(specifier) {
  try {
    const mod = await import(specifier);
    if (mod && typeof mod.default === "object" && mod.default !== null) {
      return { ...mod.default, ...mod };
    }
    return mod;
  } catch (err) {
    return null;
  }
}

function pick(mod, names) {
  if (!mod) return null;
  for (const name of names) {
    if (typeof mod[name] === "function") return mod[name];
  }
  return null;
}

function truthyFlag(value) {
  if (value === true) return true;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") return /^(1|true|on|enabled)$/i.test(value.trim());
  if (value && typeof value === "object") {
    const inner = value.enabled !== undefined ? value.enabled : value.value !== undefined ? value.value : value.on;
    return inner === undefined ? false : truthyFlag(inner);
  }
  return false;
}

function flagFromEnvironment() {
  const direct = process.env.GA_FIND_A431764685AC;
  if (direct !== undefined && truthyFlag(direct)) return true;
  const bag = process.env.FEATURE_FLAGS || "";
  if (!bag.includes(FLAG_KEY)) return false;
  try {
    return truthyFlag(JSON.parse(bag)[FLAG_KEY]);
  } catch (err) {
    return /ga-find_a431764685ac"?\s*[:=]\s*("?)(1|true|on|enabled)\1/i.test(bag);
  }
}

/** Runtime read of the feature flag. Absent or unreadable means OFF. */
export async function isAgentEnabled(provided) {
  if (typeof provided === "function") {
    try {
      return truthyFlag(await provided(FLAG_KEY));
    } catch (err) {
      return false;
    }
  }
  const flags = await loadModule("../../../../packages/shared/src/flags.js");
  const reader = pick(flags, ["isFlagEnabled", "isEnabled", "flagEnabled", "getFlag", "readFlag"]);
  if (reader) {
    try {
      const value = await reader(FLAG_KEY);
      if (value !== undefined && value !== null) return truthyFlag(value);
    } catch (err) {
      /* fall through to the environment read */
    }
  }
  return flagFromEnvironment();
}

const REQUIRED_DEPS = [
  "listProgressOverview",
  "completionPercent",
  "daysSinceLastActivity",
  "nextLessonFor",
  "listEnrolledCourseIds",
  "createNotification",
  "sendEmail",
  "decideNudge",
];

async function resolveDeps(provided = {}) {
  const deps = { ...provided };

  if (
    !deps.listProgressOverview ||
    !deps.completionPercent ||
    !deps.daysSinceLastActivity ||
    !deps.nextLessonFor
  ) {
    const progress = await loadModule("../services/progress.js");
    deps.listProgressOverview = deps.listProgressOverview || pick(progress, ["listProgressOverview"]);
    deps.completionPercent = deps.completionPercent || pick(progress, ["completionPercent"]);
    deps.daysSinceLastActivity =
      deps.daysSinceLastActivity || pick(progress, ["daysSinceLastActivity"]);
    deps.nextLessonFor = deps.nextLessonFor || pick(progress, ["nextLessonFor"]);
  }
  if (!deps.listEnrolledCourseIds) {
    const enrolments = await loadModule("../repositories/enrolments.js");
    deps.listEnrolledCourseIds = pick(enrolments, ["listEnrolledCourseIds"]);
  }
  if (!deps.createNotification) {
    const inbox = await loadModule("../../../notifications/src/services/inbox.js");
    deps.createNotification = pick(inbox, ["createNotification"]);
  }
  if (!deps.sendEmail) {
    const email = await loadModule("../../../notifications/src/services/email.js");
    deps.sendEmail = pick(email, ["sendEmail"]);
  }
  if (!deps.listNotifications) {
    const repo = await loadModule("../../../notifications/src/repositories/notifications.js");
    deps.listNotifications = pick(repo, ["listNotifications", "listForUser", "listByUser", "list"]);
  }
  if (!deps.listLearners) {
    const learners = await loadModule("../../../admin/src/repositories/learners.js");
    deps.listLearners = pick(learners, ["listLearners", "listAll", "list"]);
  }
  if (!deps.decideNudge) {
    const agent = await loadModule("../agents/reengagementAgent.js");
    deps.decideNudge = pick(agent, ["decideNudge"]);
  }

  const missing = REQUIRED_DEPS.filter((name) => typeof deps[name] !== "function");
  return { deps, missing };
}

async function tryCall(fn, argLists, fallback) {
  for (const args of argLists) {
    try {
      const value = await fn(...args);
      if (value === undefined || value === null) continue;
      if (typeof value === "number" && !Number.isFinite(value)) continue;
      return value;
    } catch (err) {
      /* try the next supported call shape */
    }
  }
  return fallback;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.items)) return value.items;
  if (value && Array.isArray(value.courses)) return value.courses;
  return [];
}

function toNumber(value) {
  const num = typeof value === "string" ? Number(value) : value;
  return typeof num === "number" && Number.isFinite(num) ? num : null;
}

function idOf(row, keys) {
  for (const key of keys) {
    if (row && row[key] !== undefined && row[key] !== null && row[key] !== "") return String(row[key]);
  }
  return null;
}

function utcDayKey(now) {
  return new Date(now).toISOString().slice(0, 10);
}

/** Model drafts may not carry numbers or links: strip them deterministically. */
function sanitizeDraft(text, maxChars) {
  return String(text || "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/www\.\S+/gi, " ")
    .replace(/\d+\s*%/g, " ")
    .replace(/\d+/g, " ")
    .replace(/[<>{}]/g, " ")
    .replace(/\s+([.,!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function buildMessage(draft, facts, config) {
  const subject =
    sanitizeDraft(draft.subject, config.maxSubjectChars) || "Ready to finish your course?";
  const lead =
    sanitizeDraft(draft.body, config.maxBodyChars) ||
    "You made a good start on this course. Picking it back up now only takes a few minutes.";
  const link = `${config.lessonUrlBase}${facts.nextLessonId}`;
  const body = [
    lead,
    `You are ${facts.percent}% through "${facts.courseTitle}".`,
    `Next lesson: "${facts.nextLessonTitle}" - ${link}`,
  ].join("\n\n");
  return { subject, body, link };
}

async function recentlyNudged(deps, learnerId, cooldownMs, now) {
  const last = nudgeLedger.get(learnerId);
  if (typeof last === "number" && now - last < cooldownMs) return true;
  if (typeof deps.listNotifications !== "function") return false;
  const existing = asArray(
    await tryCall(deps.listNotifications, [[learnerId], [{ userId: learnerId }]], []),
  );
  return existing.some((item) => {
    if (!item) return false;
    const fromAgent =
      item.applied_by_agent === true || item.appliedByAgent === true || item.source === AGENT_SOURCE;
    if (!fromAgent) return false;
    const stamp = Date.parse(item.createdAt || item.created_at || item.sentAt || item.sent_at || "");
    return !Number.isFinite(stamp) || now - stamp < cooldownMs;
  });
}

async function candidatesFor(deps, learnerId, config) {
  const enrolled = asArray(
    await tryCall(deps.listEnrolledCourseIds, [[learnerId], [{ userId: learnerId }]], []),
  ).map((value) => (typeof value === "string" ? value : idOf(value, ["courseId", "course_id", "id"])));
  if (enrolled.length === 0) return [];

  const overview = asArray(
    await tryCall(deps.listProgressOverview, [[learnerId], [{ userId: learnerId }]], []),
  );
  const candidates = [];

  for (const row of overview) {
    const courseId = idOf(row, ["courseId", "course_id", "id"]);
    if (!courseId || !enrolled.includes(courseId)) continue;

    const percent = toNumber(
      await tryCall(
        deps.completionPercent,
        [[row], [learnerId, courseId], [{ userId: learnerId, courseId }]],
        row.percentComplete !== undefined ? row.percentComplete : row.percent,
      ),
    );
    if (percent === null || percent <= 0 || percent >= 100) continue;

    const stallDays = toNumber(
      await tryCall(
        deps.daysSinceLastActivity,
        [
          [learnerId, courseId],
          [row],
          [row.lastActivityAt || row.last_activity_at],
          [{ userId: learnerId, courseId }],
        ],
        null,
      ),
    );
    if (stallDays === null || stallDays < config.minStallDays) continue;

    const nextLesson = await tryCall(
      deps.nextLessonFor,
      [[learnerId, courseId], [row], [{ userId: learnerId, courseId }]],
      row.nextLesson || null,
    );
    const nextLessonId = nextLesson ? idOf(nextLesson, ["id", "lessonId", "lesson_id", "slug"]) : null;
    const nextLessonTitle = nextLesson ? nextLesson.title || nextLesson.name : null;
    if (!nextLessonId || !nextLessonTitle) continue;

    const total = toNumber(row.totalLessons !== undefined ? row.totalLessons : row.total_lessons);
    const done = toNumber(
      row.completedLessons !== undefined ? row.completedLessons : row.completed_lessons,
    );

    candidates.push({
      courseId,
      courseTitle: row.courseTitle || row.title || row.course_title || courseId,
      percent: Math.round(percent),
      stallDays: Math.floor(stallDays),
      lessonsRemaining: total !== null && done !== null ? Math.max(total - done, 0) : null,
      nextLessonId,
      nextLessonTitle,
    });
  }

  candidates.sort((a, b) => b.percent - a.percent);
  return candidates;
}

export async function runReengagementNudges(options = {}) {
  const config = { ...DEFAULTS, ...(options.config || {}) };
  const log = options.logger || console;
  const provided = options.deps || {};
  const now = typeof options.now === "number" ? options.now : Date.now();

  // Kill switch: the flag read happens before anything else is touched.
  const enabled = await isAgentEnabled(provided.isFlagEnabled || options.isFlagEnabled);
  if (!enabled) {
    return { flag: FLAG_KEY, enabled: false, considered: 0, nudged: 0, skipped: [] };
  }

  const { deps, missing } = await resolveDeps(provided);
  if (missing.length > 0) {
    if (typeof log.warn === "function") {
      log.warn("reengagement_agent_dependencies_unavailable", { flag: FLAG_KEY, missing });
    }
    return { flag: FLAG_KEY, enabled: true, error: "dependencies_unavailable", missing, nudged: 0 };
  }

  let learners = options.learners;
  if (!Array.isArray(learners)) {
    learners = asArray(await tryCall(deps.listLearners, [[]], []));
  }
  learners = learners.slice(0, config.maxLearnersPerRun);

  const dayKey = utcDayKey(now);
  const cooldownMs = config.nudgeCooldownDays * DAY_MS;
  const result = { flag: FLAG_KEY, enabled: true, considered: 0, nudged: 0, skipped: [] };

  for (const learner of learners) {
    const learnerId = idOf(learner, ["id", "userId", "user_id"]);
    if (!learnerId) continue;
    result.considered += 1;

    if ((dailyCounters.get(dayKey) || 0) >= config.dailySendCap) {
      result.skipped.push({ learnerId, reason: "daily_cap_reached" });
      continue;
    }

    try {
      if (await recentlyNudged(deps, learnerId, cooldownMs, now)) {
        result.skipped.push({ learnerId, reason: "nudged_recently" });
        continue;
      }

      const candidates = await candidatesFor(deps, learnerId, config);
      if (candidates.length === 0) {
        result.skipped.push({ learnerId, reason: "not_eligible" });
        continue;
      }

      // Only activity and progress facts reach the model - no personal attributes.
      const facts = {
        minStallDays: config.minStallDays,
        nudgedBefore: nudgeLedger.has(learnerId),
        candidates: candidates.map((candidate) => ({
          courseId: candidate.courseId,
          courseTitle: candidate.courseTitle,
          percentComplete: candidate.percent,
          lessonsRemaining: candidate.lessonsRemaining,
          daysSinceLastActivity: candidate.stallDays,
          nextLessonTitle: candidate.nextLessonTitle,
        })),
      };

      const draft = (await deps.decideNudge(facts)) || { action: "skip" };
      if (draft.action !== "nudge") {
        result.skipped.push({ learnerId, reason: draft.reason || "model_chose_skip" });
        continue;
      }
      const chosen = candidates.find((candidate) => candidate.courseId === String(draft.courseId));
      if (!chosen) {
        result.skipped.push({ learnerId, reason: "model_course_not_eligible" });
        continue;
      }

      const message = buildMessage(draft, chosen, config);

      await deps.createNotification({
        userId: learnerId,
        user_id: learnerId,
        type: config.notificationType,
        title: message.subject,
        body: message.body,
        link: message.link,
        source: AGENT_SOURCE,
        applied_by_agent: true,
      });

      const to = learner.email || learner.emailAddress || learner.email_address;
      if (to) {
        await deps.sendEmail({
          to,
          userId: learnerId,
          subject: message.subject,
          body: message.body,
          text: message.body,
          source: AGENT_SOURCE,
          applied_by_agent: true,
        });
      }

      nudgeLedger.set(learnerId, now);
      dailyCounters.set(dayKey, (dailyCounters.get(dayKey) || 0) + 1);
      result.nudged += 1;

      if (typeof log.info === "function") {
        log.info("reengagement_nudge_sent", {
          flag: FLAG_KEY,
          userId: learnerId,
          courseId: chosen.courseId,
          percentComplete: chosen.percent,
          daysSinceLastActivity: chosen.stallDays,
          applied_by_agent: true,
        });
      }
    } catch (err) {
      result.skipped.push({ learnerId, reason: "error", error: err && err.message });
      if (typeof log.error === "function") {
        log.error("reengagement_nudge_failed", { flag: FLAG_KEY, userId: learnerId, error: err && err.message });
      }
    }
  }

  return result;
}

export default { runReengagementNudges, isAgentEnabled, resetAgentState, FLAG_KEY, DEFAULTS };
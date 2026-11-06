// Re-engagement agent for stalled learners (finding find_a431764685ac).
//
// Every number, lesson title and link in the message comes from the existing
// deterministic code in this service:
//   services/learning/src/services/progress.js
//     - listProgressOverview, daysSinceLastActivity, nextLessonFor, completionPercent
//   services/learning/src/repositories/enrolments.js
//     - listEnrolledCourseIds
// Delivery reuses the notifications service:
//   services/notifications/src/services/inbox.js  - createNotification
//   services/notifications/src/services/email.js  - sendEmail
//
// The model only (a) decides nudge / skip and which single course, and
// (b) drafts subject and body copy. It never computes a number.

export const FLAG_KEY = "ga-find_a431764685ac";

const FLAG_ENV_KEYS = [
  "GA_FIND_A431764685AC",
  "FLAG_GA_FIND_A431764685AC",
  FLAG_KEY,
];

const DEFAULTS = {
  minStallDays: 7,
  maxStallDays: 120,
  nudgeCooldownDays: 14,
  dailySendCap: 200,
  maxLearnersPerRun: 500,
  bodyMaxChars: 320,
  subjectMaxChars: 120,
};

const NOTIFICATION_TYPE_CANDIDATES = [
  "reminder",
  "course_progress",
  "message",
  "system",
  "info",
];

// In-process guardrail ledger (secondary to the persisted notification history).
const state = {
  lastNudgeAt: new Map(),
  sentOnDate: { date: null, count: 0 },
};

export function __resetAgentState() {
  state.lastNudgeAt = new Map();
  state.sentOnDate = { date: null, count: 0 };
}

function utcDateKey(now) {
  return new Date(now).toISOString().slice(0, 10);
}

function log(event, fields) {
  try {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ event, agent: "reengagement_nudges", ...fields }));
  } catch (err) {
    // never let logging break the job
  }
}

async function loadModule(candidates) {
  for (const spec of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await import(spec);
    } catch (err) {
      // try the next candidate
    }
  }
  return null;
}

function pickFn(mod, names) {
  if (!mod) return null;
  const sources = [mod, mod.default].filter(Boolean);
  for (const source of sources) {
    for (const name of names) {
      if (typeof source[name] === "function") return source[name].bind(source);
    }
  }
  return null;
}

function envFlagValue() {
  for (const key of FLAG_ENV_KEYS) {
    const raw = process.env[key];
    if (raw !== undefined && raw !== "") return String(raw).toLowerCase();
  }
  return null;
}

/**
 * Runtime read of the feature flag "ga-find_a431764685ac".
 * Absent or off => the agent does nothing and existing behaviour is unchanged.
 */
export async function isAgentEnabled(deps = {}) {
  if (typeof deps.isFlagEnabled === "function") {
    try {
      return Boolean(await deps.isFlagEnabled(FLAG_KEY));
    } catch (err) {
      return false;
    }
  }
  const flags = await loadModule([
    "@learnloop/shared/flags.js",
    "@learnloop/shared/src/flags.js",
    "@learnloop/shared",
    "../../../../packages/shared/src/flags.js",
  ]);
  const fn = pickFn(flags, ["isEnabled", "isFlagEnabled", "flagEnabled", "getFlag"]);
  if (fn) {
    try {
      return Boolean(await fn(FLAG_KEY));
    } catch (err) {
      // fall through to the env read
    }
  }
  const value = envFlagValue();
  return value === "1" || value === "true" || value === "on" || value === "enabled";
}

async function resolveDeps(deps = {}) {
  const resolved = { ...deps };

  if (
    !resolved.listProgressOverview ||
    !resolved.daysSinceLastActivity ||
    !resolved.nextLessonFor ||
    !resolved.completionPercent
  ) {
    const progress = await loadModule(["../services/progress.js"]);
    resolved.listProgressOverview =
      resolved.listProgressOverview || pickFn(progress, ["listProgressOverview"]);
    resolved.daysSinceLastActivity =
      resolved.daysSinceLastActivity || pickFn(progress, ["daysSinceLastActivity"]);
    resolved.nextLessonFor = resolved.nextLessonFor || pickFn(progress, ["nextLessonFor"]);
    resolved.completionPercent =
      resolved.completionPercent || pickFn(progress, ["completionPercent"]);
  }

  if (!resolved.listEnrolledCourseIds) {
    const enrolments = await loadModule(["../repositories/enrolments.js"]);
    resolved.listEnrolledCourseIds = pickFn(enrolments, ["listEnrolledCourseIds"]);
  }

  if (!resolved.createNotification) {
    const inbox = await loadModule([
      "@learnloop/notifications/src/services/inbox.js",
      "../../../notifications/src/services/inbox.js",
    ]);
    resolved.createNotification = pickFn(inbox, ["createNotification"]);
  }

  if (!resolved.sendEmail) {
    const email = await loadModule([
      "@learnloop/notifications/src/services/email.js",
      "../../../notifications/src/services/email.js",
    ]);
    resolved.sendEmail = pickFn(email, ["sendEmail"]);
  }

  if (!resolved.listRecentNotifications) {
    const repo = await loadModule([
      "@learnloop/notifications/src/repositories/notifications.js",
      "../../../notifications/src/repositories/notifications.js",
    ]);
    resolved.listRecentNotifications = pickFn(repo, [
      "listNotifications",
      "listForUser",
      "listByUser",
      "list",
    ]);
  }

  return resolved;
}

function num(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstDefined(source, keys) {
  for (const key of keys) {
    if (source && source[key] !== undefined && source[key] !== null && source[key] !== "") {
      return source[key];
    }
  }
  return null;
}

async function safeCall(fn, args, fallback = null) {
  if (typeof fn !== "function") return fallback;
  try {
    return await fn(...args);
  } catch (err) {
    return fallback;
  }
}

/** Normalise one overview row using only deterministic helpers. */
async function describeCourse(userId, row, deps) {
  const courseId = firstDefined(row, ["courseId", "course_id", "id"]);
  const courseTitle =
    firstDefined(row, ["courseTitle", "course_title", "title", "name"]) || String(courseId);

  const lastActivityAt = firstDefined(row, [
    "lastActivityAt",
    "last_activity_at",
    "lastActivity",
    "updatedAt",
  ]);

  let days = await safeCall(deps.daysSinceLastActivity, [lastActivityAt], null);
  if (num(days) === null) days = await safeCall(deps.daysSinceLastActivity, [row], null);
  if (num(days) === null) days = num(firstDefined(row, ["daysSinceLastActivity", "stallDays"]));

  let percent = num(firstDefined(row, ["percent", "completionPercent", "percentComplete"]));
  if (percent === null) {
    percent = num(await safeCall(deps.completionPercent, [row], null));
  }
  if (percent === null) {
    percent = num(
      await safeCall(deps.completionPercent, [row.lessons, row.progress], null)
    );
  }

  let nextLesson = await safeCall(deps.nextLessonFor, [row], null);
  if (!nextLesson) nextLesson = await safeCall(deps.nextLessonFor, [userId, courseId], null);
  if (!nextLesson) nextLesson = firstDefined(row, ["nextLesson", "next_lesson"]);

  const nextLessonTitle = nextLesson
    ? firstDefined(nextLesson, ["title", "name", "lessonTitle"])
    : null;
  const nextLessonId = nextLesson
    ? firstDefined(nextLesson, ["id", "lessonId", "lesson_id"])
    : null;

  const completedLessons = num(
    firstDefined(row, ["completedLessons", "completed_lessons", "completedCount"])
  );
  const totalLessons = num(firstDefined(row, ["totalLessons", "total_lessons", "lessonCount"]));

  return {
    courseId,
    courseTitle,
    percent: percent === null ? null : Math.round(percent),
    daysSinceLastActivity: num(days),
    nextLessonId,
    nextLessonTitle,
    completedLessons,
    totalLessons,
    lessonsRemaining:
      completedLessons !== null && totalLessons !== null
        ? Math.max(totalLessons - completedLessons, 0)
        : null,
  };
}

/** Guardrail: enrolled, started, unfinished, stalled long enough, next lesson known. */
function isEligible(course, enrolledIds, options) {
  if (!course.courseId) return false;
  if (enrolledIds && enrolledIds.length && !enrolledIds.includes(course.courseId)) return false;
  if (course.percent === null) return false;
  if (course.percent <= 0) return false; // never learners with zero progress
  if (course.percent >= 100) return false; // never a finished course
  if (course.completedLessons !== null && course.completedLessons < 1) return false;
  if (course.daysSinceLastActivity === null) return false;
  if (course.daysSinceLastActivity < options.minStallDays) return false;
  if (course.daysSinceLastActivity > options.maxStallDays) return false;
  if (!course.nextLessonTitle) return false;
  return true;
}

function timestampOf(record) {
  const raw = firstDefined(record, ["createdAt", "created_at", "sentAt", "sent_at", "timestamp"]);
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/** Guardrail: at most one re-engagement message per learner per cooldown window. */
async function nudgedRecently(userId, deps, options, now) {
  const cooldownMs = options.nudgeCooldownDays * 24 * 60 * 60 * 1000;
  const remembered = state.lastNudgeAt.get(userId);
  if (remembered && now - remembered < cooldownMs) return true;

  const history = await safeCall(deps.listRecentNotifications, [userId], null);
  if (!Array.isArray(history)) return false;
  return history.some((record) => {
    if (!record) return false;
    const fromAgent =
      record.applied_by_agent === true ||
      record.appliedByAgent === true ||
      String(firstDefined(record, ["source", "origin"]) || "") === "reengagement_agent";
    if (!fromAgent) return false;
    const ts = timestampOf(record);
    return ts === null ? true : now - ts < cooldownMs;
  });
}

function sanitizeModelText(text, maxChars) {
  return String(text || "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\d+(?:[.,]\d+)?\s*%/g, "")
    .replace(/\s*\{\{[^}]*\}\}\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function parseModelJson(raw) {
  const text = typeof raw === "string" ? raw : String(raw && raw.content ? raw.content : "");
  const flat = Array.isArray(text) ? text.join(" ") : text;
  const match = String(flat).match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (err) {
    return null;
  }
}

function contentToText(message) {
  if (!message) return "";
  const content = message.content !== undefined ? message.content : message;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part && part.text ? part.text : ""))
      .join(" ");
  }
  return String(content);
}

async function getModel(deps) {
  if (deps.model) return deps.model;
  if (typeof deps.createModel === "function") return deps.createModel();
  const mod = await loadModule(["./bedrockModel.js", "../agents/bedrockModel.js"]);
  const factory = pickFn(mod, ["createReengagementModel", "createModel"]);
  if (!factory) throw new Error("bedrock model factory unavailable");
  return factory();
}

const DECIDE_SYSTEM = [
  "You decide whether a learning platform should send one re-engagement nudge now.",
  "You are given only pre-computed facts. Never invent, recompute or alter any number, lesson name or link.",
  "Choose exactly one course to nudge about, or skip when the learner is unlikely to benefit",
  "(barely started, almost certainly abandoned, or activity looks resumed).",
  'Reply with JSON only: {"action":"nudge"|"skip","course_id":"<id or null>","reason":"<short>"}',
].join(" ");

const DRAFT_SYSTEM = [
  "You write one short, warm re-engagement message for a learner of an online course platform.",
  "Use only the supplied course title and next lesson title; never state or guess any percentage,",
  "count, date or URL - the application appends those itself.",
  "Keep it under 60 words, no greeting placeholders, no marketing claims.",
  'Reply with JSON only: {"subject":"<subject>","body":"<body>"}',
].join(" ");

async function decideCourse(candidates, model, facts) {
  if (candidates.length === 1 && !model) return candidates[0];
  const prompt = JSON.stringify({
    days_since_last_activity: facts.daysSinceLastActivity,
    previously_nudged: facts.previouslyNudged,
    candidate_courses: candidates.map((course) => ({
      course_id: course.courseId,
      percent_complete: course.percent,
      lessons_remaining: course.lessonsRemaining,
      days_since_last_activity: course.daysSinceLastActivity,
    })),
  });
  const reply = await model.invoke([
    { role: "system", content: DECIDE_SYSTEM },
    { role: "user", content: prompt },
  ]);
  const parsed = parseModelJson(contentToText(reply));
  if (!parsed || parsed.action !== "nudge") return null;
  const chosen = candidates.find((course) => String(course.courseId) === String(parsed.course_id));
  return chosen || null;
}

async function draftMessage(course, model, options) {
  const prompt = JSON.stringify({
    course_title: course.courseTitle,
    next_lesson_title: course.nextLessonTitle,
    days_since_last_activity: course.daysSinceLastActivity,
  });
  const reply = await model.invoke([
    { role: "system", content: DRAFT_SYSTEM },
    { role: "user", content: prompt },
  ]);
  const parsed = parseModelJson(contentToText(reply)) || {};
  const subject =
    sanitizeModelText(parsed.subject, options.subjectMaxChars) ||
    `Pick up ${course.courseTitle} where you left off`;
  const body =
    sanitizeModelText(parsed.body, options.bodyMaxChars) ||
    `You still have lessons left in ${course.courseTitle}. A short session is enough to move forward.`;
  return { subject, body };
}

function buildDeterministicFooter(course) {
  const lines = [
    `${course.courseTitle}: ${course.percent}% complete.`,
    `Next lesson: ${course.nextLessonTitle}.`,
  ];
  if (course.nextLessonId) lines.push(`Continue: /lessons/${course.nextLessonId}`);
  return lines.join(" ");
}

async function deliver(learner, course, draft, deps, now) {
  const userId = learner.userId;
  const body = `${draft.body} ${buildDeterministicFooter(course)}`.trim();
  const link = course.nextLessonId ? `/lessons/${course.nextLessonId}` : null;

  let created = null;
  for (const type of NOTIFICATION_TYPE_CANDIDATES) {
    const payload = {
      userId,
      user_id: userId,
      type,
      title: draft.subject,
      subject: draft.subject,
      body,
      message: body,
      link,
      url: link,
      applied_by_agent: true,
      source: "reengagement_agent",
    };
    try {
      // eslint-disable-next-line no-await-in-loop
      created = await deps.createNotification(payload);
      break;
    } catch (err) {
      created = null;
    }
  }
  if (!created) {
    log("nudge_notification_failed", { user_id: userId, course_id: course.courseId });
    return false;
  }

  if (typeof deps.sendEmail === "function" && learner.email) {
    try {
      await deps.sendEmail({
        to: learner.email,
        email: learner.email,
        userId,
        user_id: userId,
        subject: draft.subject,
        body,
        text: body,
        applied_by_agent: true,
      });
    } catch (err) {
      log("nudge_email_failed", { user_id: userId, course_id: course.courseId });
    }
  }

  state.lastNudgeAt.set(userId, now);
  log("nudge_sent", {
    user_id: userId,
    course_id: course.courseId,
    percent: course.percent,
    days_since_last_activity: course.daysSinceLastActivity,
    applied_by_agent: true,
  });
  return true;
}

function learnerIdOf(learner) {
  if (typeof learner === "string") return learner;
  return firstDefined(learner, ["userId", "user_id", "id"]);
}

async function resolveLearners(deps, options) {
  if (typeof deps.listLearners === "function") {
    const learners = await deps.listLearners();
    return Array.isArray(learners) ? learners.slice(0, options.maxLearnersPerRun) : [];
  }
  const users = await loadModule([
    "@learnloop/identity/src/repositories/users.js",
    "../../../identity/src/repositories/users.js",
  ]);
  const fn = pickFn(users, ["listUsers", "listAllUsers", "listAll", "list"]);
  if (!fn) return [];
  const learners = await safeCall(fn, [], []);
  return Array.isArray(learners) ? learners.slice(0, options.maxLearnersPerRun) : [];
}

/**
 * One run of the agent. Returns a summary; never throws for a single learner.
 */
export async function runReengagementAgent(input = {}) {
  const options = { ...DEFAULTS, ...(input.options || {}) };
  const envCap = Number(process.env.NUDGE_DAILY_CAP);
  if (Number.isFinite(envCap) && envCap >= 0) options.dailySendCap = envCap;

  const summary = {
    enabled: false,
    considered: 0,
    eligible: 0,
    skippedRateLimited: 0,
    skippedByModel: 0,
    sent: 0,
    capped: false,
  };

  if (!(await isAgentEnabled(input.deps || {}))) {
    log("agent_disabled", { flag: FLAG_KEY });
    return summary;
  }
  summary.enabled = true;

  const now = Number(input.now) || Date.now();
  const today = utcDateKey(now);
  if (state.sentOnDate.date !== today) state.sentOnDate = { date: today, count: 0 };

  const deps = await resolveDeps(input.deps || {});
  if (typeof deps.listProgressOverview !== "function" || typeof deps.createNotification !== "function") {
    log("agent_dependencies_unavailable", {});
    return summary;
  }

  const learners = await resolveLearners(deps, options);
  let model = null;

  for (const learner of learners) {
    const userId = learnerIdOf(learner);
    if (!userId) continue;
    summary.considered += 1;

    if (state.sentOnDate.count >= options.dailySendCap) {
      summary.capped = true;
      log("daily_cap_reached", { cap: options.dailySendCap });
      break;
    }

    try {
      const enrolledIds = (await safeCall(deps.listEnrolledCourseIds, [userId], [])) || [];
      if (Array.isArray(enrolledIds) && enrolledIds.length === 0) continue;

      const overview = (await safeCall(deps.listProgressOverview, [userId], [])) || [];
      const rows = Array.isArray(overview) ? overview : overview.courses || [];
      const described = [];
      for (const row of rows) {
        // eslint-disable-next-line no-await-in-loop
        described.push(await describeCourse(userId, row, deps));
      }
      const candidates = described.filter((course) => isEligible(course, enrolledIds, options));
      if (candidates.length === 0) continue;
      summary.eligible += 1;

      if (await nudgedRecently(userId, deps, options, now)) {
        summary.skippedRateLimited += 1;
        log("nudge_skipped_rate_limit", { user_id: userId, window_days: options.nudgeCooldownDays });
        continue;
      }

      if (!model) model = await getModel(input.deps || {});
      const chosen = await decideCourse(candidates, model, {
        daysSinceLastActivity: Math.max(
          ...candidates.map((course) => course.daysSinceLastActivity || 0)
        ),
        previouslyNudged: false,
      });
      if (!chosen) {
        summary.skippedByModel += 1;
        continue;
      }

      const draft = await draftMessage(chosen, model, options);
      const email = typeof learner === "object" ? firstDefined(learner, ["email"]) : null;
      const delivered = await deliver({ userId, email }, chosen, draft, deps, now);
      if (delivered) {
        summary.sent += 1;
        state.sentOnDate.count += 1;
      }
    } catch (err) {
      log("nudge_failed", { user_id: userId, error: err && err.message ? err.message : "unknown" });
    }
  }

  log("agent_run_complete", summary);
  return summary;
}

export const __internal = { describeCourse, isEligible, sanitizeModelText, DEFAULTS };
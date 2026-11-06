/**
 * Re-engagement nudge agent (governance finding find_a431764685ac,
 * NBF-USAGE-ACTOR_INACTIVITY).
 *
 * The agent itself computes nothing: every number, lesson title and link comes
 * from the existing deterministic code in this service
 * (services/learning/src/services/progress.js,
 *  services/learning/src/repositories/enrolments.js) and delivery goes through
 * the existing notifications service functions (createNotification, sendEmail).
 *
 * The model is used for exactly two things:
 *   1. decide            - nudge now / stay silent, and which single course
 *   2. generate_content   - subject + short body referencing the injected facts
 *
 * Everything is gated behind the runtime feature flag "ga-find_a431764685ac".
 */

import { ChatBedrockConverse } from "@langchain/aws";

export const FLAG_KEY = "ga-find_a431764685ac";
export const DEFAULT_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

/** Guardrails (deterministic, checked before the agent acts). */
export const MIN_STALL_DAYS = 5;
export const NUDGE_COOLDOWN_DAYS = 14;
export const DAILY_SEND_CAP = 50;
export const MAX_COURSES_PER_MESSAGE = 1;
export const NUDGE_NOTIFICATION_TYPE = "reengagement";
export const AUDIT_SAMPLE_SIZE = 10;

const UNSAFE_COPY = /\d|https?:\/\//i;

/* ------------------------------------------------------------------ flags */

function flagEnvName(flagKey) {
  return String(flagKey).toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function truthy(value) {
  return ["1", "true", "on", "yes", "enabled"].includes(
    String(value ?? "").trim().toLowerCase()
  );
}

/**
 * Reads the flag through the shared flags client when it is resolvable,
 * otherwise falls back to a plain environment read. Absent => off.
 */
export async function defaultFlagEnabled(flagKey = FLAG_KEY) {
  try {
    const mod = await import("@learnloop/shared/flags");
    const fn =
      mod.isFlagEnabled ||
      mod.isEnabled ||
      mod.getFlag ||
      (mod.flags && (mod.flags.isEnabled || mod.flags.isFlagEnabled));
    if (typeof fn === "function") {
      const value = await fn(flagKey);
      if (typeof value === "boolean") return value;
      if (value && typeof value === "object") return Boolean(value.enabled);
      if (value !== undefined && value !== null) return truthy(value);
    }
  } catch (err) {
    // shared flags client not resolvable here - fall through to env read
  }
  return truthy(process.env[flagEnvName(flagKey)]);
}

/* ------------------------------------------------- deterministic plumbing */

/** Loads this service's deterministic progress / enrolment functions. */
export async function loadDeterministic(overrides = {}) {
  const loaded = {};
  try {
    const progress = await import("../services/progress.js");
    loaded.listProgressOverview = progress.listProgressOverview;
    loaded.completionPercent = progress.completionPercent;
    loaded.daysSinceLastActivity = progress.daysSinceLastActivity;
    loaded.nextLessonFor = progress.nextLessonFor;
    loaded.getLastActivityAt = progress.getLastActivityAt;
  } catch (err) {
    // leave unset; caller must inject
  }
  try {
    const enrolments = await import("../repositories/enrolments.js");
    loaded.listEnrolledCourseIds = enrolments.listEnrolledCourseIds;
  } catch (err) {
    // leave unset; caller must inject
  }
  return { ...loaded, ...overrides };
}

/** Calls fn with the first argument list that yields a usable value. */
async function callTolerant(fn, argLists, isValid) {
  if (typeof fn !== "function") return undefined;
  for (const args of argLists) {
    try {
      const value = await fn(...args);
      if (isValid(value)) return value;
    } catch (err) {
      // try the next shape
    }
  }
  return undefined;
}

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);
const isObject = (v) => Boolean(v) && typeof v === "object";

function pick(source, keys, fallback) {
  for (const key of keys) {
    if (isObject(source) && source[key] !== undefined && source[key] !== null) {
      return source[key];
    }
  }
  return fallback;
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (isObject(value) && Array.isArray(value.items)) return value.items;
  if (isObject(value) && Array.isArray(value.courses)) return value.courses;
  return [];
}

function wholeDaysBetween(from, to) {
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.floor((end - start) / 86400000);
}

/* ----------------------------------------------------------------- model */

async function temporaryCredentials() {
  const roleArn = process.env.BEDROCK_ROLE_ARN;
  if (!roleArn) return undefined;
  const { STSClient, AssumeRoleCommand } = await import("@aws-sdk/client-sts");
  const sts = new STSClient({ region: process.env.AWS_REGION });
  const out = await sts.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: "learnloop-reengagement-agent"
    })
  );
  const creds = out && out.Credentials;
  if (!creds) return undefined;
  return {
    accessKeyId: creds.AccessKeyId,
    secretAccessKey: creds.SecretAccessKey,
    sessionToken: creds.SessionToken
  };
}

/** Default model factory: LangChain.js over Amazon Bedrock. */
export async function createModel() {
  const credentials = await temporaryCredentials();
  return new ChatBedrockConverse({
    model: process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID,
    region: process.env.AWS_REGION,
    temperature: 0.2,
    maxTokens: 400,
    ...(credentials ? { credentials } : {})
  });
}

function messageText(response) {
  if (!response) return "";
  if (typeof response === "string") return response;
  const content = response.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string" ? part : part && part.text ? part.text : ""
      )
      .join("");
  }
  return "";
}

function parseJson(text) {
  const raw = String(text || "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch (err) {
    return null;
  }
}

/* ------------------------------------------------------------ guardrails */

/** Deterministic eligibility for a single course of a single learner. */
export function isEligibleCourse(course) {
  if (!course) return false;
  if (!course.courseId) return false;
  if (!isFiniteNumber(course.percentComplete)) return false;
  if (course.percentComplete <= 0) return false; // never zero progress
  if (course.percentComplete >= 100) return false; // never a finished course
  if ((course.completedLessons || 0) < 1) return false; // at least one started lesson
  if (!course.nextLessonTitle) return false;
  if (!isFiniteNumber(course.daysSinceLastActivity)) return false;
  return true;
}

/** True when a prior agent nudge is inside the 14 day cooldown. */
export function nudgedRecently(notifications, now, cooldownDays = NUDGE_COOLDOWN_DAYS) {
  const items = toArray(notifications).length ? toArray(notifications) : notifications || [];
  for (const item of Array.isArray(items) ? items : []) {
    const byAgent =
      pick(item, ["applied_by_agent", "appliedByAgent"], false) === true ||
      String(pick(item, ["type", "notification_type"], "")) === NUDGE_NOTIFICATION_TYPE;
    if (!byAgent) continue;
    const at = pick(item, ["created_at", "createdAt", "sent_at", "sentAt", "at"], null);
    const days = at ? wholeDaysBetween(at, now) : 0;
    if (days === null || days < cooldownDays) return true;
  }
  return false;
}

/* ---------------------------------------------------------- fact gathering */

/** Builds the deterministic per-course facts for one learner. */
export async function collectLearnerFacts(learner, deterministic, now) {
  const userId = pick(learner, ["userId", "user_id", "id"], null);
  if (!userId) return [];

  const enrolledCourseIds = await callTolerant(
    deterministic.listEnrolledCourseIds,
    [[userId], [{ userId }]],
    (v) => Array.isArray(v)
  );
  if (!enrolledCourseIds || enrolledCourseIds.length === 0) return [];
  const enrolled = new Set(enrolledCourseIds.map((id) => String(id)));

  const overview = await callTolerant(
    deterministic.listProgressOverview,
    [[userId], [{ userId }]],
    (v) => Array.isArray(v) || isObject(v)
  );

  const facts = [];
  for (const row of toArray(overview)) {
    const courseId = String(
      pick(row, ["courseId", "course_id", "id"], "")
    );
    if (!courseId || !enrolled.has(courseId)) continue;

    const lastActivityAt = pick(
      row,
      ["lastActivityAt", "last_activity_at", "lastActivity"],
      null
    );

    const percentComplete = await callTolerant(
      deterministic.completionPercent,
      [[userId, courseId], [{ userId, courseId }], [row]],
      isFiniteNumber
    );
    const days = await callTolerant(
      deterministic.daysSinceLastActivity,
      [[userId, courseId], [lastActivityAt], [{ userId, courseId }], [row]],
      isFiniteNumber
    );
    const nextLesson = await callTolerant(
      deterministic.nextLessonFor,
      [[userId, courseId], [{ userId, courseId }], [row]],
      isObject
    );

    const overviewNext = pick(row, ["nextLesson", "next_lesson"], null);

    facts.push({
      courseId,
      courseTitle: String(
        pick(row, ["courseTitle", "course_title", "title"], "your course")
      ),
      percentComplete: isFiniteNumber(percentComplete)
        ? percentComplete
        : pick(row, ["percentComplete", "percent_complete", "percent"], null),
      completedLessons: pick(
        row,
        ["completedLessons", "completed_lessons", "completed"],
        0
      ),
      totalLessons: pick(row, ["totalLessons", "total_lessons", "total"], 0),
      lastActivityAt,
      daysSinceLastActivity: isFiniteNumber(days)
        ? days
        : wholeDaysBetween(lastActivityAt, now),
      nextLessonId: pick(nextLesson || overviewNext, ["id", "lessonId", "lesson_id"], null),
      nextLessonTitle: pick(nextLesson || overviewNext, ["title", "name"], null)
    });
  }
  return facts;
}

/* ------------------------------------------------------------ model calls */

async function decideCourse(model, learnerFacts, candidates) {
  const payload = {
    days_since_last_activity: learnerFacts.maxStallDays,
    candidates: candidates.map((c) => ({
      course_id: c.courseId,
      course_title: c.courseTitle,
      percent_complete: c.percentComplete,
      lessons_remaining: Math.max(
        0,
        Number(c.totalLessons || 0) - Number(c.completedLessons || 0)
      ),
      days_since_last_activity: c.daysSinceLastActivity
    })),
    prior_nudges_in_last_90_days: learnerFacts.priorNudges
  };

  const response = await model.invoke([
    {
      role: "system",
      content:
        "You help an online learning product decide whether to send one gentle " +
        "re-engagement nudge to a learner who stopped mid-course. Use only the " +
        "facts given. Never compute, invent or restate numbers. Stay silent when " +
        "a nudge is unlikely to help (barely stalled, already nudged often). " +
        'Reply with JSON only: {"action":"nudge"|"skip","course_id":"<id or null>","reason":"<short>"}.'
    },
    { role: "user", content: JSON.stringify(payload) }
  ]);

  const parsed = parseJson(messageText(response)) || {};
  const chosenId = parsed.course_id ? String(parsed.course_id) : null;
  const chosen = candidates.find((c) => c.courseId === chosenId) || null;
  return {
    action: parsed.action === "nudge" && chosen ? "nudge" : "skip",
    course: chosen,
    reason: String(parsed.reason || "no reason given").slice(0, 200)
  };
}

async function draftCopy(model, course) {
  const response = await model.invoke([
    {
      role: "system",
      content:
        "Write a short, warm re-engagement message for a learner who paused a " +
        "course. Do not include any number, percentage, URL or lesson number - " +
        "the product appends the exact facts itself. Two sentences maximum. " +
        'Reply with JSON only: {"subject":"...","body":"..."}.'
    },
    {
      role: "user",
      content: JSON.stringify({
        course_title: course.courseTitle,
        next_lesson_title: course.nextLessonTitle
      })
    }
  ]);
  return parseJson(messageText(response)) || {};
}

export function sanitizeCopy(text, fallback, maxLength) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value || UNSAFE_COPY.test(value)) return fallback;
  return value.slice(0, maxLength);
}

/** Deterministic fact line - the only place numbers and links are produced. */
export function factLine(course, baseUrl) {
  const link = `${String(baseUrl || "").replace(/\/+$/, "")}/lessons/${
    course.nextLessonId || ""
  }`;
  return (
    `You are ${course.percentComplete}% through "${course.courseTitle}". ` +
    `Your next lesson is "${course.nextLessonTitle}": ${link}`
  );
}

/* -------------------------------------------------------------- the agent */

export async function runReengagementAgent(options = {}) {
  const {
    learners = [],
    now = new Date(),
    flagKey = FLAG_KEY,
    flagEnabled = defaultFlagEnabled,
    deterministic = {},
    createNotification,
    sendEmail,
    listRecentNotifications,
    modelFactory = createModel,
    dailyCap = DAILY_SEND_CAP,
    minStallDays = MIN_STALL_DAYS,
    baseUrl = process.env.APP_BASE_URL || "",
    logger = console
  } = options;

  const result = {
    enabled: false,
    considered: 0,
    skipped: 0,
    sent: 0,
    errors: 0,
    samples: []
  };

  if (!(await flagEnabled(flagKey))) {
    logger.info?.({ event: "reengagement_agent_disabled", flag: flagKey });
    return result;
  }
  result.enabled = true;

  if (typeof createNotification !== "function" || typeof sendEmail !== "function") {
    logger.warn?.({
      event: "reengagement_agent_no_delivery",
      flag: flagKey,
      reason: "notification/email senders unavailable"
    });
    return result;
  }

  const fns = await loadDeterministic(deterministic);
  if (
    typeof fns.listEnrolledCourseIds !== "function" ||
    typeof fns.listProgressOverview !== "function"
  ) {
    logger.warn?.({
      event: "reengagement_agent_no_deterministic_source",
      flag: flagKey
    });
    return result;
  }

  let model = null;

  for (const learner of learners) {
    if (result.sent >= dailyCap) {
      logger.info?.({ event: "reengagement_daily_cap_reached", cap: dailyCap });
      break;
    }
    const userId = pick(learner, ["userId", "user_id", "id"], null);
    if (!userId) continue;
    result.considered += 1;

    try {
      const history =
        typeof listRecentNotifications === "function"
          ? await listRecentNotifications(userId)
          : [];
      if (nudgedRecently(history, now)) {
        result.skipped += 1;
        logger.info?.({
          event: "reengagement_skipped",
          userId,
          reason: "cooldown"
        });
        continue;
      }

      const facts = await collectLearnerFacts(learner, fns, now);
      const candidates = facts
        .filter(isEligibleCourse)
        .filter((c) => c.daysSinceLastActivity >= minStallDays);

      if (candidates.length === 0) {
        result.skipped += 1;
        logger.info?.({
          event: "reengagement_skipped",
          userId,
          reason: "no eligible stalled course"
        });
        continue;
      }

      if (!model) model = await modelFactory();

      const decision = await decideCourse(
        model,
        {
          maxStallDays: Math.max(...candidates.map((c) => c.daysSinceLastActivity)),
          priorNudges: Array.isArray(history) ? history.length : 0
        },
        candidates
      );

      if (decision.action !== "nudge" || !decision.course) {
        result.skipped += 1;
        logger.info?.({
          event: "reengagement_skipped",
          userId,
          reason: `model: ${decision.reason}`
        });
        continue;
      }

      // one course per message, always
      const course = [decision.course].slice(0, MAX_COURSES_PER_MESSAGE)[0];
      const copy = await draftCopy(model, course);
      const subject = sanitizeCopy(
        copy.subject,
        `Pick up "${course.courseTitle}" where you left off`,
        120
      );
      const intro = sanitizeCopy(
        copy.body,
        "You made a good start on this course - a short session today is enough to keep going.",
        400
      );
      const body = `${intro} ${factLine(course, baseUrl)}`;

      await createNotification({
        userId,
        user_id: userId,
        type: NUDGE_NOTIFICATION_TYPE,
        title: subject,
        subject,
        body,
        message: body,
        courseId: course.courseId,
        applied_by_agent: true
      });

      await sendEmail({
        userId,
        user_id: userId,
        to: pick(learner, ["email", "emailAddress", "email_address"], null),
        template: NUDGE_NOTIFICATION_TYPE,
        subject,
        body,
        text: body,
        applied_by_agent: true
      });

      result.sent += 1;
      if (result.samples.length < AUDIT_SAMPLE_SIZE) {
        // sample_audit: staff review these in the admin learners view
        result.samples.push({
          userId,
          courseId: course.courseId,
          courseTitle: course.courseTitle,
          percentComplete: course.percentComplete,
          nextLessonTitle: course.nextLessonTitle,
          daysSinceLastActivity: course.daysSinceLastActivity,
          subject,
          body,
          applied_by_agent: true
        });
      }
      logger.info?.({
        event: "reengagement_nudge_sent",
        userId,
        courseId: course.courseId,
        applied_by_agent: true
      });
    } catch (err) {
      result.errors += 1;
      logger.error?.({
        event: "reengagement_nudge_failed",
        userId,
        error: err && err.message ? err.message : String(err)
      });
    }
  }

  logger.info?.({
    event: "reengagement_agent_run",
    flag: flagKey,
    considered: result.considered,
    sent: result.sent,
    skipped: result.skipped,
    errors: result.errors,
    samples: result.samples
  });
  return result;
}
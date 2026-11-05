// Re-engagement nudge agent (finding find_a431764685ac / NBF-USAGE-ACTOR_INACTIVITY).
//
// Every number, lesson title and link in the message comes from the existing
// deterministic code (services/learning/src/services/progress.js and
// services/learning/src/repositories/enrolments.js). The model only decides
// whether to nudge / which single course, and drafts prose. Delivery reuses the
// notifications service (inbox.createNotification + email.sendEmail).
//
// All behaviour is gated on the runtime feature flag "ga-find_a431764685ac":
// when the flag is absent or off this module does nothing at all.
import { ChatBedrockConverse } from "@langchain/aws";

export const FLAG_KEY = "ga-find_a431764685ac";
export const AGENT_NAME = "reengagement-nudges";

const DEFAULT_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const NUDGE_COOLDOWN_DAYS = 14; // guardrail: at most one message per learner / 14 days
const MIN_STALL_DAYS = 7; // guardrail: only genuinely stalled learners
const MIN_PERCENT = 1; // guardrail: must have started the course
const MAX_PERCENT = 99; // guardrail: never a finished course
const MAX_CANDIDATES_PER_LEARNER = 3;
const DEFAULT_DAILY_CAP = 200; // guardrail: global daily send cap

const DECIDE_SYSTEM = [
  "You decide whether an online course platform should send ONE re-engagement nudge to a learner now.",
  "You receive only activity and progress facts already computed by the application.",
  "Never invent or recompute numbers, lesson names or links.",
  "Prefer the course closest to completion, then the most recently touched.",
  "Stay silent when the learner looks active again or when a nudge is unlikely to help.",
  'Reply with JSON only: {"action":"nudge"|"skip","courseId":"<one of the given course ids or null>","reason":"<short>"}'
].join(" ");

const DRAFT_SYSTEM = [
  "You draft a short, warm re-engagement message for one learner of an online course platform.",
  "Write at most 2 sentences of encouragement plus a nudge to continue.",
  "Do NOT include any number, percentage, URL, lesson title or course title: the application appends those itself.",
  'Reply with JSON only: {"subject":"<max 80 chars>","body":"<max 400 chars>"}'
].join(" ");

function pickFn(mod, names) {
  for (const name of names) {
    if (mod && typeof mod[name] === "function") return mod[name];
  }
  return null;
}

async function importOptional(specifier) {
  try {
    return await import(specifier);
  } catch {
    return null;
  }
}

// Loads the existing deterministic code. Tests inject `deps` instead.
async function loadDefaultDeps() {
  const progress = await import("../services/progress.js");
  const enrolments = await import("../repositories/enrolments.js");
  const inbox = await importOptional("../../../notifications/src/services/inbox.js");
  const email = await importOptional("../../../notifications/src/services/email.js");
  const notificationsRepo = await importOptional(
    "../../../notifications/src/repositories/notifications.js"
  );
  const learnersRepo = await importOptional("../../../admin/src/repositories/learners.js");
  const flags = await importOptional("../../../../packages/shared/src/flags.js");

  return {
    listProgressOverview: progress.listProgressOverview,
    completionPercent: progress.completionPercent,
    daysSinceLastActivity: progress.daysSinceLastActivity,
    nextLessonFor: progress.nextLessonFor,
    listEnrolledCourseIds: enrolments.listEnrolledCourseIds,
    createNotification: pickFn(inbox, ["createNotification"]),
    sendEmail: pickFn(email, ["sendEmail"]),
    listNotifications: pickFn(notificationsRepo, [
      "listForUser",
      "listByUser",
      "listNotifications",
      "list"
    ]),
    listLearners: pickFn(learnersRepo, ["listLearners", "listAll", "list"]),
    readFlag: pickFn(flags, ["isEnabled", "isFlagEnabled", "flagEnabled", "getFlag", "get"])
  };
}

async function resolveDeps(injected) {
  if (injected && injected.listProgressOverview) return injected;
  const defaults = await loadDefaultDeps();
  return { ...defaults, ...(injected || {}) };
}

function truthyFlag(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "object") return truthyFlag(value.enabled ?? value.value ?? value.on);
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  return text === "true" || text === "1" || text === "on" || text === "enabled";
}

function envFlag() {
  const env = process.env;
  const direct =
    env["ga-find_a431764685ac"] ??
    env.GA_FIND_A431764685AC ??
    env.FEATURE_FLAG_GA_FIND_A431764685AC;
  if (direct !== undefined) return truthyFlag(direct);
  const blob = env.FEATURE_FLAGS;
  if (!blob) return false;
  try {
    const parsed = JSON.parse(blob);
    return truthyFlag(parsed[FLAG_KEY]);
  } catch {
    return blob.includes(FLAG_KEY);
  }
}

async function isAgentEnabled(deps) {
  if (typeof deps.readFlag === "function") {
    try {
      return truthyFlag(await deps.readFlag(FLAG_KEY));
    } catch {
      return false;
    }
  }
  return envFlag();
}

function idOf(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") return String(value);
  return (
    (value.id ?? value.userId ?? value.user_id ?? value.learnerId ?? value.learner_id ?? null) &&
    String(value.id ?? value.userId ?? value.user_id ?? value.learnerId ?? value.learner_id)
  );
}

function courseIdOf(row) {
  const raw = row?.courseId ?? row?.course_id ?? row?.course?.id ?? row?.id;
  return raw === undefined || raw === null ? null : String(raw);
}

function courseTitleOf(row) {
  return String(row?.courseTitle ?? row?.title ?? row?.course?.title ?? "your course");
}

function lastActivityOf(row) {
  return row?.lastActivityAt ?? row?.last_activity_at ?? row?.lastActivity ?? null;
}

// Percent, stall days and next lesson ALWAYS come from the deterministic
// functions; the row fields are only a fallback when a signature differs.
async function resolvePercent(deps, row, userId, courseId) {
  try {
    const value = await deps.completionPercent(row);
    if (Number.isFinite(Number(value))) return Number(value);
  } catch {
    /* fall through to the overview value */
  }
  try {
    const value = await deps.completionPercent(userId, courseId);
    if (Number.isFinite(Number(value))) return Number(value);
  } catch {
    /* fall through to the overview value */
  }
  const fallback = row?.percent ?? row?.completionPercent ?? row?.percentComplete;
  return Number.isFinite(Number(fallback)) ? Number(fallback) : null;
}

async function resolveStallDays(deps, row) {
  const lastActivity = lastActivityOf(row);
  try {
    const value = await deps.daysSinceLastActivity(lastActivity);
    if (Number.isFinite(Number(value))) return Number(value);
  } catch {
    /* fall through */
  }
  try {
    const value = await deps.daysSinceLastActivity(row);
    if (Number.isFinite(Number(value))) return Number(value);
  } catch {
    /* fall through */
  }
  const fallback = row?.daysSinceLastActivity ?? row?.days_since_last_activity;
  return Number.isFinite(Number(fallback)) ? Number(fallback) : null;
}

async function resolveNextLesson(deps, row, userId, courseId) {
  try {
    const lesson = await deps.nextLessonFor(userId, courseId);
    if (lesson) return lesson;
  } catch {
    /* fall through */
  }
  try {
    const lesson = await deps.nextLessonFor(row);
    if (lesson) return lesson;
  } catch {
    /* fall through */
  }
  return row?.nextLesson ?? row?.next_lesson ?? null;
}

function daysBetween(from, to) {
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  return Math.abs(b - a) / 86400000;
}

function isAgentNotification(notification) {
  return Boolean(
    notification?.applied_by_agent ||
      notification?.metadata?.applied_by_agent ||
      notification?.metadata?.agent === AGENT_NAME
  );
}

// Guardrail: at most one agent nudge per learner per NUDGE_COOLDOWN_DAYS days.
async function nudgedRecently(deps, userId, now) {
  if (typeof deps.listNotifications !== "function") return false;
  let existing = [];
  try {
    existing = (await deps.listNotifications(userId)) || [];
  } catch {
    return true; // cannot prove we are allowed to send -> stay silent
  }
  return existing.some((notification) => {
    if (!isAgentNotification(notification)) return false;
    const createdAt = notification.createdAt ?? notification.created_at ?? notification.sentAt;
    return daysBetween(createdAt, now) < NUDGE_COOLDOWN_DAYS;
  });
}

async function buildModel() {
  const region = process.env.AWS_REGION;
  const config = {
    model: process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID,
    region,
    temperature: 0.2,
    maxTokens: 400
  };
  const roleArn = process.env.BEDROCK_ROLE_ARN;
  if (roleArn) {
    const { STSClient, AssumeRoleCommand } = await import("@aws-sdk/client-sts");
    const sts = new STSClient({ region });
    const assumed = await sts.send(
      new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: "learnloop-reengagement-agent" })
    );
    const creds = assumed.Credentials;
    config.credentials = {
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretAccessKey,
      sessionToken: creds.SessionToken
    };
  }
  return new ChatBedrockConverse(config);
}

async function resolveModel(options) {
  if (options.model) return options.model;
  if (typeof options.createModel === "function") return options.createModel();
  return buildModel();
}

function textOf(response) {
  if (typeof response === "string") return response;
  const content = response?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("");
  }
  return "";
}

function parseJson(response) {
  const text = textOf(response);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// Guardrail: the model may not contribute numbers, links or lesson names.
function sanitizeProse(value, maxLength) {
  return String(value ?? "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\d+(?:[.,]\d+)?%?/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function logInfo(log, payload, message) {
  if (log && typeof log.info === "function") log.info(payload, message);
}

function logError(log, payload, message) {
  if (log && typeof log.error === "function") log.error(payload, message);
}

export async function runReengagementNudges(options = {}) {
  const log = options.log ?? null;
  const deps = await resolveDeps(options.deps);
  const result = { enabled: false, scanned: 0, sent: 0, skipped: 0, failed: 0 };

  if (!(await isAgentEnabled(deps))) {
    logInfo(log, { flag: FLAG_KEY }, "reengagement agent disabled, nothing to do");
    return result;
  }
  result.enabled = true;

  const now = options.now ? new Date(options.now) : new Date();
  const dailyCap = Number(options.dailyCap ?? process.env.REENGAGEMENT_DAILY_CAP ?? DEFAULT_DAILY_CAP);
  const notificationType = options.notificationType ?? process.env.REENGAGEMENT_NOTIFICATION_TYPE ?? "message";

  if (typeof deps.listLearners !== "function" || typeof deps.createNotification !== "function") {
    logError(log, { flag: FLAG_KEY }, "reengagement agent missing deterministic dependencies");
    return result;
  }

  const learners = (await deps.listLearners()) || [];
  let model = null;

  for (const learner of learners) {
    if (result.sent >= dailyCap) break;
    const userId = idOf(learner);
    if (!userId) continue;
    result.scanned += 1;

    try {
      // Guardrail: enrolled learners only.
      const enrolledIds = ((await deps.listEnrolledCourseIds(userId)) || []).map(String);
      if (!enrolledIds.length) {
        result.skipped += 1;
        continue;
      }
      if (await nudgedRecently(deps, userId, now)) {
        result.skipped += 1;
        continue;
      }

      const overview = (await deps.listProgressOverview(userId)) || [];
      const candidates = [];
      for (const row of overview) {
        const courseId = courseIdOf(row);
        if (!courseId || !enrolledIds.includes(courseId)) continue;
        const percent = await resolvePercent(deps, row, userId, courseId);
        const stallDays = await resolveStallDays(deps, row);
        const nextLesson = await resolveNextLesson(deps, row, userId, courseId);
        if (percent === null || stallDays === null || !nextLesson) continue;
        // Guardrails: started, unfinished, genuinely stalled.
        if (percent < MIN_PERCENT || percent > MAX_PERCENT) continue;
        if (stallDays < MIN_STALL_DAYS) continue;
        candidates.push({
          courseId,
          courseTitle: courseTitleOf(row),
          percent,
          stallDays,
          lessonId: String(nextLesson.id ?? nextLesson.lessonId ?? nextLesson.lesson_id ?? ""),
          lessonTitle: String(nextLesson.title ?? nextLesson.name ?? "your next lesson"),
          lessonsRemaining:
            row?.lessonsRemaining ?? row?.remainingLessons ?? row?.lessons_remaining ?? null
        });
      }
      if (!candidates.length) {
        result.skipped += 1;
        continue;
      }

      candidates.sort((a, b) => b.percent - a.percent || a.stallDays - b.stallDays);
      const shortlist = candidates.slice(0, MAX_CANDIDATES_PER_LEARNER);

      if (!model) model = await resolveModel(options);

      const decision = parseJson(
        await model.invoke([
          { role: "system", content: DECIDE_SYSTEM },
          {
            role: "user",
            content: JSON.stringify({
              cooldownDays: NUDGE_COOLDOWN_DAYS,
              nudgedInCooldownWindow: false,
              courses: shortlist.map((c) => ({
                courseId: c.courseId,
                percentComplete: c.percent,
                daysSinceLastActivity: c.stallDays,
                lessonsRemaining: c.lessonsRemaining
              }))
            })
          }
        ])
      );

      const chosen = shortlist.find((c) => c.courseId === String(decision?.courseId ?? ""));
      if (!decision || decision.action !== "nudge" || !chosen) {
        result.skipped += 1;
        logInfo(
          log,
          { userId, flag: FLAG_KEY, reason: decision?.reason ?? "no-decision" },
          "reengagement agent stayed silent"
        );
        continue;
      }

      const draft = parseJson(
        await model.invoke([
          { role: "system", content: DRAFT_SYSTEM },
          {
            role: "user",
            content: JSON.stringify({
              learnerFirstName: learner?.firstName ?? learner?.name ?? null,
              tone: "encouraging, concise"
            })
          }
        ])
      );

      const fact = `You are ${chosen.percent}% through "${chosen.courseTitle}". Next up: "${chosen.lessonTitle}".`;
      const link = `/courses/${chosen.courseId}/lessons/${chosen.lessonId}`;
      const subject = sanitizeProse(draft?.subject, 80) || "Pick up where you left off";
      const prose = sanitizeProse(draft?.body, 400);
      const body = `${prose}\n\n${fact}\nContinue here: ${link}`.trim();

      // The agent may only notify: no progress, enrolment or billing write.
      await deps.createNotification({
        userId,
        user_id: userId,
        type: notificationType,
        title: subject,
        subject,
        body,
        message: body,
        applied_by_agent: true,
        metadata: {
          applied_by_agent: true,
          agent: AGENT_NAME,
          flag: FLAG_KEY,
          courseId: chosen.courseId,
          lessonId: chosen.lessonId,
          percentComplete: chosen.percent,
          daysSinceLastActivity: chosen.stallDays
        }
      });

      if (typeof deps.sendEmail === "function") {
        try {
          await deps.sendEmail({
            userId,
            user_id: userId,
            to: learner?.email ?? null,
            subject,
            body,
            text: body,
            applied_by_agent: true
          });
        } catch (err) {
          logError(log, { userId, flag: FLAG_KEY, err: String(err) }, "reengagement email failed");
        }
      }

      result.sent += 1;
      logInfo(
        log,
        {
          userId,
          flag: FLAG_KEY,
          agent: AGENT_NAME,
          courseId: chosen.courseId,
          percentComplete: chosen.percent,
          daysSinceLastActivity: chosen.stallDays,
          applied_by_agent: true
        },
        "reengagement nudge sent"
      );
    } catch (err) {
      result.failed += 1;
      logError(log, { userId, flag: FLAG_KEY, err: String(err) }, "reengagement nudge failed");
    }
  }

  logInfo(log, { flag: FLAG_KEY, agent: AGENT_NAME, ...result }, "reengagement agent finished");
  return result;
}

export const __internals = { sanitizeProse, truthyFlag, parseJson };

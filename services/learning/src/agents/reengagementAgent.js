/**
 * Stalled-learner re-engagement agent (finding find_a431764685ac).
 *
 * Deterministic code decides WHO is eligible and supplies every number, title
 * and link. The model only (a) chooses nudge-now / skip and which single
 * eligible course to nudge about and (b) drafts the wording. All guardrails are
 * enforced here, before the model is called and before anything is sent.
 */

const FLAG_KEY = "ga-find_a431764685ac";
const DEFAULT_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

const STALL_DAYS_MIN = 7;
const NUDGE_COOLDOWN_DAYS = 14;
const DAILY_SEND_CAP = 200;
const MAX_SUBJECT_CHARS = 120;
const MAX_BODY_CHARS = 600;
const NOTIFICATION_TYPE_CANDIDATES = ["reminder", "message", "progress", "info", "system"];
const AGENT_SOURCE = FLAG_KEY;

const recentSends = new Map();
let dailyState = { day: null, count: 0 };

export function resetAgentRuntimeState() {
  recentSends.clear();
  dailyState = { day: null, count: 0 };
}

function defaultLog(level, event, context) {
  const line = { level, event, agent: AGENT_SOURCE, ...(context || {}) };
  if (level === "error") console.error(JSON.stringify(line));
  else console.log(JSON.stringify(line));
}

function utcDay(date) {
  return date.toISOString().slice(0, 10);
}

function pick(mod, name) {
  if (!mod) return undefined;
  if (typeof mod[name] === "function") return mod[name];
  if (mod.default && typeof mod.default[name] === "function") return mod.default[name];
  return undefined;
}

async function tryImport(specifier) {
  try {
    return await import(specifier);
  } catch (err) {
    return null;
  }
}

async function callFlexible(fn, argLists) {
  if (typeof fn !== "function") return undefined;
  for (const args of argLists) {
    try {
      const value = await fn(...args);
      if (value !== undefined && value !== null) return value;
    } catch (err) {
      // try the next supported argument shape
    }
  }
  return undefined;
}

function toNumber(value) {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

/* ------------------------------------------------------------------ flag --- */

export async function isAgentEnabled(options = {}) {
  if (typeof options.isFlagEnabled === "function") {
    return Boolean(await options.isFlagEnabled(FLAG_KEY));
  }
  if (typeof options.flagEnabled === "boolean") return options.flagEnabled;

  const flags = await tryImport("../../../../packages/shared/src/flags.js");
  for (const name of ["isEnabled", "isFlagEnabled", "getFlag", "readFlag", "flagEnabled"]) {
    const fn = pick(flags, name);
    if (!fn) continue;
    try {
      const value = await fn(FLAG_KEY);
      if (typeof value === "boolean") return value;
      if (value && typeof value === "object") return Boolean(value.enabled ?? value.value);
      if (typeof value === "string") return value === "true" || value === "on" || value === "1";
    } catch (err) {
      // fall through to the environment read below
    }
  }

  const envValue = firstDefined(
    process.env.GA_FIND_A431764685AC,
    process.env.FLAG_GA_FIND_A431764685AC
  );
  if (typeof envValue === "string") {
    return envValue === "true" || envValue === "on" || envValue === "1";
  }
  if (process.env.FEATURE_FLAGS) {
    try {
      const parsed = JSON.parse(process.env.FEATURE_FLAGS);
      return Boolean(parsed && parsed[FLAG_KEY]);
    } catch (err) {
      return false;
    }
  }
  return false;
}

/* ------------------------------------------------------------- deps ------- */

async function resolveDeps(options) {
  const injected = options.deps || {};
  const progress = injected.listProgressOverview ? null : await tryImport("../services/progress.js");
  const enrolments = injected.listEnrolledCourseIds
    ? null
    : await tryImport("../repositories/enrolments.js");
  const inbox = injected.createNotification
    ? null
    : await tryImport("../../../notifications/src/services/inbox.js");
  const email = injected.sendEmail
    ? null
    : await tryImport("../../../notifications/src/services/email.js");
  const notifRepo = injected.listNotifications
    ? null
    : await tryImport("../../../notifications/src/repositories/notifications.js");
  const users = injected.listLearners ? null : await tryImport("../../../billing/src/repositories/users.js");
  const identityUsers =
    injected.listLearners || users ? null : await tryImport("../../../identity/src/repositories/users.js");

  return {
    listProgressOverview: injected.listProgressOverview || pick(progress, "listProgressOverview"),
    completionPercent: injected.completionPercent || pick(progress, "completionPercent"),
    daysSinceLastActivity: injected.daysSinceLastActivity || pick(progress, "daysSinceLastActivity"),
    nextLessonFor: injected.nextLessonFor || pick(progress, "nextLessonFor"),
    getLastActivityAt: injected.getLastActivityAt || pick(progress, "getLastActivityAt"),
    listEnrolledCourseIds: injected.listEnrolledCourseIds || pick(enrolments, "listEnrolledCourseIds"),
    createNotification: injected.createNotification || pick(inbox, "createNotification"),
    sendEmail: injected.sendEmail || pick(email, "sendEmail"),
    listNotifications:
      injected.listNotifications ||
      pick(notifRepo, "listNotifications") ||
      pick(notifRepo, "listForUser") ||
      pick(notifRepo, "list"),
    listLearners:
      injected.listLearners ||
      pick(users, "listUsers") ||
      pick(users, "listAllUsers") ||
      pick(identityUsers, "listUsers") ||
      pick(identityUsers, "listAllUsers")
  };
}

/* ------------------------------------------------------------- model ------ */

async function resolveCredentials(log) {
  const roleArn = process.env.BEDROCK_ROLE_ARN;
  if (!roleArn) return undefined;
  const sts = await tryImport("@aws-sdk/client-sts");
  const STSClient = sts && (sts.STSClient || (sts.default && sts.default.STSClient));
  const AssumeRoleCommand = sts && (sts.AssumeRoleCommand || (sts.default && sts.default.AssumeRoleCommand));
  if (!STSClient || !AssumeRoleCommand) {
    log("error", "reengagement_agent_sts_unavailable", {});
    return undefined;
  }
  const client = new STSClient({ region: process.env.AWS_REGION });
  const out = await client.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: "ga-reengagement-agent",
      DurationSeconds: 3600
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

async function buildModel(options, log) {
  if (options.model) return options.model;
  const aws = await import("@langchain/aws");
  const ChatBedrockConverse = aws.ChatBedrockConverse || (aws.default && aws.default.ChatBedrockConverse);
  const credentials = await resolveCredentials(log);
  return new ChatBedrockConverse({
    model: process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID,
    region: process.env.AWS_REGION,
    temperature: 0,
    maxTokens: 400,
    ...(credentials ? { credentials } : {})
  });
}

function messageText(response) {
  if (!response) return "";
  const content = response.content !== undefined ? response.content : response;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part && part.text ? part.text : ""))
      .join("");
  }
  return "";
}

function parseJson(text) {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    return null;
  }
}

async function invokeModel(model, system, user) {
  const response = await model.invoke([
    { role: "system", content: system },
    { role: "user", content: user }
  ]);
  return parseJson(messageText(response));
}

/* ------------------------------------------------- deterministic facts ---- */

async function buildCandidates(deps, learner, now, log) {
  const learnerId = firstDefined(learner.id, learner.userId, learner.user_id);
  if (!learnerId) return [];

  const enrolledRaw = await callFlexible(deps.listEnrolledCourseIds, [[learnerId], [{ userId: learnerId }]]);
  const enrolled = Array.isArray(enrolledRaw) ? enrolledRaw.map((id) => String(id && id.courseId ? id.courseId : id)) : [];
  if (enrolled.length === 0) return [];

  const overviewRaw = await callFlexible(deps.listProgressOverview, [[learnerId], [{ userId: learnerId }]]);
  const overview = Array.isArray(overviewRaw) ? overviewRaw : [];
  const candidates = [];

  for (const course of overview) {
    const courseId = String(firstDefined(course.courseId, course.course_id, course.id, ""));
    if (!courseId || !enrolled.includes(courseId)) continue;

    const lastActivityAt = firstDefined(
      course.lastActivityAt,
      course.last_activity_at,
      await callFlexible(deps.getLastActivityAt, [[learnerId, courseId], [course]])
    );

    const days = toNumber(
      await callFlexible(deps.daysSinceLastActivity, [
        [lastActivityAt],
        [course],
        [learnerId, courseId]
      ])
    );

    const percent = toNumber(
      await callFlexible(deps.completionPercent, [
        [course],
        [course.lessons, course.completedLessonIds],
        [course.lessons, course.completedLessons],
        [learnerId, courseId]
      ])
    );

    const nextLesson =
      (await callFlexible(deps.nextLessonFor, [
        [course],
        [course.lessons, course.completedLessonIds],
        [learnerId, courseId]
      ])) || course.nextLesson || course.next_lesson;

    const completionPct = percent !== undefined ? percent : toNumber(firstDefined(course.percentComplete, course.percent, course.completionPercent));
    const nextLessonTitle = nextLesson ? firstDefined(nextLesson.title, nextLesson.name) : undefined;
    const nextLessonId = nextLesson ? firstDefined(nextLesson.lessonId, nextLesson.id) : undefined;

    // Guardrails: enrolled, started, not finished, genuinely stalled, has a next lesson.
    if (completionPct === undefined || completionPct <= 0 || completionPct >= 100) continue;
    if (!nextLessonTitle || !nextLessonId) continue;
    if (days === undefined || days < STALL_DAYS_MIN) continue;

    candidates.push({
      courseId,
      courseTitle: String(
        firstDefined(course.courseTitle, course.course_title, course.title, (course.course || {}).title, courseId)
      ),
      completionPct,
      daysSinceLastActivity: days,
      lessonsCompleted: toNumber(firstDefined(course.completedLessons, course.lessonsCompleted)),
      lessonsTotal: toNumber(firstDefined(course.totalLessons, course.lessonsTotal)),
      nextLessonTitle: String(nextLessonTitle),
      nextLessonId: String(nextLessonId),
      lastViewedLessonTitle: firstDefined(
        course.lastViewedLessonTitle,
        (course.lastViewedLesson || {}).title
      )
    });
  }

  if (candidates.length === 0) {
    log("info", "reengagement_agent_no_candidates", { userId: learnerId });
  }
  return candidates;
}

async function nudgedRecently(deps, learnerId, now) {
  const remembered = recentSends.get(learnerId);
  const cutoff = now.getTime() - NUDGE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
  if (remembered && remembered >= cutoff) return true;

  const listed = await callFlexible(deps.listNotifications, [[learnerId], [{ userId: learnerId }]]);
  const items = Array.isArray(listed) ? listed : Array.isArray(listed && listed.items) ? listed.items : [];
  return items.some((item) => {
    if (!item) return false;
    const byAgent = Boolean(item.applied_by_agent || item.appliedByAgent || item.source === AGENT_SOURCE);
    if (!byAgent) return false;
    const created = Date.parse(firstDefined(item.createdAt, item.created_at, item.sentAt, 0) || 0);
    return Number.isFinite(created) ? created >= cutoff : true;
  });
}

function deterministicMessage(learner, candidate, link) {
  const name = firstDefined(learner.name, learner.firstName, "there");
  return {
    subject: `Pick up ${candidate.courseTitle} where you left off`,
    body:
      `Hi ${name}, your course is still waiting for you.\n` +
      `${candidate.courseTitle} — ${candidate.completionPct}% complete. ` +
      `Next lesson: ${candidate.nextLessonTitle}. Continue: ${link}`
  };
}

function composeMessage(generated, learner, candidate, link) {
  const fallback = deterministicMessage(learner, candidate, link);
  const subject = typeof generated?.subject === "string" ? generated.subject.trim() : "";
  const body = typeof generated?.body === "string" ? generated.body.trim() : "";
  // The model may never produce a number or a link: those come from the code.
  if (!subject || !body || /\d/.test(subject) || /\d/.test(body) || /https?:\/\//i.test(body)) {
    return fallback;
  }
  return {
    subject: subject.slice(0, MAX_SUBJECT_CHARS),
    body:
      `${body.slice(0, MAX_BODY_CHARS)}\n` +
      `${candidate.courseTitle} — ${candidate.completionPct}% complete. ` +
      `Next lesson: ${candidate.nextLessonTitle}. Continue: ${link}`
  };
}

async function createNotificationFlexible(deps, payload) {
  for (const type of NOTIFICATION_TYPE_CANDIDATES) {
    const record = { ...payload, type };
    const created = await callFlexible(deps.createNotification, [
      [record],
      [record.userId, record],
      [record.userId, type, record.title, record.body]
    ]);
    if (created !== undefined) return { created, type };
  }
  return null;
}

/* --------------------------------------------------------------- run ----- */

export async function runStalledLearnerNudgeAgent(options = {}) {
  const log = options.log || defaultLog;
  const now = options.now ? new Date(options.now) : new Date();
  const result = { enabled: false, scanned: 0, sent: 0, skipped: 0, capped: 0, errors: 0 };

  if (!(await isAgentEnabled(options))) {
    log("info", "reengagement_agent_disabled", { flag: FLAG_KEY });
    return result;
  }
  result.enabled = true;

  const deps = await resolveDeps(options);
  if (!deps.listProgressOverview || !deps.listEnrolledCourseIds || !deps.createNotification) {
    log("error", "reengagement_agent_dependencies_missing", { flag: FLAG_KEY });
    return result;
  }

  const day = utcDay(now);
  if (dailyState.day !== day) dailyState = { day, count: 0 };
  const dailyCap = toNumber(options.dailyCap) ?? DAILY_SEND_CAP;

  let learners = options.learners;
  if (!Array.isArray(learners)) {
    const listed = await callFlexible(deps.listLearners, [[], [{}]]);
    learners = Array.isArray(listed) ? listed : [];
  }
  if (learners.length === 0) {
    log("info", "reengagement_agent_no_learners", {});
    return result;
  }

  let model = null;
  const sample = [];

  for (const learner of learners) {
    const learnerId = firstDefined(learner.id, learner.userId, learner.user_id);
    if (!learnerId) continue;
    result.scanned += 1;

    if (dailyState.count >= dailyCap) {
      result.capped += 1;
      continue;
    }

    try {
      if (await nudgedRecently(deps, learnerId, now)) {
        result.skipped += 1;
        log("info", "reengagement_agent_skipped", { userId: learnerId, reason: "cooldown" });
        continue;
      }

      const candidates = await buildCandidates(deps, learner, now, log);
      if (candidates.length === 0) {
        result.skipped += 1;
        continue;
      }

      if (!model) model = await buildModel(options, log);

      const facts = {
        candidates: candidates.map((c) => ({
          courseId: c.courseId,
          courseTitle: c.courseTitle,
          percentComplete: c.completionPct,
          daysSinceLastActivity: c.daysSinceLastActivity,
          lessonsCompleted: c.lessonsCompleted,
          lessonsTotal: c.lessonsTotal,
          nextLessonTitle: c.nextLessonTitle
        })),
        nudgedInLast14Days: false
      };

      const decision = await invokeModel(
        model,
        "You decide whether an online learner should receive one re-engagement nudge now. " +
          "Use only the supplied facts. Never invent or change a number. " +
          'Answer strict JSON: {"action":"nudge"|"skip","courseId":"<id from candidates>","reason":"<short>"}.',
        JSON.stringify(facts)
      );

      const chosenId = decision && typeof decision.courseId === "string" ? decision.courseId : null;
      const candidate = candidates.find((c) => c.courseId === chosenId);
      if (!decision || decision.action !== "nudge" || !candidate) {
        result.skipped += 1;
        log("info", "reengagement_agent_skipped", {
          userId: learnerId,
          reason: decision && decision.action === "skip" ? "model_skip" : "no_valid_choice"
        });
        continue;
      }

      const generated = await invokeModel(
        model,
        "You draft one short, warm re-engagement message for an online learner. " +
          "Do not include any digit, percentage, number or URL: the application appends those. " +
          'Answer strict JSON: {"subject":"<one line>","body":"<2-3 short sentences>"}.',
        JSON.stringify({
          courseTitle: candidate.courseTitle,
          nextLessonTitle: candidate.nextLessonTitle,
          learnerName: firstDefined(learner.name, learner.firstName, "there")
        })
      );

      const baseUrl = String(process.env.APP_BASE_URL || "").replace(/\/+$/, "");
      const link = `${baseUrl}/lessons/${candidate.nextLessonId}`;
      const message = composeMessage(generated, learner, candidate, link);

      const created = await createNotificationFlexible(deps, {
        userId: learnerId,
        user_id: learnerId,
        title: message.subject,
        body: message.body,
        link,
        courseId: candidate.courseId,
        source: AGENT_SOURCE,
        applied_by_agent: true
      });
      if (!created) {
        result.errors += 1;
        log("error", "reengagement_agent_notification_failed", { userId: learnerId });
        continue;
      }

      const to = firstDefined(learner.email, learner.emailAddress);
      if (to && deps.sendEmail) {
        await callFlexible(deps.sendEmail, [
          [
            {
              to,
              userId: learnerId,
              subject: message.subject,
              body: message.body,
              text: message.body,
              applied_by_agent: true
            }
          ],
          [to, message.subject, message.body]
        ]);
      }

      recentSends.set(learnerId, now.getTime());
      dailyState.count += 1;
      result.sent += 1;
      if (sample.length < 5) {
        sample.push({ userId: learnerId, courseId: candidate.courseId, subject: message.subject });
      }
      log("info", "reengagement_agent_sent", {
        userId: learnerId,
        courseId: candidate.courseId,
        percentComplete: candidate.completionPct,
        daysSinceLastActivity: candidate.daysSinceLastActivity,
        applied_by_agent: true
      });
    } catch (err) {
      result.errors += 1;
      log("error", "reengagement_agent_error", { userId: learnerId, error: String(err && err.message ? err.message : err) });
    }
  }

  // sample_audit: a daily sample of generated nudges is logged for staff review.
  log("info", "reengagement_agent_run", { ...result, sample });
  return result;
}

export const AGENT_FLAG_KEY = FLAG_KEY;
export const AGENT_CONSTANTS = { STALL_DAYS_MIN, NUDGE_COOLDOWN_DAYS, DAILY_SEND_CAP };
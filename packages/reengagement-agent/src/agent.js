/**
 * Re-engagement nudge agent (finding find_a431764685ac, NBF-USAGE-ACTOR_INACTIVITY).
 *
 * Every calculation and exact data read is done by the existing deterministic
 * code in services/learning and services/notifications (see ./deps.js).
 * The model only decides nudge/skip + which course, and drafts the wording.
 *
 * All new behaviour is gated on the runtime feature flag 'ga-find_a431764685ac'.
 */

import { FLAG_KEY, resolveDeps, missingDeps } from './deps.js';

export { FLAG_KEY };

export const MIN_STALL_DAYS = 7;
export const COOLDOWN_DAYS = 14;
export const DEFAULT_DAILY_CAP = 50;
export const NUDGE_SOURCE = 'reengagement_agent';

const DAY_MS = 24 * 60 * 60 * 1000;

function dailyCap() {
  const raw = Number.parseInt(process.env.REENGAGEMENT_DAILY_CAP || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_CAP;
}

function notificationType() {
  return process.env.REENGAGEMENT_NOTIFICATION_TYPE || 'reminder';
}

function lessonLink(lessonId) {
  const base = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  return `${base}/lessons/${lessonId}`;
}

function noopLogger() {
  return { info() {}, warn() {}, error() {} };
}

function num(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function field(obj, names) {
  if (!obj) return undefined;
  for (const name of names) {
    if (obj[name] !== undefined && obj[name] !== null) return obj[name];
  }
  return undefined;
}

function normaliseEntry(entry) {
  return {
    raw: entry,
    courseId: field(entry, ['course_id', 'courseId', 'id']),
    courseTitle: field(entry, ['course_title', 'courseTitle', 'title', 'name']),
    percent: num(field(entry, ['percent', 'percent_complete', 'percentComplete', 'completionPercent'])),
    lessonsCompleted: num(
      field(entry, ['lessons_completed', 'lessonsCompleted', 'completed_lessons', 'completed'])
    ),
    lessonsTotal: num(field(entry, ['lessons_total', 'lessonsTotal', 'total_lessons', 'total'])),
    lastActivityAt: field(entry, ['last_activity_at', 'lastActivityAt', 'last_activity', 'updated_at']),
    daysSince: num(field(entry, ['days_since_last_activity', 'daysSinceLastActivity'])),
    nextLesson: field(entry, ['next_lesson', 'nextLesson'])
  };
}

function normaliseLesson(lesson) {
  if (!lesson) return null;
  const id = field(lesson, ['id', 'lesson_id', 'lessonId']);
  const title = field(lesson, ['title', 'name', 'lesson_title']);
  if (!id || !title) return null;
  return { id, title: String(title) };
}

async function callFirst(fn, argLists, validate) {
  for (const args of argLists) {
    try {
      const value = await fn(...args);
      if (validate(value)) return value;
    } catch {
      /* try the next calling convention */
    }
  }
  return null;
}

/** 14-day cooldown, from the notifications already stored for that learner. */
export function nudgedWithinCooldown(notifications, now, cooldownDays = COOLDOWN_DAYS) {
  const cutoff = now.getTime() - cooldownDays * DAY_MS;
  const type = notificationType();
  return (notifications || []).some((n) => {
    const isAgentNudge =
      n.applied_by_agent === true ||
      n.appliedByAgent === true ||
      field(n, ['source', 'agent_source']) === NUDGE_SOURCE ||
      (field(n, ['type']) === type && (n.applied_by_agent === true || n.appliedByAgent === true));
    if (!isAgentNudge) return false;
    const at = field(n, ['created_at', 'createdAt', 'sent_at', 'sentAt', 'at']);
    const ts = at ? new Date(at).getTime() : NaN;
    if (!Number.isFinite(ts)) return true; // unknown timestamp -> fail closed
    return ts >= cutoff;
  });
}

/**
 * The model may not supply a number, a link or a lesson name. Any draft that
 * contains a digit not among the deterministic facts, or any URL, is replaced
 * by a deterministic template.
 */
export function sanitiseDraft(draft, facts) {
  const allowed = new Set(
    [facts.percent_complete, facts.days_since_last_activity, facts.lessons_completed, facts.lessons_total]
      .filter((v) => v !== null && v !== undefined)
      .map((v) => String(v))
  );

  const clean = (value, max) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    if (/https?:\/\/|www\./i.test(text)) return null;
    const digits = text.match(/\d+/g) || [];
    if (digits.some((d) => !allowed.has(d))) return null;
    return text.slice(0, max);
  };

  const subject = clean(draft && (draft.subject || draft.title), 120);
  const body = clean(draft && (draft.body || draft.message || draft.text), 400);

  if (subject && body) return { subject, body, fallback: false };

  return {
    subject: `Pick up "${facts.course_title}" where you left off`,
    body: `You started "${facts.course_title}" and there is a little left to go. Ready to carry on?`,
    fallback: true
  };
}

/** Builds the message body; the facts line and link are deterministic. */
export function composeBody(body, facts) {
  return [
    body,
    '',
    `You are ${facts.percent_complete}% through "${facts.course_title}". Next up: "${facts.next_lesson_title}".`,
    lessonLink(facts.next_lesson_id)
  ].join('\n');
}

async function factsFor(deps, learner, entry, now) {
  // days since last activity - deterministic (progress.daysSinceLastActivity)
  let days = entry.daysSince;
  if (days === null) {
    days = num(
      await callFirst(
        deps.daysSinceLastActivity,
        [[entry.lastActivityAt], [learner.id, entry.courseId], [entry.raw], [learner.id]],
        (v) => num(v) !== null
      )
    );
  }

  // completion percent - deterministic (progress.completionPercent)
  let percent = entry.percent;
  if (percent === null) {
    percent = num(
      await callFirst(
        deps.completionPercent,
        [[learner.id, entry.courseId], [entry.raw], [entry.courseId, learner.id]],
        (v) => num(v) !== null
      )
    );
  }

  // next uncompleted lesson - deterministic (progress.nextLessonFor)
  let nextLesson = normaliseLesson(entry.nextLesson);
  if (!nextLesson) {
    nextLesson = normaliseLesson(
      await callFirst(
        deps.nextLessonFor,
        [[learner.id, entry.courseId], [entry.raw], [entry.courseId, learner.id]],
        (v) => normaliseLesson(v) !== null
      )
    );
  }

  if (days === null || percent === null || !nextLesson || !entry.courseTitle) return null;

  return {
    course_id: entry.courseId,
    course_title: String(entry.courseTitle),
    percent_complete: Math.round(percent),
    days_since_last_activity: Math.round(days),
    lessons_completed: entry.lessonsCompleted,
    lessons_total: entry.lessonsTotal,
    next_lesson_id: nextLesson.id,
    next_lesson_title: nextLesson.title,
    last_activity_at: entry.lastActivityAt || null,
    evaluated_at: now.toISOString()
  };
}

/**
 * Runs one pass of the agent.
 * Returns { skipped, reason, sent, considered, samples } - samples are the
 * daily audit sample staff read in the admin learners view (sample_audit HITL).
 */
export async function runReengagementAgent(options = {}) {
  const logger = options.logger || noopLogger();
  const now = options.now ? new Date(options.now) : new Date();
  const deps = await resolveDeps(options.deps || {});

  // ---- feature flag kill switch: off => do nothing at all -----------------
  const enabled = await deps.isFlagEnabled(FLAG_KEY);
  if (!enabled) {
    logger.info('reengagement_agent_skipped', { flag: FLAG_KEY, reason: 'flag_off' });
    return { skipped: true, reason: 'flag_off', sent: 0, considered: 0, samples: [] };
  }

  const missing = missingDeps(deps);
  if (missing.length > 0) {
    logger.warn('reengagement_agent_skipped', { flag: FLAG_KEY, reason: 'missing_deps', missing });
    return { skipped: true, reason: 'missing_deps', missing, sent: 0, considered: 0, samples: [] };
  }

  const llm = options.llm || (await (await import('./model.js')).createLlm());
  const cap = options.dailyCap || dailyCap();
  const type = notificationType();

  const learners = (await deps.listLearnerIds()) || [];
  const samples = [];
  let sent = 0;
  let considered = 0;

  for (const rawLearner of learners) {
    if (sent >= cap) {
      logger.info('reengagement_agent_daily_cap_reached', { cap, sent });
      break;
    }

    const learner =
      typeof rawLearner === 'string' || typeof rawLearner === 'number'
        ? { id: rawLearner }
        : rawLearner || {};
    if (!learner.id) continue;

    try {
      // guardrail: only enrolled learners are ever considered
      const enrolled = (await deps.listEnrolledCourseIds(learner.id)) || [];
      const enrolledIds = new Set(enrolled.map((c) => (typeof c === 'object' ? field(c, ['course_id', 'courseId', 'id']) : c)));
      if (enrolledIds.size === 0) continue;

      // guardrail: at most one nudge per learner per COOLDOWN_DAYS; fail closed
      let history;
      try {
        history = (await deps.listNotifications(learner.id)) || [];
      } catch {
        logger.warn('reengagement_agent_history_unavailable', { user_id: learner.id });
        continue;
      }
      if (nudgedWithinCooldown(history, now)) continue;

      const overview = (await deps.listProgressOverview(learner.id)) || [];

      // guardrail: started but unfinished only, and genuinely stalled
      const candidates = [];
      for (const entry of overview.map(normaliseEntry)) {
        if (!entry.courseId || !enrolledIds.has(entry.courseId)) continue;
        const facts = await factsFor(deps, learner, entry, now);
        if (!facts) continue;
        if (facts.percent_complete <= 0 || facts.percent_complete >= 100) continue;
        if (facts.days_since_last_activity < MIN_STALL_DAYS) continue;
        candidates.push(facts);
      }
      if (candidates.length === 0) continue;
      considered += 1;

      // ---- model part 1: decide ------------------------------------------
      const decision = await llm.decide({
        days_cooldown: COOLDOWN_DAYS,
        min_stall_days: MIN_STALL_DAYS,
        candidates: candidates.map((c) => ({
          course_id: c.course_id,
          course_title: c.course_title,
          percent_complete: c.percent_complete,
          days_since_last_activity: c.days_since_last_activity,
          lessons_completed: c.lessons_completed,
          lessons_total: c.lessons_total
        }))
      });

      if (!decision || decision.action !== 'nudge') continue;
      const chosen = candidates.find((c) => c.course_id === decision.course_id);
      if (!chosen) continue; // guardrail: one course, and only a real candidate

      // ---- model part 2: draft wording -----------------------------------
      const draft = sanitiseDraft(await llm.draft(chosen), chosen);
      const body = composeBody(draft.body, chosen);

      const payload = {
        user_id: learner.id,
        userId: learner.id,
        type,
        title: draft.subject,
        subject: draft.subject,
        body,
        message: body,
        link: lessonLink(chosen.next_lesson_id),
        source: NUDGE_SOURCE,
        applied_by_agent: true
      };

      // existing deterministic delivery path: inbox + SES email
      await deps.createNotification(payload);
      if (learner.email) {
        await deps.sendEmail({
          to: learner.email,
          subject: draft.subject,
          body,
          text: body,
          template: 'staff_message',
          source: NUDGE_SOURCE,
          applied_by_agent: true
        });
      }

      sent += 1;
      samples.push({
        user_id: learner.id,
        course_id: chosen.course_id,
        course_title: chosen.course_title,
        percent_complete: chosen.percent_complete,
        days_since_last_activity: chosen.days_since_last_activity,
        next_lesson_title: chosen.next_lesson_title,
        subject: draft.subject,
        used_fallback_copy: draft.fallback,
        applied_by_agent: true
      });
      logger.info('reengagement_nudge_sent', {
        user_id: learner.id,
        course_id: chosen.course_id,
        percent_complete: chosen.percent_complete,
        days_since_last_activity: chosen.days_since_last_activity,
        applied_by_agent: true
      });
    } catch (err) {
      logger.error('reengagement_nudge_failed', {
        user_id: learner.id,
        error: err && err.message ? err.message : String(err)
      });
    }
  }

  logger.info('reengagement_agent_run_finished', { sent, considered, cap, flag: FLAG_KEY });
  return { skipped: false, reason: null, sent, considered, samples };
}
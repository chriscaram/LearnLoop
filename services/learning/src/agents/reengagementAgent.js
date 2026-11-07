'use strict';

/**
 * Re-engagement agent (finding find_a431764685ac, NBF-USAGE-ACTOR_INACTIVITY).
 *
 * The model is allowed to do exactly two things:
 *   1. decide            -> nudge now / stay silent, and which ONE eligible course
 *   2. generate_content  -> a subject and a short body
 *
 * Every number, link and lesson name is injected by the deterministic code in
 * services/learning/src/services/progress.js. Drafts that contain digits or
 * links are rejected and replaced by a deterministic template.
 */

const DEFAULT_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const MAX_SUBJECT_CHARS = 90;
const MAX_BODY_CHARS = 420;

async function resolveCredentials() {
  const roleArn = process.env.BEDROCK_ROLE_ARN;
  if (!roleArn) return undefined;

  const { STSClient, AssumeRoleCommand } = require('@aws-sdk/client-sts');
  const sts = new STSClient({ region: process.env.AWS_REGION });
  const out = await sts.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: 'ga-find-a431764685ac',
      DurationSeconds: 900
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

async function buildModel() {
  const { ChatBedrockConverse } = require('@langchain/aws');
  const options = {
    model: process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID,
    region: process.env.AWS_REGION,
    temperature: 0.2,
    maxTokens: 400
  };
  const credentials = await resolveCredentials();
  if (credentials) options.credentials = credentials;
  return new ChatBedrockConverse(options);
}

function messageText(response) {
  if (!response) return '';
  const content = response.content !== undefined ? response.content : response;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part && part.text ? part.text : ''))
      .join('');
  }
  return '';
}

function parseJson(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    return null;
  }
}

function clean(value, maxChars) {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars - 1).trim()}…` : flat;
}

// The model may not produce numbers or links: those are deterministic.
function draftIsSafe(text) {
  if (!text) return false;
  if (/\d/.test(text)) return false;
  if (/https?:|www\.|\/\//i.test(text)) return false;
  return true;
}

function factsFor(candidate) {
  return {
    course_id: candidate.courseId,
    course_title: candidate.courseTitle,
    percent_complete: candidate.percentComplete,
    lessons_completed: candidate.completedLessons,
    lessons_total: candidate.totalLessons,
    days_since_last_activity: candidate.daysSinceLastActivity,
    next_lesson_title: candidate.nextLesson && candidate.nextLesson.title
  };
}

const DECIDE_SYSTEM = [
  'You help an online course platform decide whether to send a learner one re-engagement message.',
  'You receive only activity and progress facts that were computed by the application.',
  'Never invent or recompute a number, a link or a lesson name.',
  'Reply with JSON only: {"action":"nudge"|"skip","course_id":"<one of the given course ids>","reason":"<short>"}.',
  'Choose "skip" when the learner does not look genuinely stalled or a nudge would not help.',
  'If you nudge, pick exactly ONE course: prefer the one closest to completion, then the most recently touched.'
].join(' ');

const DRAFT_SYSTEM = [
  'You draft a short, warm re-engagement message for a learner of an online course platform.',
  'Reply with JSON only: {"subject":"<short subject>","body":"<2-3 short sentences>"}.',
  'Do not include any digit, percentage, URL or lesson title: the application appends those facts itself.',
  'No pressure, no guilt, no marketing claims, no promises about certificates or refunds.'
].join(' ');

async function decideCourse({ learner, candidates, model }) {
  const payload = {
    learner_ref: learner.id,
    courses: candidates.map(factsFor)
  };
  const response = await model.invoke([
    { role: 'system', content: DECIDE_SYSTEM },
    { role: 'user', content: JSON.stringify(payload) }
  ]);
  const parsed = parseJson(messageText(response)) || {};
  if (parsed.action !== 'nudge') {
    return { action: 'skip', reason: clean(parsed.reason, 120) || 'model_skip' };
  }
  const chosen = candidates.find((candidate) => candidate.courseId === parsed.course_id);
  if (!chosen) {
    return { action: 'skip', reason: 'model_course_not_eligible' };
  }
  return { action: 'nudge', candidate: chosen, reason: clean(parsed.reason, 120) || 'model_nudge' };
}

async function draftMessage({ candidate, model }) {
  const response = await model.invoke([
    { role: 'system', content: DRAFT_SYSTEM },
    {
      role: 'user',
      content: JSON.stringify({
        course_title: candidate.courseTitle,
        tone: 'encouraging, one short paragraph',
        note: 'the application appends the exact progress and next lesson'
      })
    }
  ]);
  const parsed = parseJson(messageText(response)) || {};
  const subject = clean(parsed.subject, MAX_SUBJECT_CHARS);
  const body = clean(parsed.body, MAX_BODY_CHARS);
  if (!draftIsSafe(subject) || !draftIsSafe(body)) {
    return {
      subject: `Ready to pick up ${candidate.courseTitle}?`,
      body: 'You made a good start on this course. Here is where you left off, whenever you have a few minutes.',
      fallback: true
    };
  }
  return { subject, body, fallback: false };
}

// Deterministic facts are appended here, never asked of the model.
function composeMessage({ candidate, draft }) {
  const nextLesson = candidate.nextLesson || {};
  const link = nextLesson.id ? `/lessons/${nextLesson.id}` : `/courses/${candidate.courseId}`;
  const facts = [
    `${candidate.courseTitle}: ${candidate.percentComplete}% complete.`,
    nextLesson.title ? `Your next lesson is "${nextLesson.title}".` : null,
    `Continue: ${link}`
  ]
    .filter(Boolean)
    .join(' ');

  return {
    subject: draft.subject,
    body: `${draft.body}\n\n${facts}`,
    link,
    usedFallbackDraft: draft.fallback
  };
}

/**
 * Plan one nudge for one learner. Returns { action: 'skip' } or
 * { action: 'nudge', candidate, message, reason }.
 */
async function planNudge({ learner, candidates, model }) {
  if (!candidates || candidates.length === 0) {
    return { action: 'skip', reason: 'no_eligible_course' };
  }
  const resolved = model || (await buildModel());
  const decision = await decideCourse({ learner, candidates, model: resolved });
  if (decision.action !== 'nudge') return decision;

  const draft = await draftMessage({ candidate: decision.candidate, model: resolved });
  return {
    action: 'nudge',
    candidate: decision.candidate,
    reason: decision.reason,
    message: composeMessage({ candidate: decision.candidate, draft })
  };
}

module.exports = {
  DEFAULT_MODEL_ID,
  MAX_BODY_CHARS,
  MAX_SUBJECT_CHARS,
  buildModel,
  composeMessage,
  draftMessage,
  decideCourse,
  planNudge
};
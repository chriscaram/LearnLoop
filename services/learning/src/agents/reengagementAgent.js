/**
 * Re-engagement nudge agent (finding find_a431764685ac, NBF-USAGE-ACTOR_INACTIVITY).
 *
 * The model is allowed to do exactly two things:
 *   1. decide    - pick "nudge now" vs "stay silent", and which ONE eligible course.
 *   2. generate  - draft a short subject + body.
 *
 * Every number, link, course title and lesson title is supplied by the existing
 * deterministic code (services/learning/src/services/progress.js) and is injected
 * into the message by the job, never computed or rewritten by the model.
 */

const DEFAULT_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

const MAX_SUBJECT_CHARS = 120;
const MAX_BODY_CHARS = 600;

async function bedrockCredentials() {
  const roleArn = process.env.BEDROCK_ROLE_ARN;
  if (!roleArn) return undefined;

  const { STSClient, AssumeRoleCommand } = await import('@aws-sdk/client-sts');
  const sts = new STSClient({ region: process.env.AWS_REGION });
  const out = await sts.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: 'learnloop-reengagement-agent',
      DurationSeconds: 900
    })
  );
  const c = out && out.Credentials;
  if (!c) throw new Error('assume_role_returned_no_credentials');
  return {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretAccessKey,
    sessionToken: c.SessionToken
  };
}

/** Build the LangChain.js Bedrock chat model. */
export async function createNudgeModel() {
  const { ChatBedrockConverse } = await import('@langchain/aws');
  const credentials = await bedrockCredentials();
  return new ChatBedrockConverse({
    model: process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID,
    region: process.env.AWS_REGION,
    temperature: 0.2,
    maxTokens: 400,
    ...(credentials ? { credentials } : {})
  });
}

function textOf(response) {
  if (response == null) return '';
  if (typeof response === 'string') return response;
  const content = response.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part && part.text ? part.text : ''))
      .join('');
  }
  return '';
}

function parseJson(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function clamp(value, max) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/**
 * llm_part #1 (decide).
 *
 * @param {object} args
 * @param {object} args.model        chat model with .invoke()
 * @param {Array}  args.candidates   deterministic facts only, one entry per eligible course
 * @param {number} args.daysSinceLastNudge  null when never nudged
 * @returns {Promise<{nudge: boolean, courseId: string|null, reason: string}>}
 */
export async function decideNudge({ model, candidates, daysSinceLastNudge }) {
  const facts = (candidates || []).map((c) => ({
    courseId: c.courseId,
    courseTitle: c.courseTitle,
    percentComplete: c.percentComplete,
    lessonsCompleted: c.lessonsCompleted,
    lessonsTotal: c.lessonsTotal,
    lessonsRemaining: c.lessonsRemaining,
    daysSinceLastActivity: c.daysSinceLastActivity
  }));

  const prompt = [
    'You help an online course platform decide whether to send one short re-engagement message.',
    'You may only choose; you may never compute or change any number, link or lesson name.',
    'Stay silent unless the learner looks genuinely stalled and a nudge is likely to help.',
    'Prefer the course closest to completion, or the most recently touched one.',
    '',
    `Days since this learner last received a nudge: ${
      daysSinceLastNudge == null ? 'never' : daysSinceLastNudge
    }`,
    'Eligible courses (deterministic facts):',
    JSON.stringify(facts),
    '',
    'Answer with JSON only: {"nudge": true|false, "courseId": "<one id from the list or null>", "reason": "<short>"}'
  ].join('\n');

  const parsed = parseJson(textOf(await model.invoke(prompt)));
  if (!parsed || parsed.nudge !== true) {
    return { nudge: false, courseId: null, reason: clamp(parsed && parsed.reason, 200) || 'model_declined' };
  }
  return {
    nudge: true,
    courseId: parsed.courseId == null ? null : String(parsed.courseId),
    reason: clamp(parsed.reason, 200) || 'model_selected'
  };
}

/**
 * llm_part #2 (generate_content). Returns text only; the job appends the
 * deterministic fact line (percent, next lesson title, link).
 */
export async function draftNudgeMessage({ model, course, learnerName }) {
  const prompt = [
    'Write a short, warm re-engagement message for a learner who paused a course.',
    'Rules: no numbers, no percentages, no URLs, no lesson titles you invent.',
    'Two sentences maximum in the body. No greeting line other than the first name. No sign-off.',
    '',
    `Learner first name: ${learnerName || 'there'}`,
    `Course title (quote exactly if you mention it): ${course.courseTitle}`,
    `Next lesson title (quote exactly if you mention it): ${course.nextLessonTitle}`,
    '',
    'Answer with JSON only: {"subject": "<max 10 words>", "body": "<max 2 sentences>"}'
  ].join('\n');

  const parsed = parseJson(textOf(await model.invoke(prompt))) || {};
  const subject = clamp(parsed.subject, MAX_SUBJECT_CHARS) || `Pick up ${course.courseTitle} where you left off`;
  const body = clamp(parsed.body, MAX_BODY_CHARS) || `You still have a little way to go in ${course.courseTitle}.`;
  return { subject, body };
}

/**
 * Deterministic fact line. The only place percent / lesson title / link appear.
 */
export function factLine(course) {
  const parts = [
    `${course.courseTitle}: ${course.percentComplete}% complete.`,
    `Next lesson: ${course.nextLessonTitle}.`
  ];
  if (course.nextLessonUrl) parts.push(`Continue: ${course.nextLessonUrl}`);
  return parts.join(' ');
}

/** Compose the final message from model text + deterministic facts. */
export function composeMessage({ drafted, course }) {
  return {
    subject: clamp(drafted.subject, MAX_SUBJECT_CHARS),
    body: clamp(`${drafted.body}\n\n${factLine(course)}`, MAX_BODY_CHARS + 200)
  };
}

export const AGENT_LIMITS = { MAX_SUBJECT_CHARS, MAX_BODY_CHARS };
// Lapsed-learner nudge agent (LangChain.js + Amazon Bedrock).
//
// The model does exactly two things: it decides which of the candidates the
// job already qualified deserve a nudge now (and which enrolled course to
// feature), and it drafts the short subject and body. Every number it sees -
// days inactive, percent complete, lesson counts, the next lesson - is
// computed by services/progress.js and passed in read-only. Anything the model
// returns that is not in the candidate list is dropped here.
import { ChatBedrockConverse } from '@langchain/aws';
import { logWarn } from '@learnloop/shared/logger';

export const DEFAULT_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
export const MAX_SUBJECT_CHARS = 120;
export const MAX_BODY_CHARS = 600;

/** Temporary credentials for BEDROCK_ROLE_ARN; otherwise the default chain is used. */
async function assumedCredentials(roleArn) {
  const { STSClient, AssumeRoleCommand } = await import('@aws-sdk/client-sts');
  const out = await new STSClient({}).send(new AssumeRoleCommand({
    RoleArn: roleArn,
    RoleSessionName: 'learnloop-lapsed-nudge',
  }));
  const c = out.Credentials;
  return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken };
}

export async function createModel() {
  const roleArn = process.env.BEDROCK_ROLE_ARN;
  return new ChatBedrockConverse({
    model: process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID,
    region: process.env.AWS_REGION,
    temperature: 0.2,
    maxTokens: 8192,
    ...(roleArn ? { credentials: await assumedCredentials(roleArn) } : {}),
  });
}

const SYSTEM_PROMPT = [
  'You help an online course platform restart learners who stopped taking lessons.',
  'You receive a JSON list of candidates. Every fact in it was computed by the platform:',
  'daysInactive, percentComplete, completedLessons, totalLessons, lastLessonTitle, nextLessonTitle.',
  'Never recalculate, invent or restate a different number, date or threshold.',
  'Never mention a learner, course or lesson that is not in the list.',
  'For each candidate decide whether one short nudge now is genuinely useful, and if so pick',
  'exactly one of that candidate\'s courses to feature (prefer the one closest to finishing).',
  'Write a specific, warm, factual message naming the course title and the next lesson title.',
  'Do not add links, discounts, deadlines, promises or any personal detail.',
  `Subject: at most ${MAX_SUBJECT_CHARS} characters. Body: at most ${MAX_BODY_CHARS} characters, 2-3 sentences.`,
  'Answer with JSON only, no prose and no code fences, in the form:',
  '[{"userId":"...","courseId":"...","send":true,"subject":"...","body":"..."}]',
].join('\n');

export function buildPrompt(candidates) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify({ candidates }, null, 2) },
  ];
}

/** Text of a LangChain response, whether content is a string or content blocks. */
export function textOf(response) {
  const content = response?.content ?? response;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('');
  return '';
}

/** Tolerant JSON extraction: array, or an object with a `nudges` array. */
export function parseDecisions(text) {
  const cleaned = String(text ?? '').replace(/```[a-z]*/gi, '').trim();
  const slice = (open, close) => {
    const start = cleaned.indexOf(open);
    const end = cleaned.lastIndexOf(close);
    return start === -1 || end <= start ? null : cleaned.slice(start, end + 1);
  };
  for (const raw of [slice('[', ']'), slice('{', '}')]) {
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed?.nudges)) return parsed.nudges;
    } catch {
      // try the next shape
    }
  }
  return [];
}

function clean(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Keeps only decisions that point at a candidate and one of its own courses,
 * and returns them in the candidates' risk order (most at risk first).
 */
export function normaliseDecisions(decisions, candidates) {
  const byUser = new Map(candidates.map((c) => [c.userId, c]));
  const chosen = new Map();
  for (const decision of Array.isArray(decisions) ? decisions : []) {
    const candidate = byUser.get(decision?.userId);
    if (!candidate || chosen.has(candidate.userId)) continue;
    if (decision?.send === false) continue;
    const course = candidate.courses.find((c) => c.courseId === decision?.courseId);
    if (!course) continue;
    const subject = clean(decision?.subject, MAX_SUBJECT_CHARS);
    const body = clean(decision?.body, MAX_BODY_CHARS);
    if (!subject || !body) continue;
    chosen.set(candidate.userId, { userId: candidate.userId, courseId: course.courseId, subject, body });
  }
  return candidates.map((c) => chosen.get(c.userId)).filter(Boolean);
}

/**
 * One batched model call for the whole candidate list. Never throws: a model
 * problem means no nudges this run.
 */
export async function planNudges(candidates, { model } = {}) {
  if (!candidates || candidates.length === 0) return [];
  try {
    const client = model ?? (await createModel());
    const response = await client.invoke(buildPrompt(candidates));
    return normaliseDecisions(parseDecisions(textOf(response)), candidates);
  } catch (error) {
    logWarn('lapsed-learner nudge model call failed', { errorType: error?.name ?? 'Error' });
    return [];
  }
}
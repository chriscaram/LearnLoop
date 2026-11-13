// Re-engagement nudge agent (feature flag "ga-find_a431764685ac").
//
// The model does exactly two things: it decides whether a stalled learner
// should be nudged now and which single course to nudge about, and it drafts
// the subject and short body of that message. Every number, course title,
// lesson title and link in the message comes from the deterministic progress
// functions in ../services/progress.js — sanitiseDraft() removes any digit,
// percentage or URL the model produced, so it cannot invent one.
import { ChatBedrockConverse } from '@langchain/aws';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';

export const DEFAULT_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
export const FALLBACK_SUBJECT = 'Pick up where you left off';
export const FALLBACK_BODY = 'You started a course on LearnLoop and have not been back for a while. Your progress is saved, so you can carry on from your next lesson whenever you have a few minutes.';

const DECIDE_PROMPT = [
  'You help an online course platform re-engage learners who stopped mid-course.',
  'You are given only activity and progress facts that the application already computed.',
  'Choose whether to send one short nudge now, and if so which single course it should be about.',
  'Prefer the course closest to completion or most recently touched. Stay silent when the learner looks likely to return on their own.',
  'Never invent courses, lessons, numbers or links.',
  'Answer with JSON only: {"nudge": true|false, "courseId": "<one of the given courseId values or null>", "reason": "<short>"}',
].join(' ');

const DRAFT_PROMPT = [
  'Write a short, warm re-engagement message for one learner of an online course platform.',
  'Two to three sentences, friendly, no pressure, no marketing claims, no greeting line with a name.',
  'Do NOT write any number, percentage, lesson number, date or link: the application appends the exact progress figures and the lesson link itself.',
  'Answer with JSON only: {"subject": "<max 80 characters>", "body": "<max 400 characters>"}',
].join(' ');

async function temporaryCredentials(roleArn) {
  const out = await new STSClient({}).send(new AssumeRoleCommand({
    RoleArn: roleArn,
    RoleSessionName: 'learnloop-reengagement-agent',
    DurationSeconds: 3600,
  }));
  return {
    accessKeyId: out.Credentials.AccessKeyId,
    secretAccessKey: out.Credentials.SecretAccessKey,
    sessionToken: out.Credentials.SessionToken,
  };
}

/** Bedrock chat model through LangChain. Default credential chain unless BEDROCK_ROLE_ARN is set. */
export async function buildModel() {
  const roleArn = process.env.BEDROCK_ROLE_ARN;
  return new ChatBedrockConverse({
    model: process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID,
    region: process.env.AWS_REGION,
    temperature: 0,
    maxTokens: 400,
    ...(roleArn ? { credentials: await temporaryCredentials(roleArn) } : {}),
  });
}

export function textOf(response) {
  const content = response?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('');
  return '';
}

/** First JSON object in the model's answer, or null. */
export function parseJsonObject(text) {
  const match = /\{[\s\S]*\}/.exec(String(text ?? ''));
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const stripNumbersAndLinks = (text) => String(text ?? '')
  .replace(/https?:\/\/\S+/gi, ' ')
  .replace(/\/[a-z0-9/_-]*\b/gi, ' ')
  .replace(/\d+\s*%?/g, ' ')
  .replace(/\s+([.,!?])/g, '$1')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * The only text that reaches a learner from the model: no digits, no links.
 * Empty or unusable drafts fall back to fixed copy.
 */
export function sanitiseDraft(draft) {
  const subject = stripNumbersAndLinks(draft?.subject).slice(0, 120);
  const body = stripNumbersAndLinks(draft?.body).slice(0, 600);
  return {
    subject: subject.length >= 8 ? subject : FALLBACK_SUBJECT,
    body: body.length >= 20 ? body : FALLBACK_BODY,
  };
}

async function ask(model, system, facts) {
  const response = await model.invoke([
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify(facts) },
  ]);
  return parseJsonObject(textOf(response));
}

/** decide: nudge-now / skip and which course. draft: subject and body. */
export function createNudgeAgent() {
  let model = null;
  const get = async () => {
    model ??= await buildModel();
    return model;
  };
  return {
    async decide(facts) {
      const answer = await ask(await get(), DECIDE_PROMPT, facts);
      return {
        nudge: answer?.nudge === true,
        courseId: typeof answer?.courseId === 'string' ? answer.courseId : null,
      };
    },
    async draft(facts) {
      return sanitiseDraft(await ask(await get(), DRAFT_PROMPT, facts));
    },
  };
}
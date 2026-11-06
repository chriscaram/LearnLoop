/**
 * LangChain.js model wiring for the re-engagement agent.
 *
 * The model has exactly two jobs (the blueprint's llm_parts):
 *   decide          -> nudge now / skip, and which single course
 *   draft           -> subject + short body text
 *
 * It is never asked for a number, a link or a lesson name: those are injected
 * by the deterministic learning-service functions and validated afterwards.
 */

import { ChatBedrockConverse } from '@langchain/aws';

const DEFAULT_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

async function temporaryCredentials() {
  const roleArn = process.env.BEDROCK_ROLE_ARN;
  if (!roleArn) return undefined;
  const { STSClient, AssumeRoleCommand } = await import('@aws-sdk/client-sts');
  const sts = new STSClient({ region: process.env.AWS_REGION });
  const out = await sts.send(
    new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: 'reengagement-agent' })
  );
  const c = out.Credentials;
  if (!c) throw new Error('assume_role_returned_no_credentials');
  return {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretAccessKey,
    sessionToken: c.SessionToken
  };
}

/** Builds the chat model. Default AWS credential chain unless BEDROCK_ROLE_ARN is set. */
export async function createChatModel() {
  const credentials = await temporaryCredentials();
  return new ChatBedrockConverse({
    model: process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID,
    region: process.env.AWS_REGION,
    temperature: 0.2,
    maxTokens: 400,
    ...(credentials ? { credentials } : {})
  });
}

function textOf(response) {
  if (!response) return '';
  const content = response.content ?? response;
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
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

const DECIDE_PROMPT = [
  'You help an online course platform decide whether to send one re-engagement nudge.',
  'You are given only activity and progress facts already computed by the application.',
  'Do not compute, change or invent any number, link or lesson name.',
  'Choose to nudge only if the learner looks genuinely stalled and a nudge is likely useful,',
  'and then choose exactly one course_id from the candidates (prefer the one closest to',
  'completion, then the most recently touched). Otherwise skip.',
  'Reply with JSON only: {"action":"nudge"|"skip","course_id":string|null,"reason":string}'
].join(' ');

const DRAFT_PROMPT = [
  'Write a short, warm re-engagement message for one learner of an online course platform.',
  'Use at most 2 sentences in the body, no numbers, no percentages, no URLs, no placeholders.',
  'Do not repeat the figures given to you; the application appends the exact progress facts itself.',
  'You may refer to the course by its title. No greeting line with a fake name.',
  'Reply with JSON only: {"subject":string,"body":string}'
].join(' ');

/** Wraps a chat model into the two llm_parts the blueprint allows. */
export function makeLlm(model) {
  return {
    async decide(facts) {
      const response = await model.invoke([
        { role: 'system', content: DECIDE_PROMPT },
        { role: 'user', content: JSON.stringify(facts) }
      ]);
      return parseJson(textOf(response));
    },
    async draft(facts) {
      const response = await model.invoke([
        { role: 'system', content: DRAFT_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            course_title: facts.course_title,
            next_lesson_title: facts.next_lesson_title
          })
        }
      ]);
      return parseJson(textOf(response));
    }
  };
}

export async function createLlm() {
  return makeLlm(await createChatModel());
}
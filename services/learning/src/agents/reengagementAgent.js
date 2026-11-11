// Re-engagement agent (finding find_a431764685ac, NBF-USAGE-ACTOR_INACTIVITY).
//
// The model does exactly two things: it decides whether a stalled learner
// should be nudged now and which single course to nudge about, and it drafts
// the subject and body. Every fact it sees - stall days, completion percent,
// lesson counts, lesson titles - is computed by services/progress.js and
// passed in; the job re-injects those values into the final message, so the
// model can never produce a number, a link or a lesson name.
//
// Credentials come from the default AWS credential chain. When
// BEDROCK_ROLE_ARN is set the role is assumed through STS first and the
// temporary credentials are handed to the model client.
import { ChatBedrockConverse } from '@langchain/aws';

export const DEFAULT_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

export const SYSTEM_PROMPT = [
  'You help an online course platform re-engage learners who started a course and stopped.',
  'You receive JSON facts that were computed by the application: days since the learner\'s last lesson activity,',
  'and for each started-but-unfinished course its id, title, completion percent, lesson counts and the exact title of the next lesson.',
  'Decide whether a nudge is worth sending now and, if so, which single course to nudge about',
  '(prefer the course closest to completion, or the most recently touched one).',
  'Then draft a warm, short message: at most two sentences, friendly, no pressure, no discount or promise.',
  'Rules: never invent or restate numbers, percentages, dates, URLs or lesson titles - the application appends those itself.',
  'Answer with JSON only, no prose, in the form',
  '{"action":"nudge"|"skip","courseId":"<one of the given course ids or null>","subject":"<short subject>","body":"<short body>"}.',
].join(' ');

async function temporaryCredentials() {
  const roleArn = process.env.BEDROCK_ROLE_ARN;
  if (!roleArn) return null;
  const { STSClient, AssumeRoleCommand } = await import('@aws-sdk/client-sts');
  const out = await new STSClient({}).send(new AssumeRoleCommand({
    RoleArn: roleArn,
    RoleSessionName: 'learnloop-reengagement-agent',
    DurationSeconds: 900,
  }));
  const credentials = out.Credentials;
  if (!credentials) return null;
  return {
    accessKeyId: credentials.AccessKeyId,
    secretAccessKey: credentials.SecretAccessKey,
    sessionToken: credentials.SessionToken,
  };
}

/** The Bedrock chat model, through LangChain. No secrets in code or config. */
export async function buildModel() {
  const credentials = await temporaryCredentials();
  return new ChatBedrockConverse({
    model: process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID,
    region: process.env.AWS_REGION,
    temperature: 0.2,
    maxTokens: 400,
    ...(credentials ? { credentials } : {}),
  });
}

function textOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('');
  return '';
}

/** First JSON object in the model's answer, or null. */
export function parseDraft(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * agent.planNudge(facts) -> { action: 'nudge'|'skip', courseId, subject, body }
 * The model client is built on first use so nothing talks to AWS while the
 * feature flag is off.
 */
export function createReengagementAgent({ model = null } = {}) {
  let chat = model;
  return {
    async planNudge(facts) {
      chat ??= await buildModel();
      const answer = await chat.invoke([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(facts) },
      ]);
      const draft = parseDraft(textOf(answer));
      if (!draft) return { action: 'skip' };
      return {
        action: draft.action === 'nudge' ? 'nudge' : 'skip',
        courseId: typeof draft.courseId === 'string' ? draft.courseId : null,
        subject: draft.subject,
        body: draft.body,
      };
    },
  };
}
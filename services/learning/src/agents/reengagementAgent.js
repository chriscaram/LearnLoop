import { ChatBedrockConverse } from "@langchain/aws";

const DEFAULT_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

const SYSTEM_PROMPT = [
  "You help an online course platform re-engage learners who stalled mid-course.",
  "You are given ONLY deterministic facts already computed by the application:",
  "for each candidate course the course title, the completion percent, lessons remaining,",
  "the title of the learner's next uncompleted lesson, whole days since their last lesson activity,",
  "and whether they were nudged before.",
  "",
  "Decide one of two things:",
  '- {"action":"skip"} when the learner is not genuinely stalled, has resumed, or a message would not help.',
  '- {"action":"nudge","courseId":"<one of the candidate course ids>","subject":"...","body":"..."}',
  "",
  "Rules you must respect:",
  "- Choose at most ONE course, normally the one closest to completion.",
  "- Never state, compute, re-phrase or alter any number, percentage, date, lesson name or link.",
  "  The application appends the exact percent, next lesson title and link itself.",
  "- The body is at most three short sentences of encouragement, warm and plain, no numbers.",
  "- Reply with a single JSON object and nothing else.",
].join("\n");

let cachedModel = null;

async function temporaryCredentials() {
  const roleArn = process.env.BEDROCK_ROLE_ARN;
  if (!roleArn) return undefined;
  const { STSClient, AssumeRoleCommand } = await import("@aws-sdk/client-sts");
  const sts = new STSClient({ region: process.env.AWS_REGION });
  const result = await sts.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: "ga-reengagement-agent",
      DurationSeconds: 3600,
    }),
  );
  const creds = result && result.Credentials;
  if (!creds) return undefined;
  return {
    accessKeyId: creds.AccessKeyId,
    secretAccessKey: creds.SecretAccessKey,
    sessionToken: creds.SessionToken,
  };
}

export async function createModel() {
  const credentials = await temporaryCredentials();
  return new ChatBedrockConverse({
    model: process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID,
    region: process.env.AWS_REGION,
    temperature: 0.2,
    maxTokens: 400,
    ...(credentials ? { credentials } : {}),
  });
}

function responseText(response) {
  if (!response) return "";
  const content = typeof response === "string" ? response : response.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part && part.text ? part.text : ""))
      .join("");
  }
  if (response.text) return String(response.text);
  return "";
}

export function parseDecision(response, facts) {
  const text = responseText(response);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return { action: "skip", reason: "unparsable_model_output" };
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    return { action: "skip", reason: "unparsable_model_output" };
  }
  if (!parsed || parsed.action !== "nudge") return { action: "skip", reason: "model_chose_skip" };
  const allowed = (facts && Array.isArray(facts.candidates) ? facts.candidates : []).map(
    (candidate) => candidate.courseId,
  );
  const courseId = String(parsed.courseId || "");
  if (!allowed.includes(courseId)) return { action: "skip", reason: "model_course_not_eligible" };
  return {
    action: "nudge",
    courseId,
    subject: typeof parsed.subject === "string" ? parsed.subject : "",
    body: typeof parsed.body === "string" ? parsed.body : "",
  };
}

export async function decideNudge(facts, options = {}) {
  const model = options.model || cachedModel || (cachedModel = await createModel());
  const response = await model.invoke([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify(facts) },
  ]);
  return parseDecision(response, facts);
}

export function resetModelCache() {
  cachedModel = null;
}
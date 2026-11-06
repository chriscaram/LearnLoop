import { ChatBedrockConverse } from "@langchain/aws";

const DEFAULT_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const SESSION_NAME = "ga-find-a431764685ac";

/**
 * Re-engagement agent model wrapper.
 *
 * The model is allowed to do exactly two things (blueprint llm_parts):
 *  - decide: nudge now / stay silent, and which single course to nudge about
 *  - draft:  subject + short body wording, using {course} {percent} {lesson} placeholders
 *
 * It never produces a number, a link or a lesson title: callers substitute the
 * deterministic values computed by services/learning/src/services/progress.js.
 */

async function resolveCredentials() {
  const roleArn = process.env.BEDROCK_ROLE_ARN;
  if (!roleArn) return undefined;

  const { STSClient, AssumeRoleCommand } = await import("@aws-sdk/client-sts");
  const sts = new STSClient({ region: process.env.AWS_REGION });
  const assumed = await sts.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: SESSION_NAME,
      DurationSeconds: 900
    })
  );

  const creds = assumed && assumed.Credentials;
  if (!creds) return undefined;

  return {
    accessKeyId: creds.AccessKeyId,
    secretAccessKey: creds.SecretAccessKey,
    sessionToken: creds.SessionToken
  };
}

export async function createModel() {
  const credentials = await resolveCredentials();

  return new ChatBedrockConverse({
    model: process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID,
    region: process.env.AWS_REGION,
    temperature: 0.2,
    maxTokens: 400,
    ...(credentials ? { credentials } : {})
  });
}

function textOf(response) {
  if (!response) return "";
  if (typeof response === "string") return response;
  const content = response.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part && part.text ? part.text : ""))
      .join("");
  }
  return "";
}

function parseJson(raw) {
  const text = String(raw || "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

const DECIDE_SYSTEM = [
  "You help an online course platform decide whether to send one re-engagement nudge.",
  "You are given only activity and progress facts already computed by the application.",
  "Never compute, invent or restate numbers. Choose at most ONE course.",
  "Prefer staying silent when the learner looks active again, barely started, or was nudged recently.",
  'Reply with JSON only: {"action":"nudge"|"skip","courseId":"<id or null>","reason":"<short>"}'
].join(" ");

const DRAFT_SYSTEM = [
  "You write one very short, warm re-engagement message for a learner of an online course platform.",
  "Use the placeholders {course}, {percent} and {lesson} where the course title, completion percent and next lesson title belong.",
  "Do not write any digit, URL or lesson name yourself: the application substitutes them.",
  "Body: at most 3 short sentences, no greeting beyond a first name, no pressure, no promises.",
  'Reply with JSON only: {"subject":"<max 80 chars>","body":"<max 400 chars>"}'
].join(" ");

/**
 * @param {object} model a LangChain chat model (mocked in tests)
 */
export function createReengagementAgent(model) {
  return {
    async decide(facts) {
      const response = await model.invoke([
        { role: "system", content: DECIDE_SYSTEM },
        { role: "user", content: JSON.stringify(facts) }
      ]);
      const parsed = parseJson(textOf(response));
      if (!parsed || parsed.action !== "nudge") {
        return { action: "skip", courseId: null, reason: (parsed && parsed.reason) || "model_skip" };
      }
      return {
        action: "nudge",
        courseId: parsed.courseId == null ? null : String(parsed.courseId),
        reason: String(parsed.reason || "model_nudge").slice(0, 200)
      };
    },

    async draft(facts) {
      const response = await model.invoke([
        { role: "system", content: DRAFT_SYSTEM },
        { role: "user", content: JSON.stringify(facts) }
      ]);
      const parsed = parseJson(textOf(response));
      if (!parsed || !parsed.subject || !parsed.body) return null;
      return {
        subject: String(parsed.subject).slice(0, 120),
        body: String(parsed.body).slice(0, 600)
      };
    }
  };
}

export async function createDefaultReengagementAgent() {
  return createReengagementAgent(await createModel());
}
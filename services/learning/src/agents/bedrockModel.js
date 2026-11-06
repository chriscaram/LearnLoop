// LangChain.js model factory for the re-engagement agent.
// Amazon Bedrock is reached only through the framework; credentials come from
// the default AWS credential chain, or from STS when BEDROCK_ROLE_ARN is set.

import { ChatBedrockConverse } from "@langchain/aws";

const DEFAULT_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

export async function createReengagementModel(overrides = {}) {
  const config = {
    model: process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID,
    region: process.env.AWS_REGION,
    temperature: 0,
    maxTokens: 400,
    ...overrides,
  };

  const roleArn = process.env.BEDROCK_ROLE_ARN;
  if (roleArn) {
    const { STSClient, AssumeRoleCommand } = await import("@aws-sdk/client-sts");
    const sts = new STSClient({ region: process.env.AWS_REGION });
    const assumed = await sts.send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: "learnloop-reengagement-agent",
        DurationSeconds: 900,
      })
    );
    const creds = assumed && assumed.Credentials;
    if (creds) {
      config.credentials = {
        accessKeyId: creds.AccessKeyId,
        secretAccessKey: creds.SecretAccessKey,
        sessionToken: creds.SessionToken,
      };
    }
  }

  return new ChatBedrockConverse(config);
}

export default { createReengagementModel };
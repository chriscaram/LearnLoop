// Where the operator tools act: the stack named by LEARNLOOP_STACK
// (LearnLoopProd by default; LearnLoopStaging for staging). Every name the
// tools need comes from that stack's outputs, the same values the deployed
// functions receive in their environment.
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

export const region = process.env.AWS_REGION ?? 'us-east-1';
export const DEFAULT_STACK = 'LearnLoopProd';

/** The stack the tools act on: LEARNLOOP_STACK, else LearnLoopProd. */
export function stackName(env = process.env) {
  const name = env.LEARNLOOP_STACK?.trim() || DEFAULT_STACK;
  if (!/^LearnLoop[A-Za-z0-9]+$/.test(name)) throw new TypeError(`LEARNLOOP_STACK is not a LearnLoop stack name: ${name}`);
  return name;
}

/** The value of one output of the stack; throws if the stack has no such output. */
export async function stackOutput(key, { name = stackName(), client = new CloudFormationClient({ region }) } = {}) {
  const out = await client.send(new DescribeStacksCommand({ StackName: name }));
  const output = out.Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === key);
  if (!output) throw new Error(`stack ${name} has no output ${key}`);
  return output.OutputValue;
}

/** The state bucket: STATE_BUCKET, else the StateBucketName output of the stack. */
export async function stateBucket(options = {}) {
  if (process.env.STATE_BUCKET) return process.env.STATE_BUCKET;
  return stackOutput('StateBucketName', options);
}

/**
 * The feature-flag parameter: FLAGS_PARAMETER; else, when LEARNLOOP_STACK is set,
 * the FeatureFlagsParameter output of that stack; else undefined, which leaves the
 * shared default (the prod parameter) in place.
 */
export async function flagsParameter(options = {}, env = process.env) {
  if (env.FLAGS_PARAMETER) return env.FLAGS_PARAMETER;
  if (!env.LEARNLOOP_STACK?.trim()) return undefined;
  return stackOutput('FeatureFlagsParameter', { name: stackName(env), ...options });
}

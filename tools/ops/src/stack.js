import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

export const region = process.env.AWS_REGION ?? 'us-east-1';

/** The state bucket: STATE_BUCKET, else the StateBucketName output of the stack. */
export async function stateBucket() {
  if (process.env.STATE_BUCKET) return process.env.STATE_BUCKET;
  const cf = new CloudFormationClient({ region });
  const out = await cf.send(new DescribeStacksCommand({ StackName: process.env.LEARNLOOP_STACK ?? 'LearnLoopProd' }));
  return out.Stacks[0].Outputs.find((o) => o.OutputKey === 'StateBucketName').OutputValue;
}

#!/usr/bin/env node
// npm run state:reset
// Restores the state bucket from data/seed/*.json. Lambdas pick the change up on
// their next read (the S3 ETags change, so cached copies are refreshed).
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { stateObjects } from './state.js';

const region = process.env.AWS_REGION ?? 'us-east-1';

async function stateBucket() {
  if (process.env.STATE_BUCKET) return process.env.STATE_BUCKET;
  const cf = new CloudFormationClient({ region });
  const out = await cf.send(new DescribeStacksCommand({ StackName: process.env.LEARNLOOP_STACK ?? 'LearnLoopProd' }));
  return out.Stacks[0].Outputs.find((o) => o.OutputKey === 'StateBucketName').OutputValue;
}

const bucket = await stateBucket();
const s3 = new S3Client({ region });
for (const [key, body] of await stateObjects()) {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'application/json' }));
  console.log(`state:reset: s3://${bucket}/${key}`);
}

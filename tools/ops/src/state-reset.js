#!/usr/bin/env node
// npm run state:reset
// Restores the state bucket from data/seed/*.json. Lambdas pick the change up on
// their next read (the S3 ETags change, so cached copies are refreshed).
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { region, stateBucket } from './stack.js';
import { stateObjects } from './state.js';

const bucket = await stateBucket();
const s3 = new S3Client({ region });
for (const [key, body] of await stateObjects()) {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'application/json' }));
  console.log(`state:reset: s3://${bucket}/${key}`);
}

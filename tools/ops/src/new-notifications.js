#!/usr/bin/env node
// npm run notifications:since -- <since ISO time> [--json]
// Lists the notifications created at or after <since> in the deployed state
// bucket, with the recipient's demo email, so an operator can see whom a job
// messaged and sign in as one of them. Runs with the operator's AWS
// credentials; the preview workflow only uses the counts (--json).
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { pathToFileURL } from 'node:url';
import { region, stateBucket } from './stack.js';

/** Notifications created at or after `since`, oldest first, joined with their recipient. */
export function newNotifications(notifications, users, since) {
  const sinceMs = new Date(since).getTime();
  if (Number.isNaN(sinceMs)) throw new TypeError(`invalid time: ${since}`);
  const byId = new Map(users.map((u) => [u.id, u]));
  return notifications
    .filter((n) => new Date(n.created_at).getTime() >= sinceMs)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((n) => ({
      email: byId.get(n.user_id)?.email ?? null,
      name: byId.get(n.user_id)?.name ?? null,
      type: n.type,
      title: n.title,
      appliedByAgent: n.applied_by_agent === true,
      createdAt: n.created_at,
    }));
}

async function readDomain(s3, bucket, domain) {
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: `state/${domain}.json` }));
  return JSON.parse(await out.Body.transformToString());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const since = args.find((a) => a !== '--json');
  if (!since) {
    console.error('Usage: npm run notifications:since -- <since ISO time> [--json]');
    process.exit(2);
  }
  const bucket = await stateBucket();
  const s3 = new S3Client({ region });
  const [notifications, users] = await Promise.all([readDomain(s3, bucket, 'notifications'), readDomain(s3, bucket, 'users')]);
  const rows = newNotifications(notifications, users, since);
  if (json) {
    process.stdout.write(`${JSON.stringify(rows)}\n`);
  } else {
    for (const r of rows) console.log([r.createdAt, r.email ?? '(unknown user)', r.appliedByAgent ? 'agent' : '-', r.title].join('\t'));
    console.log(`${rows.length} notification(s) since ${since}`);
  }
}

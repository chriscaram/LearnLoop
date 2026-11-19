import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ENVIRONMENTS, LearnLoopStack } from '../lib/learnloop-stack.js';
import { SERVICES } from '../lib/services.js';

// log-and-record-locations.json (repository root) tells tooling that reads LearnLoop's
// operational data where the application-log history and the state documents are. It names
// buckets by their construct id, so the same file holds for prod and staging. These checks
// keep it true as the stack changes.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const file = JSON.parse(readFileSync(path.join(HERE, '../../log-and-record-locations.json'), 'utf8'));
const outdir = mkdtempSync(path.join(tmpdir(), 'learnloop-cdk-'));
const app = new App({ outdir, context: { 'aws:cdk:bundling-stacks': [] } });
const stack = new LearnLoopStack(app, ENVIRONMENTS.prod.stackName, { env: { account: '123456789012', region: 'us-east-1' }, appVersion: 'a1b2c3d' });
const resources = Template.fromStack(stack).toJSON().Resources as Record<string, { Type: string }>;
const bucketIds = Object.entries(resources).filter(([, r]) => r.Type === 'AWS::S3::Bucket').map(([id]) => id);
const bucketOf = (constructId: string) => bucketIds.filter((id) => id === constructId || new RegExp(`^${constructId}[0-9A-F]{8}$`).test(id));

test('version 1, with only the sections the format defines', () => {
  assert.equal(file.version, 1);
  assert.deepEqual(Object.keys(file).sort(), ['application_logs', 'application_records', 'version']);
});

test('each named bucket is exactly one bucket of the stack', () => {
  for (const name of [...file.application_logs.map((l: any) => l.bucket.infrastructure_name), file.application_records.bucket.infrastructure_name]) {
    assert.equal(bucketOf(name).length, 1, name);
  }
});

test('the log history lists every service, in the layout the services write', () => {
  const [logs] = file.application_logs;
  assert.deepEqual([...logs.services].sort(), Object.keys(SERVICES).sort());
  assert.equal(logs.layout, 'service={service}/dt={date}/');
  assert.equal(logs.format, 'json_lines');
});

test('the records are the state documents the services read', () => {
  const store = readFileSync(path.join(HERE, '../../packages/shared/src/store.js'), 'utf8');
  assert.match(store, new RegExp(`\\$STATE_BUCKET/${file.application_records.prefix}<domain>\\.json`));
});

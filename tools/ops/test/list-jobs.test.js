import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../src/list-jobs.js', import.meta.url));
const listJobs = (root) => JSON.parse(execFileSync(process.execPath, [script, root], { encoding: 'utf8' }));

test('list-jobs reports the jobs each service registers', () => {
  assert.deepEqual(listJobs(fileURLToPath(new URL('./fixtures/repo', import.meta.url))), {
    demo: ['first_job', 'second_job'],
    plain: [],
  });
});

test('list-jobs on this checkout finds billing renewals', () => {
  const jobs = listJobs(fileURLToPath(new URL('../../..', import.meta.url)));
  assert.deepEqual(jobs.billing, ['renew_subscriptions']);
});

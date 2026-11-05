import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IDS, fixtureData, setupTestEnvironment, TEST_SALT } from '@learnloop/shared/testing';
import { pseudonymiseUser, runWithLogContext } from '@learnloop/shared/logger';
import { RENEWAL_JOB, advancePeriod, dueForRenewal, renewDueSubscriptions, renewSubscription } from '../src/jobs/renewals.js';
import { getSubscription } from '../src/services/subscription.js';
import { handler } from '../src/handler.js';

let env;
beforeEach(() => { env = setupTestEnvironment({ data: fixtureData() }); });
const DUE = new Date('2026-11-11T00:10:00Z');
const jobContext = { service: 'billing', version: 'v', environment: 'test', traceId: 't'.repeat(32), requestId: 'job-1', salt: TEST_SALT, role: 'system' };

test('dueForRenewal selects active subscriptions past their period end', () => {
  const sub = fixtureData().subscriptions[0];
  assert.equal(dueForRenewal([sub], new Date('2026-11-03T12:00:00Z')).length, 0);
  assert.equal(dueForRenewal([sub], DUE).length, 1);
  assert.equal(dueForRenewal([{ ...sub, status: 'cancelled' }], DUE).length, 0);
});

test('advancePeriod moves forward whole months until the period covers now', () => {
  const sub = advancePeriod({ ...fixtureData().subscriptions[0] }, new Date('2027-01-15T00:10:00Z'));
  assert.equal(sub.current_period_start, '2027-01-10T08:00:00.000Z');
  assert.equal(sub.current_period_end, '2027-02-10T08:00:00.000Z');
});

test('renewSubscription renews once and logs a system event for the subscriber', async () => {
  const first = await runWithLogContext({ ...jobContext, userId: IDS.learner }, () => renewSubscription(IDS.sub, DUE));
  const second = await runWithLogContext({ ...jobContext, userId: IDS.learner }, () => renewSubscription(IDS.sub, DUE));
  env.logs.restore();
  assert.equal(first.current_period_end, '2026-12-10T08:00:00.000Z');
  assert.equal(second, null);
  const [event] = env.logs.events('subscription_renewed');
  assert.equal(event.actor_type, 'system');
  assert.equal(event['service.name'], 'billing');
  assert.equal(event['user.id'], pseudonymiseUser(TEST_SALT, IDS.learner));
  assert.equal(event['session.id'], undefined);
  assert.equal(env.ses.sent.length, 1);
});

test('renewDueSubscriptions renews every due subscription', async () => {
  assert.equal(await runWithLogContext(jobContext, () => renewDueSubscriptions(DUE)), 1);
  assert.equal(await runWithLogContext(jobContext, () => renewDueSubscriptions(DUE)), 0);
  env.logs.restore();
  assert.equal((await getSubscription(IDS.learner)).current_period_end, '2026-12-10T08:00:00.000Z');
  assert.ok(env.logs.events().every((e) => e.actor_type === 'system'));
});

test('the billing handler runs the job for the scheduled event', async () => {
  assert.deepEqual(await handler({ job: RENEWAL_JOB }, { awsRequestId: 'abc' }), { ok: true });
  env.logs.restore();
});

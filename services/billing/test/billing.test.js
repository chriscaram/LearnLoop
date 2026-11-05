import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IDS, apiEvent, checkRoutesTable, fixtureData, setupTestEnvironment, testSessionCookie } from '@learnloop/shared/testing';
import {
  MONTHLY_PLAN, addMonths, cancelSubscription, daysUntilRenewal, getSubscription, isActive,
  sendReceipt, startSubscription, toPublicSubscription,
} from '../src/services/subscription.js';
import { routes } from '../src/routes.js';
import { handler } from '../src/handler.js';

let env;
beforeEach(() => { env = setupTestEnvironment({ data: fixtureData() }); });
const NOW = new Date('2026-11-03T12:00:00Z');

test('routes table', () => {
  checkRoutesTable(assert, routes, { service: 'billing', expected: ['GET /api/me/subscription', 'POST /api/checkout', 'POST /api/me/subscription/cancel'] });
});

test('one monthly plan at 19 USD', () => {
  assert.deepEqual({ ...MONTHLY_PLAN }, { id: 'monthly', name: 'Monthly', priceUsd: 19, interval: 'month' });
});

test('addMonths keeps the day and clamps to month end', () => {
  assert.equal(addMonths(new Date('2026-01-31T08:00:00Z'), 1).toISOString(), '2026-02-28T08:00:00.000Z');
  assert.equal(addMonths(new Date('2026-10-10T08:00:00Z'), 2).toISOString(), '2026-12-10T08:00:00.000Z');
});

test('getSubscription returns the latest or null', async () => {
  assert.equal((await getSubscription(IDS.learner)).id, IDS.sub);
  assert.equal(await getSubscription(IDS.learnerNoSub), null);
});

test('isActive: active, cancelled within period, ended, none', () => {
  const sub = fixtureData().subscriptions[0];
  assert.equal(isActive(sub, NOW), true);
  assert.equal(isActive({ ...sub, status: 'cancelled' }, NOW), true);
  assert.equal(isActive({ ...sub, status: 'cancelled' }, new Date('2026-12-01T00:00:00Z')), false);
  assert.equal(isActive(null, NOW), false);
});

test('daysUntilRenewal', () => {
  const sub = fixtureData().subscriptions[0];
  assert.equal(daysUntilRenewal(sub, NOW), 7);
  assert.equal(daysUntilRenewal({ ...sub, status: 'cancelled' }, NOW), null);
  assert.equal(daysUntilRenewal(null, NOW), null);
});

test('toPublicSubscription for none and active', () => {
  assert.equal(toPublicSubscription(null).status, 'none');
  assert.equal(toPublicSubscription(fixtureData().subscriptions[0], NOW).daysUntilRenewal, 7);
});

test('startSubscription creates an active subscription, welcome + receipt, and refuses duplicates', async () => {
  const sub = await startSubscription(IDS.learnerNoSub, NOW);
  assert.equal(sub.status, 'active');
  assert.equal(sub.current_period_end, '2026-12-03T12:00:00.000Z');
  await assert.rejects(startSubscription(IDS.learnerNoSub, NOW), (e) => e.status === 409);
  env.logs.restore();
  const names = env.logs.events().map((e) => e.event);
  assert.deepEqual(names.slice(0, 6), ['checkout_started', 'subscription_started', 'notification_created', 'email_sent', 'notification_created', 'email_sent']);
  assert.deepEqual(env.ses.sent.map((m) => m.Message.Subject.Data), ['Welcome to LearnLoop', 'Your LearnLoop receipt']);
  assert.ok(!env.logs.lines.join('').match(/"value":19\b/), 'money never logged');
});

test('cancelSubscription marks cancelled and logs subscription_cancelled', async () => {
  const sub = await cancelSubscription(IDS.learner, NOW);
  assert.equal(sub.status, 'cancelled');
  await assert.rejects(cancelSubscription(IDS.learner, NOW), (e) => e.status === 409);
  env.logs.restore();
  assert.equal(env.logs.events('subscription_cancelled').length, 1);
});

test('sendReceipt creates a payment_receipt notification and emails it', async () => {
  const user = fixtureData().users[0];
  await sendReceipt(user, fixtureData().subscriptions[0]);
  env.logs.restore();
  assert.equal(env.ses.sent[0].Message.Subject.Data, 'Your LearnLoop receipt');
  assert.equal(env.logs.events('notification_created').length, 1);
});

test('HTTP: subscription, checkout and cancel', async () => {
  const cookie = await testSessionCookie({ userId: IDS.learner });
  const status = JSON.parse((await handler(apiEvent('GET /api/me/subscription', { cookie }))).body);
  assert.equal(status.subscription.active, true);
  assert.equal((await handler(apiEvent('POST /api/checkout', { cookie }))).statusCode, 409);
  assert.equal((await handler(apiEvent('POST /api/me/subscription/cancel', { cookie }))).statusCode, 200);
  env.logs.restore();
});

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IDS, apiEvent, fixtureData, setupTestEnvironment, testSessionCookie } from '@learnloop/shared/testing';
import {
  CART_FOLLOW_UP_JOB, DEFAULT_DEPS, FLAG_KEY, MAX_OUTPUT_TOKENS, MODEL_BATCH_SIZE, OUTPUT_TOKENS_PER_ITEM, runCartFollowUp,
} from '../src/agents/cartFollowUp.js';
import { dailySeries, deriveOversight } from '../src/agents/cartFollowUpOversight.js';
import { handler } from '../src/handler.js';

const NOW = new Date('2026-11-03T12:00:00Z');
let env;

function setup({ flagOn = true, extra = (d) => d } = {}) {
  const data = fixtureData();
  // learnerNoSub's cart has waited longer (9 days) than learner's (about 6 days).
  data.carts.push({ user_id: IDS.learnerNoSub, items: [{ course_id: IDS.cloud, added_at: '2026-10-25T09:00:00.000Z' }] });
  env = setupTestEnvironment({ data: extra(data), flags: flagOn ? { [FLAG_KEY]: { enabled: true } } : {} });
}
beforeEach(() => setup());

function fakeModel(reply) {
  const calls = [];
  return { calls, async invoke(messages) { calls.push(messages); return typeof reply === 'function' ? reply(messages) : reply; } };
}
const promptCarts = (messages) => JSON.parse(messages[1][1]).carts;
const remindAll = (messages) => ({
  content: JSON.stringify({ decisions: promptCarts(messages).map((c) => ({
    ref: c.ref, action: 'remind', courseIds: c.courses.map((x) => x.courseId),
    title: `${c.courses[0].title} is waiting`, body: `Pick up ${c.courses[0].title} from your cart when you are ready.`,
  })) }),
  response_metadata: { stopReason: 'end_turn' },
});
const summaries = () => env.logs.records.filter((r) => r.kind === 'log' && r.job === CART_FOLLOW_UP_JOB);
const agentReminders = async () => (await env.store.read('notifications')).filter((n) => n.type === 'cart_reminder');

function spyDeps() {
  const calls = {};
  const deps = Object.fromEntries(Object.entries(DEFAULT_DEPS).map(([name, fn]) => [name, (...args) => {
    calls[name] = (calls[name] ?? 0) + 1;
    return fn(...args);
  }]));
  return { deps, calls };
}

test('flag off: the run does nothing, calls no model and says why', async () => {
  setup({ flagOn: false });
  const model = fakeModel(remindAll);
  const result = await runCartFollowUp(NOW, { model });
  env.logs.restore();
  assert.equal(model.calls.length, 0);
  assert.deepEqual(await agentReminders(), []);
  assert.equal(result.reason, 'flag_off');
  assert.equal(summaries().length, 1);
  assert.deepEqual([summaries()[0].reason, summaries()[0].acted], ['flag_off', 0]);
});

test('scheduled trigger: the handler routes cart_follow_up and stays inert while the flag is off', async () => {
  setup({ flagOn: false });
  assert.deepEqual((await handler({ listJobs: true })).jobs, [CART_FOLLOW_UP_JOB]);
  assert.deepEqual(await handler({ job: CART_FOLLOW_UP_JOB }), { ok: true });
  env.logs.restore();
  assert.deepEqual(summaries().map((s) => s.reason), ['flag_off']);
  assert.deepEqual(await agentReminders(), []);
});

test('reminds through the existing code, longest-waiting cart first, marked applied_by_agent', async () => {
  const { deps, calls } = spyDeps();
  const model = fakeModel(remindAll);
  const result = await runCartFollowUp(NOW, { model, deps });
  env.logs.restore();
  for (const name of ['listCartItems', 'getCart', 'listEnrolmentsForUser', 'getSubscription', 'isActive', 'listNotifications', 'createNotification', 'sendEmail', 'findUserById']) {
    assert.ok(calls[name] > 0, `${name} is called`);
  }
  const carts = promptCarts(model.calls[0]);
  assert.deepEqual(carts.map((c) => [c.courses[0].courseId, c.nextStep, c.cartAgeDays]), [[IDS.cloud, 'resubscribe', 9], [IDS.data, 'checkout', 5]]);
  assert.ok(!JSON.stringify(carts).includes('Nia') && !JSON.stringify(carts).includes('@'), 'no personal data reaches the model');
  const reminders = await agentReminders();
  assert.equal(reminders.length, 2);
  assert.ok(reminders.every((n) => n.applied_by_agent === true && n.link === '/cart'));
  assert.deepEqual(reminders.find((n) => n.user_id === IDS.learner).course_ids, [IDS.data]);
  assert.equal(env.ses.sent.length, 2);
  assert.deepEqual([result.reason, result.acted, result.candidates], ['completed', 2, 2]);
  assert.equal(summaries().length, 1);
});

test('a cap on carts per run takes the longest-waiting cart first', async () => {
  const model = fakeModel(remindAll);
  const result = await runCartFollowUp(NOW, { model, maxCarts: 1 });
  env.logs.restore();
  assert.deepEqual(promptCarts(model.calls[0]).map((c) => c.courses[0].courseId), [IDS.cloud]);
  assert.deepEqual((await agentReminders()).map((n) => n.user_id), [IDS.learnerNoSub]);
  assert.equal(result.acted, 1);
});

test('guardrails before the model: 7-day cooldown and at most 2 reminders per cart', async () => {
  const reminder = (id, user, at) => ({ id, user_id: user, type: 'cart_reminder', title: 't', body: 'b', link: '/cart', created_at: at, read_at: null, applied_by_agent: true, course_ids: [] });
  setup({ extra: (d) => {
    d.notifications.push(reminder('ntf_00000000aa01', IDS.learner, '2026-11-01T09:00:00.000Z'));
    d.notifications.push(reminder('ntf_00000000aa02', IDS.learnerNoSub, '2026-10-26T09:00:00.000Z'));
    d.notifications.push(reminder('ntf_00000000aa03', IDS.learnerNoSub, '2026-10-27T09:00:00.000Z'));
    return d;
  } });
  const model = fakeModel(remindAll);
  const result = await runCartFollowUp(NOW, { model });
  env.logs.restore();
  assert.equal(model.calls.length, 0);
  assert.deepEqual([result.reason, result.candidates, result.skipped], ['no_candidates', 2, 2]);
});

test('drafts that mention prices or courses outside the cart are never sent', async () => {
  const model = fakeModel((messages) => ({
    content: JSON.stringify({ decisions: [
      { ref: 'c1', action: 'remind', courseIds: [IDS.cloud], title: 'Back to Cloud Foundations', body: 'Only $19 a month!' },
      { ref: 'c2', action: 'remind', courseIds: [IDS.data], title: 'SQL for Analysts', body: 'Also try Cloud Foundations.' },
    ] }),
    response_metadata: { stopReason: 'end_turn' },
  }));
  const result = await runCartFollowUp(NOW, { model });
  env.logs.restore();
  assert.deepEqual(await agentReminders(), []);
  assert.deepEqual([result.reason, result.acted, result.skipped], ['completed', 0, 2]);
});

test('a truncated reply is a failure, reported as model_reply_truncated', async () => {
  const model = fakeModel({ content: '{"decisions":[{"ref":"c1","action":"remind","courseIds":["crs_0000', response_metadata: { stopReason: 'max_tokens' } });
  const result = await runCartFollowUp(NOW, { model });
  env.logs.restore();
  assert.equal(result.reason, 'model_reply_truncated');
  assert.deepEqual(summaries().map((s) => [s.reason, s.acted, s.candidates]), [['model_reply_truncated', 0, 2]]);
  assert.deepEqual(await agentReminders(), []);
});

test('an unparseable reply is reported as model_reply_unparseable', async () => {
  const result = await runCartFollowUp(NOW, { model: fakeModel({ content: 'Sure, here you go!', response_metadata: { stopReason: 'end_turn' } }) });
  env.logs.restore();
  assert.equal(result.reason, 'model_reply_unparseable');
  assert.equal(summaries()[0].reason, 'model_reply_unparseable');
});

test('output budget covers a full batch with 50% headroom', () => {
  assert.ok(MAX_OUTPUT_TOKENS >= OUTPUT_TOKENS_PER_ITEM * MODEL_BATCH_SIZE * 1.5);
});

test('deriveOversight: Sent, Opened, Came back and No response yet are derived on read', () => {
  const n = (id, user, created, read, extra = {}) => ({ id, user_id: user, type: 'cart_reminder', title: 't', body: 'b', link: '/cart', created_at: created, read_at: read, applied_by_agent: true, course_ids: ['crs_1'], ...extra });
  const notifications = [
    n('n1', 'u1', '2026-10-30T09:00:00.000Z', '2026-10-30T10:00:00.000Z'),
    n('n2', 'u2', '2026-10-30T09:00:00.000Z', '2026-10-31T08:00:00.000Z'),
    n('n3', 'u3', '2026-11-02T12:00:00.000Z', null),
    n('n4', 'u4', '2026-10-29T09:00:00.000Z', null),
    { id: 'n5', user_id: 'u4', type: 'welcome', title: 'w', body: '', created_at: '2026-10-29T09:00:00.000Z', read_at: null },
  ];
  const enrolments = [
    { user_id: 'u1', course_id: 'crs_1', enrolled_at: '2026-11-01T10:00:00.000Z' },
    { user_id: 'u2', course_id: 'crs_1', enrolled_at: '2026-10-01T10:00:00.000Z' },
  ];
  const users = ['u1', 'u2', 'u3', 'u4'].map((id) => ({ id, name: id.toUpperCase(), email: `${id}@example.com` }));
  const { people, stats } = deriveOversight({ notifications, enrolments, users }, NOW);
  assert.deepEqual(Object.fromEntries(people.map((p) => [p.userId, p.status])), { u1: 'came_back', u2: 'opened', u3: 'sent', u4: 'no_response' });
  assert.ok(people.every((p) => p.messages.every((m) => m.appliedByAgent)));
  assert.deepEqual(stats, { sent: 4, opened: 2, cameBack: 1 });
  const daily = dailySeries(people.flatMap((p) => p.messages), '2026-10-29', '2026-11-03');
  assert.equal(daily.length, 6);
  assert.deepEqual(daily.find((d) => d.date === '2026-10-30'), { date: '2026-10-30', sent: 2, opened: 1, cameBack: 0 });
  assert.equal(daily.find((d) => d.date === '2026-11-01').cameBack, 1);
});

test('HTTP: the oversight read is staff-only and validates the range', async () => {
  const learner = await testSessionCookie({ userId: IDS.learner });
  assert.equal((await handler(apiEvent('GET /api/admin/agents/cart-follow-up', { cookie: learner }))).statusCode, 403);
  const staff = await testSessionCookie({ userId: IDS.staff, role: 'staff' });
  const res = await handler(apiEvent('GET /api/admin/agents/cart-follow-up', { cookie: staff, query: { from: '2026-10-01', to: '2026-11-03' } }));
  const bad = await handler(apiEvent('GET /api/admin/agents/cart-follow-up', { cookie: staff, query: { from: '2026-11-05', to: '2026-11-03' } }));
  env.logs.restore();
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual([body.people, body.stats, body.daily.length], [[], { sent: 0, opened: 0, cameBack: 0 }, 34]);
  assert.equal(bad.statusCode, 400);
});
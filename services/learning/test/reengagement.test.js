import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IDS, fixtureData, setupTestEnvironment } from '@learnloop/shared/testing';
import {
  FLAG_KEY, MODEL_BATCH_SIZE, MODEL_MAX_TOKENS, OUTPUT_TOKENS_PER_ITEM, REENGAGEMENT_JOB, defaultDeps, runReengagement,
} from '../src/jobs/reengagement.js';
import { handler } from '../src/handler.js';

const NOW = new Date('2026-11-03T12:00:00Z');
const STALLED = 'usr_0000000000c3';
const FLAG_ON = { [FLAG_KEY]: { enabled: true } };

function data() {
  const d = fixtureData();
  d.users.push({ id: STALLED, email: 'cy.stalled@example.com', name: 'Cy Stalled', role: 'learner', created_at: '2026-06-01T09:00:00.000Z' });
  d.enrolments.push({ id: 'enr_0000000000c3', user_id: STALLED, course_id: IDS.data, enrolled_at: '2026-08-01T10:00:00.000Z' });
  d.progress.courses.push({ user_id: STALLED, course_id: IDS.data, last_activity_at: '2026-09-01T10:00:00.000Z' });
  return d;
}

let env;
const setup = (flags = {}) => { env = setupTestEnvironment({ data: data(), flags }); };
beforeEach(() => setup());

function fakeModel({ reply } = {}) {
  const calls = [];
  return {
    calls,
    async invoke(messages) {
      calls.push(messages);
      if (reply) return reply;
      const { learners } = JSON.parse(messages[1][1]);
      const decisions = learners.map((l) => {
        const reason = l.reasons[0];
        const course = l.courseOptions.find((o) => reason !== 'cart_not_enrolled' || o.source === 'cart');
        return { ref: l.ref, send: true, reason, courseId: course.id, subject: `Back to ${course.title}`, body: 'Your next step is ready when you are.' };
      });
      return { content: JSON.stringify(decisions), response_metadata: { stopReason: 'end_turn' } };
    },
  };
}

function spied() {
  const counts = {};
  const deps = {};
  for (const [name, fn] of Object.entries(defaultDeps)) {
    counts[name] = 0;
    deps[name] = (...args) => { counts[name] += 1; return fn(...args); };
  }
  return { deps, counts };
}

const summaries = () => env.logs.records.filter((r) => r.job === REENGAGEMENT_JOB);
const agentNotifications = async () => (await env.store.read('notifications')).filter((n) => n.applied_by_agent === true);

test('output budget covers a full batch with 50% headroom', () => {
  assert.ok(MODEL_MAX_TOKENS >= OUTPUT_TOKENS_PER_ITEM * MODEL_BATCH_SIZE * 1.5);
});

test('flag off: the job does nothing and logs flag_off', async () => {
  const model = { invoke: async () => { throw new Error('must not be called'); } };
  const result = await runReengagement(NOW, { model });
  assert.deepEqual(result, { acted: 0, candidates: 0, reason: 'flag_off' });
  const out = await handler({ job: REENGAGEMENT_JOB });
  env.logs.restore();
  assert.deepEqual(out, { ok: true });
  assert.deepEqual(await agentNotifications(), []);
  assert.equal(env.ses.sent.length, 0);
  assert.deepEqual(summaries().map((s) => s.reason), ['flag_off', 'flag_off']);
});

test('flag on: calls the deterministic functions, nudges each eligible learner once, marks records applied_by_agent', async () => {
  setup(FLAG_ON);
  const { deps, counts } = spied();
  const model = fakeModel();
  const result = await runReengagement(NOW, { model, deps });
  env.logs.restore();
  assert.deepEqual(result, { acted: 2, candidates: 2, reason: 'completed' });
  for (const name of ['daysSinceLastActivity', 'getCourseProgress', 'listUserEnrolments', 'getCart', 'listCatalog', 'getSubscription', 'createNotification', 'sendEmail']) {
    assert.ok(counts[name] > 0, `${name} called`);
  }
  assert.equal(model.calls.length, 1, 'two learners fit one batch');
  const sent = await agentNotifications();
  assert.deepEqual(sent.map((n) => [n.user_id, n.type, n.link]).sort(), [
    [IDS.learner, 'staff_message', `/courses/${IDS.data}`],
    [STALLED, 'staff_message', `/courses/${IDS.data}`],
  ].sort());
  assert.equal(env.ses.sent.length, 2);
  const [summary] = summaries();
  assert.deepEqual([summary.reason, summary.acted, summary.candidates], ['completed', 2, 2]);
  assert.ok(env.logs.events('notification_created').every((e) => e.actor_type === 'system'));
  assert.ok(!JSON.stringify(model.calls).includes('example.com'), 'no email addresses reach the model');
});

test('the per-run cap keeps the longest-stalled learner first', async () => {
  setup(FLAG_ON);
  const model = fakeModel();
  const result = await runReengagement(NOW, { model, maxNudges: 1 });
  env.logs.restore();
  assert.deepEqual(result, { acted: 1, candidates: 2, reason: 'completed' });
  const { learners } = JSON.parse(model.calls[0][1][1]);
  assert.deepEqual(learners.map((l) => l.stalledDays), [63]);
  assert.deepEqual((await agentNotifications()).map((n) => n.user_id), [STALLED]);
});

test('cool-down: a second run inside 14 days sends nothing and says daily_cap', async () => {
  setup(FLAG_ON);
  await runReengagement(NOW, { model: fakeModel() });
  const again = await runReengagement(new Date('2026-11-05T12:00:00Z'), { model: fakeModel() });
  env.logs.restore();
  assert.deepEqual(again, { acted: 0, candidates: 2, reason: 'daily_cap' });
  assert.equal((await agentNotifications()).length, 2);
});

test('a truncated reply is reported as model_reply_truncated, never as no decisions', async () => {
  setup(FLAG_ON);
  const model = fakeModel({ reply: { content: '[{"ref":"L1","send":true,"reason":"subscr', response_metadata: { stopReason: 'max_tokens' } } });
  const result = await runReengagement(NOW, { model });
  env.logs.restore();
  assert.deepEqual(result, { acted: 0, candidates: 2, reason: 'model_reply_truncated' });
  assert.equal(summaries().at(-1).reason, 'model_reply_truncated');
  assert.deepEqual(await agentNotifications(), []);
});

test('an unparseable reply is model_reply_unparseable; text with prices or promises is never sent', async () => {
  setup(FLAG_ON);
  const bad = await runReengagement(NOW, { model: fakeModel({ reply: { content: 'Sure! Here you go.', response_metadata: { stopReason: 'end_turn' } } }) });
  assert.equal(bad.reason, 'model_reply_unparseable');
  const pricey = [{ ref: 'L1', send: true, reason: 'subscription_inactive', courseId: IDS.data, subject: 'Come back', body: 'Get 50% off today.' }];
  const result = await runReengagement(NOW, { model: fakeModel({ reply: { content: JSON.stringify(pricey), response_metadata: { stopReason: 'end_turn' } } }) });
  env.logs.restore();
  assert.deepEqual(result, { acted: 0, candidates: 2, reason: 'completed' });
  assert.deepEqual(await agentNotifications(), []);
});
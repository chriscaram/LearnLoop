import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IDS, fixtureData, setupTestEnvironment } from '@learnloop/shared/testing';
import {
  CART_REMINDER_JOB, FLAG_KEY, MODEL_BATCH_SIZE, MODEL_MAX_TOKENS, OUTPUT_TOKENS_PER_ITEM, nudgeStalledCarts, selectForRun,
} from '../src/agents/cartReminder.js';
import { deriveOversight } from '../src/agents/cartReminderOversight.js';
import { handler } from '../src/handler.js';

const NOW = new Date('2026-11-03T12:00:00Z');
let env;
const setup = (on) => { env = setupTestEnvironment({ data: fixtureData(), flags: on ? { [FLAG_KEY]: { enabled: true } } : {} }); };
beforeEach(() => setup(true));

async function stallCarts() {
  await env.store.update('carts', (all) => {
    // already enrolled in Cloud: must never be mentioned for this learner
    all[0].items.unshift({ course_id: IDS.cloud, added_at: '2026-09-01T10:00:00.000Z' });
    all.push({ user_id: IDS.learnerNoSub, items: [{ course_id: IDS.cloud, added_at: '2026-10-01T09:00:00.000Z' }] });
  });
}

function fakeModel(replyFor) {
  const calls = [];
  return { calls, async invoke(messages) { const input = JSON.parse(messages[1][1]); calls.push(input); return replyFor(input); } };
}
const reply = (decisions) => ({ content: JSON.stringify({ decisions }), response_metadata: { stopReason: 'end_turn' } });
const sendAll = (input) => reply(input.items.map((i) => ({ ref: i.ref, send: true, title: `Still thinking about ${i.courses[0].title}`, body: `${i.courses[0].title} is waiting in your cart. Pick up where you left off.` })));
const summaries = () => env.logs.records.filter((r) => r.job === CART_REMINDER_JOB);
const agentNotes = async () => (await env.store.read('notifications')).filter((n) => n.applied_by_agent === true);

test('output budget covers a full batch with headroom', () => {
  assert.ok(MODEL_MAX_TOKENS >= OUTPUT_TOKENS_PER_ITEM * MODEL_BATCH_SIZE * 1.5);
});

test('flag off: the job does nothing and says why', async () => {
  setup(false);
  await stallCarts();
  const model = fakeModel(sendAll);
  const result = await nudgeStalledCarts(NOW, { model });
  assert.equal(result.reason, 'flag_off');
  assert.equal(model.calls.length, 0);
  assert.deepEqual(await agentNotes(), []);
  const res = await handler({ job: CART_REMINDER_JOB });
  env.logs.restore();
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(summaries().map((s) => s.reason), ['flag_off', 'flag_off']);
});

test('reminds stalled carts, longest stall first, excludes enrolled courses, link follows the plan', async () => {
  await stallCarts();
  const model = fakeModel(sendAll);
  const result = await nudgeStalledCarts(NOW, { model });
  env.logs.restore();
  assert.deepEqual([result.reason, result.acted, result.candidates], ['completed', 2, 2]);
  const [input] = model.calls;
  assert.deepEqual(input.items.map((i) => i.courses.map((c) => c.title)), [['Cloud Foundations'], ['SQL for Analysts']], 'longest stall first; enrolled Cloud left out for the learner');
  assert.ok(!JSON.stringify(input).includes('example.com') && !JSON.stringify(input).includes('Lee'), 'no personal data');
  const notes = await agentNotes();
  const byUser = Object.fromEntries(notes.map((n) => [n.user_id, n]));
  assert.equal(byUser[IDS.learner].link, '/checkout', 'active plan');
  assert.equal(byUser[IDS.learnerNoSub].link, '/cart', 'no plan');
  assert.ok(notes.every((n) => n.type === 'cart_reminder'));
  assert.equal(summaries().length, 1);
  // guardrail: one reminder per 14 days
  const again = await nudgeStalledCarts(NOW, { model });
  assert.equal(again.reason, 'no_candidates');
  assert.equal(model.calls.length, 1);
});

test('a message naming a course outside the cart is not sent', async () => {
  await stallCarts();
  const model = fakeModel((input) => reply(input.items.map((i) => ({ ref: i.ref, send: true, title: 'Your cart', body: 'Cloud Foundations and SQL for Analysts await.' }))));
  const result = await nudgeStalledCarts(NOW, { model });
  assert.equal(result.acted, 0);
  assert.deepEqual(await agentNotes(), []);
});

test('the cap keeps the most at-risk (longest stall)', () => {
  const picked = selectForRun([{ userId: 'usr_a', stallMs: 1, stalled: [1] }, { userId: 'usr_b', stallMs: 9, stalled: [1] }, { userId: 'usr_c', stallMs: 5, stalled: [1] }], 2);
  assert.deepEqual(picked.map((c) => c.userId), ['usr_b', 'usr_c']);
});

test('truncated reply is reported as model_reply_truncated, nobody contacted', async () => {
  await stallCarts();
  const model = fakeModel(() => ({ content: '{"decisions":[{"ref":"c1","send":tr', response_metadata: { stopReason: 'max_tokens' } }));
  const result = await nudgeStalledCarts(NOW, { model });
  env.logs.restore();
  assert.equal(result.reason, 'model_reply_truncated');
  assert.equal(summaries()[0].reason, 'model_reply_truncated');
  assert.deepEqual(await agentNotes(), []);
});

test('unparseable reply is reported as model_reply_unparseable', async () => {
  await stallCarts();
  const result = await nudgeStalledCarts(NOW, { model: fakeModel(() => ({ content: 'sorry', response_metadata: { stopReason: 'end_turn' } })) });
  assert.equal(result.reason, 'model_reply_unparseable');
});

test('oversight statuses are derived from agent notifications and later enrolments', () => {
  const n = (id, user, created, read = null, agent = true) => ({ id, user_id: user, type: 'cart_reminder', title: 't', body: 'b', link: '/cart', created_at: created, read_at: read, ...(agent ? { applied_by_agent: true } : {}) });
  const data = {
    notifications: [
      n('ntf_000000000001', 'u1', '2026-11-01T09:00:00.000Z', '2026-11-01T10:00:00.000Z'),
      n('ntf_000000000002', 'u2', '2026-11-02T09:00:00.000Z'),
      n('ntf_000000000003', 'u3', '2026-10-20T09:00:00.000Z'),
      n('ntf_000000000004', 'u4', '2026-11-01T09:00:00.000Z', '2026-11-02T09:00:00.000Z'),
      n('ntf_000000000005', 'u2', '2026-11-02T09:00:00.000Z', null, false),
    ],
    enrolments: [{ user_id: 'u1', course_id: 'crs_000000000001', enrolled_at: '2026-11-02T08:00:00.000Z' }],
    users: [{ id: 'u1', name: 'A', email: 'a@x.test' }],
  };
  const out = deriveOversight(data, NOW);
  const status = Object.fromEntries(out.people.map((p) => [p.userId, p.status]));
  assert.deepEqual(status, { u1: 'came_back', u2: 'sent', u3: 'no_response', u4: 'opened' });
  assert.deepEqual(out.totals, { sent: 4, opened: 2, cameBack: 1 });
  assert.deepEqual(out.daily.find((d) => d.date === '2026-11-02'), { date: '2026-11-02', sent: 1, opened: 1, cameBack: 1 });
});
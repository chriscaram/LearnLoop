import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IDS, fixtureData, setupTestEnvironment } from '@learnloop/shared/testing';
import { listNotifications } from '@learnloop/notifications/services/inbox';
import {
  FLAG_KEY, MAX_OUTPUT_TOKENS, MODEL_BATCH_SIZE, OUTPUT_TOKENS_PER_ITEM, REENGAGEMENT_JOB, SUMMARY_PREFIX,
  collectCandidates, runReengagementJob,
} from '../src/agents/reengagement.js';
import { deriveOutreach } from '../src/agents/reengagementOversight.js';
import { daysSinceLastActivity } from '../src/services/progress.js';
import { handler } from '../src/handler.js';

const NOW = new Date('2026-11-03T12:00:00Z');
const OTHER = 'usr_0000000000c3';
let env;
beforeEach(() => { env = setupTestEnvironment({ data: fixtureData(), flags: { [FLAG_KEY]: { enabled: true } } }); });

function fakeModel(reply) {
  const calls = [];
  return {
    calls,
    async invoke(messages) {
      const text = messages.map((m) => (Array.isArray(m) ? m[1] : m.content)).join('\n');
      calls.push(text);
      if (reply instanceof Error) throw reply;
      return typeof reply === 'function' ? reply(text) : reply;
    },
  };
}

const nudgeAll = (text) => ({
  content: JSON.stringify([...text.matchAll(/"ref":"(c\d+)"/g)].map(([, ref]) => ({
    ref, action: 'nudge', courseId: IDS.cloud, title: 'Pick up Cloud Foundations', body: 'You are 17% through Cloud Foundations. Next up: Two.',
  }))),
  response_metadata: { stopReason: 'end_turn' },
});

function summaries() {
  env.logs.restore();
  return env.logs.records
    .filter((r) => r.kind === 'log' && r.message.startsWith(SUMMARY_PREFIX))
    .map((r) => JSON.parse(r.message.slice(SUMMARY_PREFIX.length + 1)));
}

const agentNotes = async (userId) => (await listNotifications(userId)).filter((n) => n.applied_by_agent === true);

async function addOtherLearner() {
  await env.store.update('users', (users) => { users.unshift({ id: OTHER, email: 'cy@example.com', name: 'Cy', role: 'learner', created_at: '2026-06-01T09:00:00.000Z' }); });
  await env.store.update('enrolments', (all) => { all.push({ id: 'enr_0000000000c3', user_id: OTHER, course_id: IDS.cloud, enrolled_at: '2026-10-01T10:00:00.000Z' }); });
  await env.store.update('progress', (p) => {
    p.lessons.push({ user_id: OTHER, course_id: IDS.cloud, lesson_id: IDS.lesson1, status: 'completed', started_at: '2026-10-24T10:00:00.000Z', completed_at: '2026-10-24T10:00:00.000Z' });
    p.courses.push({ user_id: OTHER, course_id: IDS.cloud, last_activity_at: '2026-10-24T10:00:00.000Z' });
  });
}

test('output budget covers a full batch with headroom', () => {
  assert.ok(MAX_OUTPUT_TOKENS >= OUTPUT_TOKENS_PER_ITEM * MODEL_BATCH_SIZE * 1.5);
});

test('flag off: the job does nothing, never calls the model, and says why', async () => {
  env = setupTestEnvironment({ data: fixtureData() });
  const model = fakeModel(nudgeAll);
  const result = await runReengagementJob(NOW, { model });
  assert.equal(result.reason, 'flag_off');
  assert.equal(model.calls.length, 0);
  assert.deepEqual(await agentNotes(IDS.learner), []);
  assert.equal(env.ses.sent.length, 0);
  assert.deepEqual(summaries().map((s) => s.reason), ['flag_off']);
});

test('the job is registered and, with the flag off, the scheduled invocation is a no-op', async () => {
  assert.ok((await handler({ listJobs: true })).jobs.includes(REENGAGEMENT_JOB));
  env = setupTestEnvironment({ data: fixtureData() });
  assert.deepEqual(await handler({ job: REENGAGEMENT_JOB }), { ok: true });
  assert.deepEqual(await agentNotes(IDS.learner), []);
  assert.deepEqual(summaries().map((s) => s.reason), ['flag_off']);
});

test('nudges an inactive learner using the existing progress functions, links the real next lesson', async () => {
  const { candidates } = await collectCandidates(NOW);
  assert.deepEqual(candidates.map((c) => c.userId), [IDS.learner], 'never-active learners are skipped');
  assert.equal(candidates[0].daysInactive, await daysSinceLastActivity(IDS.learner, NOW));
  assert.deepEqual(candidates[0].courses, [{ courseId: IDS.cloud, courseTitle: 'Cloud Foundations', percent: 17, nextLessonTitle: 'Two' }]);

  const model = fakeModel(nudgeAll);
  const result = await runReengagementJob(NOW, { model });
  assert.deepEqual([result.reason, result.acted, result.candidates], ['completed', 1, 1]);
  const prompt = model.calls[0];
  assert.match(prompt, /"daysInactive":29/);
  assert.match(prompt, /"percent":17/);
  for (const forbidden of ['Lee', 'Finance', 'Acme', 'example.com', IDS.learner]) assert.ok(!prompt.includes(forbidden), `${forbidden} never reaches the model`);
  const [note] = await agentNotes(IDS.learner);
  assert.deepEqual([note.type, note.link, note.applied_by_agent], ['staff_message', `/lessons/${IDS.lesson2}`, true]);
  assert.equal(env.ses.sent.length, 1);
  assert.equal(env.ses.sent[0].Message.Subject.Data, 'Pick up Cloud Foundations');
  assert.equal(summaries().length, 1);
});

test('frequency cap: no second nudge within 14 days', async () => {
  await runReengagementJob(NOW, { model: fakeModel(nudgeAll) });
  const again = await runReengagementJob(new Date('2026-11-10T12:00:00Z'), { model: fakeModel(nudgeAll) });
  assert.equal(again.reason, 'no_candidates');
  assert.equal((await agentNotes(IDS.learner)).length, 1);
});

test('the cap keeps the most at-risk learner (longest inactivity), not insertion order', async () => {
  await addOtherLearner();
  const { candidates } = await collectCandidates(NOW);
  assert.deepEqual(candidates.map((c) => [c.userId, c.daysInactive]), [[IDS.learner, 29], [OTHER, 10]]);
  const result = await runReengagementJob(NOW, { model: fakeModel(nudgeAll), dailyCap: 1 });
  assert.deepEqual([result.acted, result.selected, result.candidates], [1, 1, 2]);
  assert.equal((await agentNotes(IDS.learner)).length, 1);
  assert.equal((await agentNotes(OTHER)).length, 0);
});

test('daily cap reached: nothing is sent and the model is not called', async () => {
  const model = fakeModel(nudgeAll);
  const result = await runReengagementJob(NOW, { model, dailyCap: 0 });
  assert.equal(result.reason, 'daily_cap');
  assert.equal(model.calls.length, 0);
});

test('a truncated reply is reported as model_reply_truncated, not as no decisions', async () => {
  const model = fakeModel({ content: '[{"ref":"c1","action":"nud', response_metadata: { stopReason: 'max_tokens' } });
  const result = await runReengagementJob(NOW, { model });
  assert.deepEqual([result.reason, result.acted, result.failedBatches], ['model_reply_truncated', 0, 1]);
  assert.deepEqual(await agentNotes(IDS.learner), []);
  const lines = summaries();
  assert.deepEqual(lines.map((s) => s.reason), ['model_reply_truncated']);
});

test('unparseable and failed model calls are reported', async () => {
  const bad = await runReengagementJob(NOW, { model: fakeModel({ content: 'Sure! I will nudge them.', response_metadata: { stopReason: 'end_turn' } }) });
  assert.equal(bad.reason, 'model_reply_unparseable');
  const failed = await runReengagementJob(NOW, { model: fakeModel(new Error('throttled')) });
  assert.equal(failed.reason, 'model_call_failed');
  assert.deepEqual(await agentNotes(IDS.learner), []);
});

test('generated text that fails validateMessage, or an unlisted course, is never sent; an empty answer is a real answer', async () => {
  const tooLong = fakeModel({ content: JSON.stringify([{ ref: 'c1', action: 'nudge', courseId: IDS.cloud, title: 'x'.repeat(200), body: 'b' }]), response_metadata: { stopReason: 'end_turn' } });
  assert.deepEqual([(await runReengagementJob(NOW, { model: tooLong })).acted], [0]);
  const wrongCourse = fakeModel({ content: JSON.stringify([{ ref: 'c1', action: 'nudge', courseId: IDS.data, title: 't', body: 'b' }]), response_metadata: { stopReason: 'end_turn' } });
  assert.equal((await runReengagementJob(NOW, { model: wrongCourse })).acted, 0);
  const none = await runReengagementJob(NOW, { model: fakeModel({ content: '[]', response_metadata: { stopReason: 'end_turn' } }) });
  assert.deepEqual([none.reason, none.acted], ['completed', 0]);
  assert.deepEqual(await agentNotes(IDS.learner), []);
});

test('deriveOutreach: statuses and rates from existing records only', () => {
  const now = new Date('2026-11-03T12:00:00Z');
  const n = (id, created, read = null) => ({ id, title: 't', body: 'b', link: '/lessons/x', created_at: created, read_at: read, applied_by_agent: true });
  const people = [
    { userId: 'u1', name: 'Ann', email: 'a@x.test', lastActivityAt: '2026-11-02T10:00:00.000Z', notifications: [n('n1', '2026-11-01T09:00:00.000Z', '2026-11-01T12:00:00.000Z'), { id: 'w', type: 'welcome', created_at: '2026-06-01T00:00:00.000Z', read_at: null }] },
    { userId: 'u2', name: 'Ben', email: 'b@x.test', lastActivityAt: '2026-10-01T10:00:00.000Z', notifications: [n('n2', '2026-11-02T09:00:00.000Z', '2026-11-02T10:00:00.000Z')] },
    { userId: 'u3', name: 'Cat', email: 'c@x.test', lastActivityAt: '2026-10-01T10:00:00.000Z', notifications: [n('n3', '2026-11-03T08:00:00.000Z')] },
    { userId: 'u4', name: 'Dan', email: 'd@x.test', lastActivityAt: null, notifications: [n('n4', '2026-10-20T08:00:00.000Z')] },
    { userId: 'u5', name: 'Eve', email: 'e@x.test', lastActivityAt: null, notifications: [] },
  ];
  const { people: rows, totals } = deriveOutreach(people, now);
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.userId, r.status])), { u1: 'came_back', u2: 'opened', u3: 'sent', u4: 'no_response' });
  assert.deepEqual(totals, { sent: 4, opened: 2, cameBack: 1, cameBackOfOpened: 1 });
  assert.equal(rows.find((r) => r.userId === 'u1').messages.length, 1, 'only records marked applied_by_agent');
});
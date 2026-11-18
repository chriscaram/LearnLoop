import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IDS, fixtureData, setupTestEnvironment } from '@learnloop/shared/testing';
import {
  FLAG_KEY, MODEL_BATCH_SIZE, MODEL_MAX_TOKENS, NUDGE_JOB, OUTPUT_TOKENS_PER_ITEM, runInactivityNudges,
} from '../src/agents/inactivityNudges.js';
import { GA_OVERSIGHT, deriveOversight } from '../src/agents/nudgeRecords.js';
import { handler } from '../src/handler.js';

const NOW = new Date('2026-11-03T12:00:00Z');
const CY = 'usr_0000000000c3';
let env;

// Lee (fixture): 29 days inactive, Cloud Foundations 17%, next lesson "Two".
// Cy (added first, so insertion order is wrong on purpose): 9 days inactive, 0%.
function data() {
  const d = fixtureData();
  d.users.unshift({ id: CY, email: 'cy.recent@example.com', name: 'Cy Recent', role: 'learner', created_at: '2026-06-01T09:00:00.000Z' });
  d.enrolments.push({ id: 'enr_0000000000c3', user_id: CY, course_id: IDS.cloud, enrolled_at: '2026-08-01T10:00:00.000Z' });
  d.progress.lessons.push({ user_id: CY, course_id: IDS.cloud, lesson_id: IDS.lesson1, status: 'started', started_at: '2026-10-25T10:00:00.000Z', completed_at: null });
  d.progress.courses.push({ user_id: CY, course_id: IDS.cloud, last_activity_at: '2026-10-25T10:00:00.000Z' });
  return d;
}
const setup = (enabled) => {
  env = setupTestEnvironment({ data: data(), flags: enabled ? { [FLAG_KEY]: { enabled: true } } : {} });
};
beforeEach(() => setup(true));

function fakeModel(reply) {
  const calls = [];
  return {
    calls,
    async invoke(messages) {
      const input = JSON.parse(messages[1][1]);
      calls.push(input);
      return typeof reply === 'function' ? reply(input) : reply;
    },
  };
}
const nudgeAll = (input) => ({
  content: JSON.stringify({ decisions: input.learners.map((l) => ({
    ref: l.ref, nudge: true, courseRef: 'C1',
    subject: `Pick up ${l.courses[0].courseTitle}`,
    body: `You are ${l.courses[0].completionPercent}% through. Next up: ${l.courses[0].nextLessonTitle}.`,
  })) }),
  response_metadata: { stopReason: 'end_turn' },
});
const summaries = () => env.logs.records.filter((r) => r.job === NUDGE_JOB);
const agentNotifications = async () => (await env.store.read('notifications')).filter((n) => n.applied_by_agent === true);

test('flag off: the job does nothing, never calls the model, and says why', async () => {
  setup(false);
  const model = fakeModel(nudgeAll);
  await runInactivityNudges(NOW, { model });
  assert.equal(model.calls.length, 0);
  assert.equal((await env.store.read('notifications')).length, 2);
  assert.equal(env.ses.sent.length, 0);
  const lines = summaries();
  assert.equal(lines.length, 1);
  assert.deepEqual([lines[0].reason, lines[0].acted, lines[0].candidates], ['flag_off', 0, 0]);
});

test('facts come from daysSinceLastActivity, nextLessonFor and completionPercent; most at risk first; nudges are marked applied_by_agent', async () => {
  const model = fakeModel(nudgeAll);
  await runInactivityNudges(NOW, { model });
  assert.equal(model.calls.length, 1);
  const [lee, cy] = model.calls[0].learners;
  assert.equal(lee.daysInactive, 29);
  assert.deepEqual([lee.courses[0].courseTitle, lee.courses[0].nextLessonTitle, lee.courses[0].completionPercent], ['Cloud Foundations', 'Two', 17]);
  assert.equal(cy.daysInactive, 9, 'the longer stall goes first, not insertion order');
  const created = await agentNotifications();
  assert.equal(created.length, 2);
  const leeNote = created.find((n) => n.user_id === IDS.learner);
  assert.deepEqual([leeNote.type, leeNote.link, leeNote.course_id, leeNote.email_status], ['staff_message', `/lessons/${IDS.lesson2}`, IDS.cloud, 'sent']);
  assert.equal(env.ses.sent.length, 2);
  const [line] = summaries();
  assert.deepEqual([line.reason, line.acted, line.candidates, line.actor_type], ['completed', 2, 2, 'system']);
});

test('the per-run cap keeps the most at-risk learner', async () => {
  const model = fakeModel(nudgeAll);
  await runInactivityNudges(NOW, { model, maxPerRun: 1 });
  assert.deepEqual(model.calls[0].learners.map((l) => l.daysInactive), [29]);
  assert.deepEqual((await agentNotifications()).map((n) => n.user_id), [IDS.learner]);
  assert.deepEqual([summaries()[0].acted, summaries()[0].candidates], [1, 2]);
  env.logs.clear();
  await runInactivityNudges(NOW, { model, maxPerRun: 1 });
  assert.equal(summaries()[0].reason, 'daily_cap');
});

test('frequency cap: a learner nudged in the last 14 days is not nudged again', async () => {
  const model = fakeModel(nudgeAll);
  await runInactivityNudges(NOW, { model });
  env.logs.clear();
  await runInactivityNudges(new Date('2026-11-10T12:00:00Z'), { model });
  assert.equal(model.calls.length, 1);
  assert.equal(summaries()[0].reason, 'no_candidates');
});

test('a truncated reply is reported as model_reply_truncated, not as "nobody to nudge"', async () => {
  const model = fakeModel({ content: '{"decisions":[{"ref":"L1","nudge":true,"courseRef":"C1","subject":"Pick up Clo', response_metadata: { stopReason: 'max_tokens' } });
  await runInactivityNudges(NOW, { model });
  assert.equal((await agentNotifications()).length, 0);
  const [line] = summaries();
  assert.deepEqual([line.reason, line.acted, line.candidates], ['model_reply_truncated', 0, 2]);
});

test('an unparseable reply is reported; text with a link is dropped by code', async () => {
  await runInactivityNudges(NOW, { model: fakeModel({ content: 'Sure, here you go!', response_metadata: { stopReason: 'end_turn' } }) });
  assert.equal(summaries()[0].reason, 'model_reply_unparseable');
  env.logs.clear();
  const withLink = (input) => ({
    content: JSON.stringify({ decisions: input.learners.map((l) => ({ ref: l.ref, nudge: true, courseRef: 'C1', subject: 'Come back', body: 'Visit https://evil.example now.' })) }),
    response_metadata: { stopReason: 'end_turn' },
  });
  await runInactivityNudges(NOW, { model: fakeModel(withLink) });
  assert.equal((await agentNotifications()).length, 0);
  assert.deepEqual([summaries()[0].reason, summaries()[0].acted], ['completed', 0]);
});

test('output budget fits a full batch with headroom', () => {
  assert.ok(MODEL_MAX_TOKENS >= OUTPUT_TOKENS_PER_ITEM * MODEL_BATCH_SIZE * 1.5);
});

test('the learning handler routes the scheduled job (flag off: does nothing)', async () => {
  setup(false);
  assert.deepEqual(await handler({ listJobs: true }), { jobs: [NUDGE_JOB] });
  assert.deepEqual(await handler({ job: NUDGE_JOB }), { ok: true });
  assert.equal(summaries()[0].reason, 'flag_off');
});

test('oversight read derives Sent / Opened / Came back / No response yet and the rates', () => {
  assert.equal(GA_OVERSIGHT, FLAG_KEY);
  const n = (id, user, created, read) => ({ id, user_id: user, course_id: 'crs_x', title: 't', body: 'b', link: '/lessons/l', created_at: created, read_at: read, applied_by_agent: true, agent: 'inactivity_nudge' });
  const nudges = [
    n('ntf_1', 'a', '2026-11-01T08:00:00.000Z', '2026-11-01T12:00:00.000Z'),
    n('ntf_2', 'b', '2026-11-02T08:00:00.000Z', null),
    n('ntf_3', 'c', '2026-10-20T08:00:00.000Z', '2026-10-21T08:00:00.000Z'),
    n('ntf_4', 'd', '2026-10-20T08:00:00.000Z', null),
  ];
  const activity = [
    { user_id: 'a', course_id: 'crs_x', last_activity_at: '2026-11-02T09:00:00.000Z' },
    { user_id: 'b', course_id: 'crs_x', last_activity_at: '2026-10-01T09:00:00.000Z' },
  ];
  const users = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id.toUpperCase(), email: `${id}@example.com` }));
  const view = deriveOversight({ nudges, users, activity }, NOW);
  const status = Object.fromEntries(view.people.map((p) => [p.userId, p.status]));
  assert.deepEqual(status, { a: 'came_back', b: 'sent', c: 'opened', d: 'no_response' });
  assert.deepEqual(view.totals, { sent: 4, opened: 2, cameBack: 1, cameBackOfOpened: 1 });
  assert.deepEqual(view.daily.find((d) => d.date === '2026-11-02'), { date: '2026-11-02', sent: 1, opened: 0, cameBack: 1 });
  assert.ok(view.people.every((p) => p.messages.every((m) => m.appliedByAgent === true)));
});
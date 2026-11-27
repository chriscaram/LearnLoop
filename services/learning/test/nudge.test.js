import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IDS, fixtureData, setupTestEnvironment } from '@learnloop/shared/testing';
import {
  FLAG_KEY, MAX_OUTPUT_TOKENS, MODEL_BATCH_SIZE, NUDGE_JOB, OUTPUT_TOKENS_PER_ITEM, nudgeLapsedLearners, rankCandidates,
} from '../src/agents/nudgeLapsedLearners.js';
import { deriveNudgeOversight } from '../src/agents/nudgeOversight.js';
import { handler } from '../src/handler.js';

const NOW = new Date('2026-11-03T12:00:00Z');
let env;

function setup(enabled = true) {
  env = setupTestEnvironment({ data: fixtureData(), flags: enabled ? { [FLAG_KEY]: { enabled: true } } : {} });
}
beforeEach(() => setup(true));

function fakeModel({ truncate = false } = {}) {
  const calls = [];
  return {
    calls,
    async invoke(messages) {
      calls.push(messages);
      if (truncate) return { content: '{"decisions":[{"learner":"L1","action":"nu', response_metadata: { stopReason: 'max_tokens' } };
      const { learners } = JSON.parse(messages[1][1]);
      const decisions = learners.map((l) => ({
        learner: l.learner, action: 'nudge', course: l.courses[0].course,
        body: `Lesson ${l.courses[0].nextLesson} of ${l.courses[0].title} is waiting for you.`,
      }));
      return { content: JSON.stringify({ decisions }), response_metadata: { stopReason: 'end_turn' } };
    },
  };
}

function summaries() {
  return env.logs.records.filter((r) => r.kind === 'log' && r.message.startsWith(NUDGE_JOB))
    .map((r) => JSON.parse(r.message.slice(r.message.indexOf('{'))));
}

async function agentNotes() {
  return (await env.store.read('notifications')).filter((n) => n.applied_by_agent === true);
}

async function addSecondLearner() {
  await env.store.update('enrolments', (all) => { all.push({ id: 'enr_0000000000b2', user_id: IDS.learnerNoSub, course_id: IDS.cloud, enrolled_at: '2026-09-02T10:00:00.000Z' }); });
  await env.store.update('progress', (p) => {
    p.lessons.push({ user_id: IDS.learnerNoSub, course_id: IDS.cloud, lesson_id: IDS.lesson1, status: 'completed', started_at: '2026-10-19T10:00:00.000Z', completed_at: '2026-10-19T10:10:00.000Z' });
    p.lessons.push({ user_id: IDS.learnerNoSub, course_id: IDS.cloud, lesson_id: IDS.lesson2, status: 'completed', started_at: '2026-10-20T10:00:00.000Z', completed_at: '2026-10-20T10:20:00.000Z' });
    p.courses.push({ user_id: IDS.learnerNoSub, course_id: IDS.cloud, last_activity_at: '2026-10-20T10:20:00.000Z' });
  });
}

test('output budget covers a full batch with headroom', () => {
  assert.ok(MAX_OUTPUT_TOKENS >= OUTPUT_TOKENS_PER_ITEM * MODEL_BATCH_SIZE * 1.5);
});

test('flag off: the job does nothing and says so', async () => {
  setup(false);
  const model = fakeModel();
  const result = await nudgeLapsedLearners(NOW, { model });
  const viaHandler = await handler({ job: NUDGE_JOB });
  env.logs.restore();
  assert.equal(result.reason, 'flag_off');
  assert.deepEqual(viaHandler, { ok: true });
  assert.equal(model.calls.length, 0);
  assert.deepEqual(await agentNotes(), []);
  assert.equal(env.ses.sent.length, 0);
  assert.deepEqual(summaries().map((s) => s.reason), ['flag_off', 'flag_off']);
});

test('completed: progress from the existing functions feeds the model; one notification and one email per nudge', async () => {
  const model = fakeModel();
  const result = await nudgeLapsedLearners(NOW, { model });
  env.logs.restore();
  assert.deepEqual(result, { reason: 'completed', acted: 1, candidates: 1 });
  const prompt = JSON.parse(model.calls[0][1][1]);
  assert.deepEqual(prompt.learners[0].courses[0], {
    course: 'C1', title: 'Cloud Foundations', percent: 17, completedLessons: 1, totalLessons: 3,
    lastLesson: 'Two', nextLesson: 'Two', quizAttempts: 0, lastQuizScore: null,
  });
  assert.equal(prompt.learners[0].daysSinceLastLesson, 29);
  assert.ok(!model.calls[0][1][1].includes('example.com'), 'no personal data reaches the model');
  const [note] = await agentNotes();
  assert.deepEqual([note.user_id, note.type, note.link, note.applied_by_agent], [IDS.learner, 'learning_nudge', `/lessons/${IDS.lesson2}`, true]);
  assert.equal(env.ses.sent.length, 1);
  assert.equal(env.ses.sent[0].Message.Subject.Data, 'Your next lesson is ready');
  assert.equal(summaries().length, 1);
});

test('cooldown: a learner nudged recently is not nudged again', async () => {
  await nudgeLapsedLearners(NOW, { model: fakeModel() });
  const second = await nudgeLapsedLearners(new Date('2026-11-05T12:00:00Z'), { model: fakeModel() });
  env.logs.restore();
  assert.equal(second.reason, 'no_candidates');
  assert.equal((await agentNotes()).length, 1);
});

test('cap: the learner closest to finishing goes first', async () => {
  await addSecondLearner();
  const result = await nudgeLapsedLearners(NOW, { model: fakeModel(), dailyCap: 1 });
  env.logs.restore();
  assert.deepEqual([result.acted, result.candidates], [1, 2]);
  const notes = await agentNotes();
  assert.deepEqual(notes.map((n) => [n.user_id, n.link]), [[IDS.learnerNoSub, `/lessons/${IDS.lesson3}`]]);
  const ranked = rankCandidates([
    { user: { id: 'a' }, risk: 10, days: 9 }, { user: { id: 'b' }, risk: 80, days: 30 }, { user: { id: 'c' }, risk: 80, days: 8 },
  ]);
  assert.deepEqual(ranked.map((c) => c.user.id), ['c', 'b', 'a']);
});

test('daily cap reached: nothing is sent', async () => {
  const result = await nudgeLapsedLearners(NOW, { model: fakeModel(), dailyCap: 0 });
  env.logs.restore();
  assert.equal(result.reason, 'daily_cap');
  assert.deepEqual(await agentNotes(), []);
});

test('truncated model reply is reported as model_reply_truncated, not as no decisions', async () => {
  const result = await nudgeLapsedLearners(NOW, { model: fakeModel({ truncate: true }) });
  env.logs.restore();
  assert.deepEqual(result, { reason: 'model_reply_truncated', acted: 0, candidates: 1 });
  assert.deepEqual(summaries().map((s) => s.reason), ['model_reply_truncated']);
  assert.deepEqual(await agentNotes(), []);
});

test('unparseable reply and links in the text are refused', async () => {
  const bad = { invoke: async () => ({ content: 'sure!', response_metadata: { stopReason: 'end_turn' } }) };
  assert.equal((await nudgeLapsedLearners(NOW, { model: bad })).reason, 'model_reply_unparseable');
  const linky = { invoke: async () => ({ content: '{"decisions":[{"learner":"L1","action":"nudge","course":"C1","body":"50% discount at https://x.y"}]}', response_metadata: { stopReason: 'end_turn' } }) };
  const result = await nudgeLapsedLearners(NOW, { model: linky });
  env.logs.restore();
  assert.deepEqual([result.reason, result.acted], ['completed', 0]);
  assert.deepEqual(await agentNotes(), []);
});

test('deriveNudgeOversight: sent, opened, came back and no response yet', () => {
  const users = [{ id: 'u1', name: 'A', email: 'a@x.io' }, { id: 'u2', name: 'B', email: 'b@x.io' }, { id: 'u3', name: 'C', email: 'c@x.io' }, { id: 'u4', name: 'D', email: 'd@x.io' }];
  const n = (id, user, created, read = null) => ({ id, user_id: user, type: 'learning_nudge', title: 't', body: 'b', link: '/lessons/x', created_at: created, read_at: read, applied_by_agent: true });
  const notifications = [
    n('n1', 'u1', '2026-11-01T06:30:00.000Z', '2026-11-01T08:00:00.000Z'),
    n('n2', 'u2', '2026-11-01T06:30:00.000Z', '2026-11-01T09:00:00.000Z'),
    n('n3', 'u3', '2026-10-20T06:30:00.000Z'),
    n('n4', 'u4', '2026-11-03T06:30:00.000Z'),
    { id: 'n5', user_id: 'u4', type: 'welcome', title: 'w', body: '', link: null, created_at: '2026-11-03T07:00:00.000Z', read_at: null },
  ];
  const lessonProgress = [{ user_id: 'u1', started_at: '2026-11-01T10:00:00.000Z', completed_at: null }, { user_id: 'u3', started_at: '2026-10-01T10:00:00.000Z', completed_at: null }];
  const { people, stats } = deriveNudgeOversight({ notifications, users, lessonProgress }, NOW);
  const status = Object.fromEntries(people.map((p) => [p.userId, p.status]));
  assert.deepEqual(status, { u1: 'came_back', u2: 'opened', u3: 'no_response', u4: 'sent' });
  assert.deepEqual(stats, { sent: 4, opened: 2, cameBackOfOpened: 1 });
  assert.equal(people.find((p) => p.userId === 'u4').messages.length, 1, 'only agent records are read');
});
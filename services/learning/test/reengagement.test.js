import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IDS, fixtureData, setupTestEnvironment } from '@learnloop/shared/testing';
import { listNotifications } from '@learnloop/notifications/services/inbox';
import {
  DEFAULT_DEPS, FLAG_KEY, MAX_OUTPUT_TOKENS, MODEL_BATCH_SIZE, OUTPUT_TOKENS_PER_ITEM, REENGAGEMENT_JOB, rankCandidates, runReengagement,
} from '../src/agents/reengagement.js';
import { listAgentOversight, personStatus, toOversightMessages, oversightTotals } from '../src/agents/oversight.js';
import { handler } from '../src/handler.js';

const NOW = new Date('2026-11-03T12:00:00Z');
let env;
const setup = (enabled) => { env = setupTestEnvironment({ data: fixtureData(), flags: { [FLAG_KEY]: { enabled } } }); };
beforeEach(() => setup(true));

const summaries = () => env.logs.records.filter((r) => r.job === REENGAGEMENT_JOB);

function spyDeps() {
  const calls = {};
  const deps = Object.fromEntries(Object.entries(DEFAULT_DEPS).map(([name, fn]) => [name, (...args) => {
    calls[name] = (calls[name] ?? 0) + 1;
    return fn(...args);
  }]));
  return { deps, calls };
}

function fakeModel(reply, stopReason = 'end_turn') {
  const calls = [];
  return {
    calls,
    async invoke(messages) {
      calls.push(JSON.parse(messages[1][1]));
      return { content: typeof reply === 'function' ? reply(calls.at(-1)) : reply, response_metadata: { stopReason } };
    },
  };
}

const nudgeAll = ({ learners }) => JSON.stringify({ decisions: learners.map((l) => ({
  ref: l.ref, action: 'nudge', courseId: l.courses[0].courseId,
  title: `Back to ${l.courses[0].courseTitle}`, body: `Your next lesson "${l.courses[0].nextLessonTitle}" is waiting.`,
})) });

async function addSecondLapsedLearner() {
  await env.store.update('enrolments', (all) => { all.push({ id: 'enr_0000000000b2', user_id: IDS.learnerNoSub, course_id: IDS.cloud, enrolled_at: '2026-09-02T10:00:00.000Z' }); });
  await env.store.update('progress', (p) => {
    p.lessons.push({ user_id: IDS.learnerNoSub, course_id: IDS.cloud, lesson_id: IDS.lesson1, status: 'started', started_at: '2026-10-25T10:00:00.000Z', completed_at: null });
    p.courses.push({ user_id: IDS.learnerNoSub, course_id: IDS.cloud, last_activity_at: '2026-10-25T10:00:00.000Z' });
  });
}

test('output budget covers a full batch with headroom', () => {
  assert.ok(MAX_OUTPUT_TOKENS >= OUTPUT_TOKENS_PER_ITEM * MODEL_BATCH_SIZE * 1.5);
});

test('flag off: no model call, nothing created, summary says flag_off', async () => {
  setup(false);
  const model = fakeModel(nudgeAll);
  const out = await runReengagement(NOW, { model });
  assert.equal(out.reason, 'flag_off');
  assert.equal(model.calls.length, 0);
  assert.equal((await listNotifications(IDS.learner)).length, 2);
  assert.deepEqual(summaries().map((s) => [s.reason, s.acted]), [['flag_off', 0]]);
});

test('flag on: uses the deterministic functions and creates one agent-marked nudge to the own next lesson', async () => {
  const { deps, calls } = spyDeps();
  const model = fakeModel(nudgeAll);
  const out = await runReengagement(NOW, { model, deps });
  assert.deepEqual([out.acted, out.candidates, out.reason], [1, 1, 'completed']);
  for (const name of ['daysSinceLastActivity', 'listEnrolledCourseIds', 'listProgressOverview', 'listNotifications', 'nextLessonFor', 'createNotification']) {
    assert.ok(calls[name] > 0, `${name} called`);
  }
  assert.equal(model.calls[0].learners[0].daysInactive, 29);
  assert.ok(!JSON.stringify(model.calls).includes('Finance') && !JSON.stringify(model.calls).includes('example.com'), 'no personal attributes sent');
  const [nudge] = (await listNotifications(IDS.learner)).filter((n) => n.type === 'learning_reminder');
  assert.deepEqual([nudge.applied_by_agent, nudge.link], [true, `/lessons/${IDS.lesson2}`]);
  assert.equal(summaries().length, 1);
});

test('guardrail: a nudge in the last 7 days means no candidates', async () => {
  await env.store.update('notifications', (all) => { all.push({ id: 'ntf_0000000000f9', user_id: IDS.learner, type: 'learning_reminder', title: 't', body: 'b', link: null, created_at: '2026-10-30T09:00:00.000Z', read_at: null, applied_by_agent: true }); });
  const model = fakeModel(nudgeAll);
  assert.equal((await runReengagement(NOW, { model })).reason, 'no_candidates');
  assert.equal(model.calls.length, 0);
});

test('daily cap: the longest stall goes first', async () => {
  await addSecondLapsedLearner();
  const model = fakeModel(nudgeAll);
  const out = await runReengagement(NOW, { model, dailyCap: 1 });
  assert.deepEqual([out.acted, out.candidates], [1, 2]);
  assert.equal(model.calls[0].learners.length, 1);
  assert.equal(model.calls[0].learners[0].daysInactive, 29);
  assert.equal((await listNotifications(IDS.learnerNoSub)).length, 0);
  const ranked = rankCandidates([{ userId: 'a', daysInactive: 9, courses: [{ percent: 90 }] }, { userId: 'b', daysInactive: 29, courses: [{ percent: 10 }] }]);
  assert.deepEqual(ranked.map((c) => c.userId), ['b', 'a']);
});

test('truncated reply is reported as model_reply_truncated, not as no decisions', async () => {
  const model = fakeModel('{"decisions":[{"ref":"c1","action":"nudge","courseId":"crs_', 'max_tokens');
  const out = await runReengagement(NOW, { model });
  assert.deepEqual([out.acted, out.reason], [0, 'model_reply_truncated']);
  assert.deepEqual(summaries().map((s) => s.reason), ['model_reply_truncated']);
});

test('unparseable reply is reported', async () => {
  assert.equal((await runReengagement(NOW, { model: fakeModel('sorry, no') })).reason, 'model_reply_unparseable');
});

test('handler routes the scheduled job; flag off does nothing', async () => {
  setup(false);
  assert.deepEqual(await handler({ listJobs: true }), { jobs: [REENGAGEMENT_JOB] });
  assert.deepEqual(await handler({ job: REENGAGEMENT_JOB }), { ok: true });
  assert.deepEqual(summaries().map((s) => s.reason), ['flag_off']);
});

test('oversight: statuses are derived on read from a small fixture', async () => {
  const at = (d, read = null) => ({ id: `ntf_${d}`, type: 'learning_reminder', applied_by_agent: true, title: 't', body: 'b', link: null, created_at: d, read_at: read });
  const later = new Date('2026-11-20T00:00:00Z');
  const sent = toOversightMessages([at('2026-11-19T09:00:00.000Z')], null);
  assert.equal(personStatus(sent, later), 'sent');
  const silent = toOversightMessages([at('2026-11-01T09:00:00.000Z'), { ...at('2026-11-02T09:00:00.000Z'), type: 'welcome', applied_by_agent: undefined }], '2026-10-01T00:00:00.000Z');
  assert.equal(silent.length, 1);
  assert.equal(personStatus(silent, later), 'no_response');
  const opened = toOversightMessages([at('2026-11-01T09:00:00.000Z', '2026-11-01T10:00:00.000Z')], null);
  assert.equal(personStatus(opened, later), 'opened');
  const back = toOversightMessages([at('2026-11-01T09:00:00.000Z', '2026-11-01T10:00:00.000Z')], '2026-11-02T08:00:00.000Z');
  assert.equal(personStatus(back, later), 'came_back');
  assert.deepEqual(oversightTotals([{ messages: sent }, { messages: opened }, { messages: back }]), { sent: 3, opened: 2, cameBack: 1 });
  await runReengagement(NOW, { model: fakeModel(nudgeAll) });
  const { people, totals } = await listAgentOversight([{ userId: IDS.learner, name: 'Lee Learner', email: 'lee.learner@example.com', organization: null }], NOW);
  assert.deepEqual([people.length, people[0].status, totals.sent], [1, 'sent', 1]);
});
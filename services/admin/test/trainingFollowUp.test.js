import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDS, fixtureData, setupTestEnvironment } from '@learnloop/shared/testing';
import {
  FLAG_KEY, FOLLOW_UP_DEPS, FOLLOW_UP_JOB, MODEL_BATCH_SIZE, MODEL_MAX_TOKENS, OUTPUT_TOKENS_PER_ITEM, runTrainingFollowUp,
} from '../src/agents/trainingFollowUp.js';
import { messageStatus, personStatus, readFollowUpOversight } from '../src/agents/followUpOversight.js';
import { handler } from '../src/handler.js';

// 2026-11-10: SQL for Analysts (Lee) is overdue; Cloud Foundations (Lee, Nia) is due in 10 days.
const NOW = new Date('2026-11-10T12:00:00Z');
const flagOn = () => setupTestEnvironment({ data: fixtureData(), flags: { [FLAG_KEY]: { enabled: true } } });
const summaries = (env) => env.logs.records.filter((r) => r.job === FOLLOW_UP_JOB);
const agentNotes = async (env) => (await env.store.read('notifications')).filter((n) => n.applied_by_agent);

function fakeModel(decide, { stopReason = 'end_turn', raw } = {}) {
  const calls = [];
  return {
    calls,
    async invoke(messages) {
      const input = JSON.parse(messages[1][1]);
      calls.push(input);
      return { content: raw ?? JSON.stringify({ decisions: decide(input.learners) }), response_metadata: { stopReason } };
    },
  };
}

const nudgeFirst = (learners) => learners.map((l) => {
  const a = l.assignments.find((x) => x.allowed.includes('nudge'));
  return { userId: l.userId, action: 'nudge', assignmentId: a.assignmentId, title: `Reminder: ${a.courseTitle}`, body: `Hi ${l.firstName}, ${a.courseTitle} is due on ${a.dueDate}. ${a.lessonsLeft} lessons left.` };
});

function spiedDeps() {
  const calls = {};
  const deps = Object.fromEntries(Object.entries(FOLLOW_UP_DEPS).map(([k, fn]) => [k, (...args) => { calls[k] = (calls[k] ?? 0) + 1; return fn(...args); }]));
  return { calls, deps };
}

test('output budget covers a full batch with 50% headroom', () => {
  assert.ok(MODEL_MAX_TOKENS >= OUTPUT_TOKENS_PER_ITEM * MODEL_BATCH_SIZE * 1.5);
});

test('flag off: the job does nothing and says why', async () => {
  const env = setupTestEnvironment({ data: fixtureData(), flags: {} });
  const model = fakeModel(nudgeFirst);
  const result = await runTrainingFollowUp(NOW, { model });
  assert.equal(await handler({ job: FOLLOW_UP_JOB }).then((r) => r.ok), true);
  env.logs.restore();
  assert.equal(result.reason, 'flag_off');
  assert.equal(model.calls.length, 0);
  assert.deepEqual(await agentNotes(env), []);
  assert.equal(env.ses.sent.length, 0);
  assert.deepEqual(summaries(env).map((s) => [s.reason, s.acted]), [['flag_off', 0], ['flag_off', 0]]);
});

test('flag on: uses the existing training code, most overdue first, sends through sendStaffMessage and marks the record', async () => {
  const env = flagOn();
  const { calls, deps } = spiedDeps();
  const model = fakeModel(nudgeFirst);
  const result = await runTrainingFollowUp(NOW, { model, deps });
  for (const fn of ['listOrganizations', 'listAssignmentsForOrganization', 'listLearners', 'getLearnerTraining', 'sendStaffMessage']) assert.ok(calls[fn] > 0, `${fn} called`);
  assert.deepEqual(model.calls[0].learners.map((l) => l.userId), [IDS.learner, IDS.learnerNoSub]);
  assert.deepEqual([result.reason, result.candidates, result.nudged, result.acted], ['completed', 2, 2, 2]);
  const notes = await agentNotes(env);
  assert.deepEqual(notes.map((n) => [n.user_id, n.type, n.agent_kind, n.assignment_id]).sort(), [
    [IDS.learner, 'staff_message', 'nudge', IDS.assignmentData],
    [IDS.learnerNoSub, 'staff_message', 'nudge', IDS.assignmentManager],
  ]);
  assert.equal(env.ses.sent.length, 2);
  // 7-day window: a second run the same day has nobody to nudge
  const again = await runTrainingFollowUp(NOW, { model });
  env.logs.restore();
  assert.equal(again.reason, 'no_candidates');
  assert.deepEqual(summaries(env).map((s) => s.reason), ['completed', 'no_candidates']);
});

test('the per-run cap keeps the most at-risk learner and reports daily_cap', async () => {
  const env = flagOn();
  const result = await runTrainingFollowUp(NOW, { model: fakeModel(nudgeFirst), maxMessages: 1 });
  env.logs.restore();
  assert.deepEqual([result.reason, result.nudged], ['daily_cap', 1]);
  assert.deepEqual((await agentNotes(env)).map((n) => n.user_id), [IDS.learner]);
});

test('a truncated model reply is reported as model_reply_truncated, nothing is sent', async () => {
  const env = flagOn();
  const model = fakeModel(null, { stopReason: 'max_tokens', raw: '{"decisions":[{"userId":"usr_0000000000a1","action":"nu' });
  const result = await runTrainingFollowUp(NOW, { model });
  env.logs.restore();
  assert.deepEqual([result.reason, result.acted, result.candidates], ['model_reply_truncated', 0, 2]);
  assert.equal(summaries(env)[0].reason, 'model_reply_truncated');
  assert.deepEqual(await agentNotes(env), []);
});

test('an unparseable reply is model_reply_unparseable', async () => {
  const env = flagOn();
  const result = await runTrainingFollowUp(NOW, { model: fakeModel(null, { raw: 'Sure, I will nudge them.' }) });
  env.logs.restore();
  assert.equal(result.reason, 'model_reply_unparseable');
});

test('a message with a score or a comparison is rejected before sending', async () => {
  const env = flagOn();
  const bad = (learners) => nudgeFirst(learners).map((d) => ({ ...d, body: `${d.body} Your colleagues are at 80%.` }));
  const result = await runTrainingFollowUp(NOW, { model: fakeModel(bad) });
  env.logs.restore();
  assert.deepEqual([result.nudged, result.rejected], [0, 2]);
  assert.equal(env.ses.sent.length, 0);
});

test('repeated unopened nudges allow an escalation, proposed to staff only', async () => {
  const env = flagOn();
  await env.store.update('notifications', (all) => {
    for (const [id, at] of [['ntf_0000000000c1', '2026-10-20T07:00:00.000Z'], ['ntf_0000000000c2', '2026-10-27T07:00:00.000Z']]) {
      all.push({ id, user_id: IDS.learner, type: 'staff_message', title: 't', body: 'b', link: '/notifications', created_at: at, read_at: null, applied_by_agent: true, agent_kind: 'nudge', assignment_id: IDS.assignmentData, course_id: IDS.data });
    }
  });
  const decide = (learners) => learners.map((l) => (l.userId === IDS.learner ? { userId: l.userId, action: 'escalate', assignmentId: IDS.assignmentData } : { userId: l.userId, action: 'skip' }));
  const result = await runTrainingFollowUp(NOW, { model: fakeModel(decide) });
  env.logs.restore();
  assert.deepEqual([result.reason, result.escalated, result.nudged, result.skipped], ['completed', 1, 0, 1]);
  const tasks = (await agentNotes(env)).filter((n) => n.agent_kind === 'escalation');
  assert.deepEqual(tasks.map((n) => [n.user_id, n.assignment_ids]), [[IDS.staff, [IDS.assignmentData]]]);
  assert.equal(env.ses.sent.length, 0, 'the manager and the learner are not contacted');
});

test('oversight statuses are derived on read', async () => {
  const sentAt = '2026-11-04T07:00:00.000Z';
  assert.equal(messageStatus({ created_at: sentAt, read_at: null }, null, new Date('2026-11-05T07:00:00Z')), 'sent');
  assert.equal(messageStatus({ created_at: sentAt, read_at: null }, null, NOW), 'no_response');
  assert.equal(messageStatus({ created_at: sentAt, read_at: '2026-11-05T08:00:00.000Z' }, '2026-10-05T10:00:00.000Z', NOW), 'opened');
  assert.equal(messageStatus({ created_at: sentAt, read_at: '2026-11-05T08:00:00.000Z' }, '2026-11-06T10:00:00.000Z', NOW), 'came_back');
  assert.equal(personStatus(['no_response', 'opened', 'sent']), 'opened');

  const env = flagOn();
  await env.store.update('notifications', (all) => {
    all.push({ id: 'ntf_0000000000d1', user_id: IDS.learner, type: 'staff_message', title: 'a', body: 'b', link: '/notifications', created_at: sentAt, read_at: '2026-11-05T08:00:00.000Z', applied_by_agent: true, agent_kind: 'nudge', assignment_id: IDS.assignmentData, course_id: IDS.data });
    all.push({ id: 'ntf_0000000000d2', user_id: IDS.learnerNoSub, type: 'staff_message', title: 'a', body: 'b', link: '/notifications', created_at: sentAt, read_at: null, applied_by_agent: true, agent_kind: 'nudge', assignment_id: IDS.assignmentManager, course_id: IDS.cloud });
  });
  const view = await readFollowUpOversight(NOW);
  env.logs.restore();
  assert.deepEqual(Object.fromEntries(view.people.map((p) => [p.userId, p.status])), { [IDS.learner]: 'opened', [IDS.learnerNoSub]: 'no_response' });
  assert.deepEqual(view.stats, { sent: 2, opened: 1, cameBack: 0 });
  assert.equal(view.deadlines.length, 3);
  assert.deepEqual(view.deadlines.map((d) => d.bucket).sort(), ['at_risk', 'at_risk', 'overdue']);
});
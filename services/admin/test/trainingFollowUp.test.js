import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDS, apiEvent, fixtureData, setupTestEnvironment, testSessionCookie } from '@learnloop/shared/testing';
import {
  DAILY_DRAFT_CAP, FLAG_KEY, MODEL_BATCH_SIZE, MODEL_MAX_TOKENS, OUTPUT_TOKENS_PER_ITEM, TRAINING_FOLLOW_UP_JOB,
  listAgentDrafts, rankCandidates, runTrainingFollowUp,
} from '../src/agents/trainingFollowUp.js';
import { deriveDeadlines, deriveOversight } from '../src/agents/oversight.js';
import { handler } from '../src/handler.js';

const NOW = new Date('2026-11-10T06:00:00Z');
const ON = { [FLAG_KEY]: { enabled: true } };
let env;
const setup = (flags = ON, extra = {}) => {
  const data = fixtureData();
  env = setupTestEnvironment({ data: { ...data, agent_drafts: [], ...extra(data) }, flags });
  return env;
};
const none = () => ({});

function fakeModel(reply) {
  const calls = [];
  return { calls, async invoke(messages) { calls.push(messages); return typeof reply === 'function' ? reply(messages) : reply; } };
}
const inputOf = (messages) => JSON.parse(messages.at(-1)[1]).learners;
const summaries = () => env.logs.records.filter((r) => r['agent.reason']);
const replyWith = (decision) => (messages) => ({
  content: JSON.stringify({ decisions: inputOf(messages).map((l) => ({
    ref: l.ref, decision, focus: 'not_started', title: `Finish ${l.course}`, body: `${l.course} is due ${l.due_date}. Next step: ${l.next_step}.`,
  })) }),
  response_metadata: { stopReason: 'end_turn' },
});

test('output budget covers a full batch with 50% headroom', () => {
  assert.ok(MODEL_MAX_TOKENS >= OUTPUT_TOKENS_PER_ITEM * MODEL_BATCH_SIZE * 1.5);
});

test('flag off: the job does nothing, calls no model and says why', async () => {
  setup({}, none);
  const model = fakeModel(replyWith('nudge'));
  const result = await runTrainingFollowUp(NOW, { model });
  assert.equal(result.reason, 'flag_off');
  assert.equal(model.calls.length, 0);
  assert.deepEqual(await listAgentDrafts(), []);
  assert.equal(await handler({ job: TRAINING_FOLLOW_UP_JOB }).then((r) => r.ok), true);
  const lines = summaries();
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l['agent.reason'] === 'flag_off' && l['agent.acted'] === 0));
});

test('drafts rest on trainingState / getLearnerTraining, never on personal attributes', async () => {
  setup(ON, none);
  const model = fakeModel(replyWith('nudge'));
  const result = await runTrainingFollowUp(NOW, { model });
  assert.equal(model.calls.length, 1);
  const [lee, nia] = inputOf(model.calls[0]);
  assert.deepEqual([lee.learner_name, lee.course, lee.status, lee.percent_complete, lee.days_overdue, lee.next_step, lee.days_since_last_activity, lee.other_open_courses],
    ['Lee Learner', 'SQL for Analysts', 'overdue', 0, 9, 'Select', 35, 1]);
  assert.deepEqual([nia.learner_name, nia.status, nia.days_until_due, nia.days_since_last_activity, nia.escalation_allowed], ['Nia Nosub', 'assigned', 10, null, false]);
  assert.ok(!JSON.stringify(model.calls[0]).includes('Finance'), 'department is never sent to the model');
  const drafts = await listAgentDrafts();
  assert.equal(drafts.length, 2);
  assert.ok(drafts.every((d) => d.applied_by_agent === true && d.status === 'pending'));
  assert.equal(drafts.find((d) => d.learner_id === IDS.learner).due_at, '2026-10-31T23:59:59.000Z');
  assert.deepEqual(result, { acted: 2, candidates: 2, reason: 'completed' });
  assert.equal(summaries().length, 1);
  // a second run the same day: a draft is pending for both, so nobody is a candidate
  assert.equal((await runTrainingFollowUp(NOW, { model })).reason, 'no_candidates');
});

test('the most at-risk go first when the daily cap leaves room for one', async () => {
  const filler = Array.from({ length: DAILY_DRAFT_CAP - 1 }, (_, i) => ({
    id: `agd_${String(i).padStart(12, '0')}`, learner_id: `usr_${String(i).padStart(12, 'f')}`, recipient_id: 'x', kind: 'nudge',
    status: 'rejected', created_at: NOW.toISOString(), applied_by_agent: true,
  }));
  setup(ON, () => ({ agent_drafts: filler }));
  const model = fakeModel(replyWith('nudge'));
  const result = await runTrainingFollowUp(NOW, { model });
  assert.deepEqual(inputOf(model.calls[0]).map((l) => l.learner_name), ['Lee Learner'], 'the overdue learner, not the first id');
  assert.deepEqual(result, { acted: 1, candidates: 2, reason: 'completed' });
  assert.equal((await runTrainingFollowUp(NOW, { model })).reason, 'no_candidates');

  setup(ON, () => ({ agent_drafts: [...filler, { ...filler[0], id: 'agd_ffffffffffff' }] }));
  const capped = fakeModel(replyWith('nudge'));
  assert.equal((await runTrainingFollowUp(NOW, { model: capped })).reason, 'daily_cap');
  assert.equal(capped.calls.length, 0);

  assert.deepEqual(rankCandidates([
    { userId: 'a', focus: { dueAt: '2026-11-20T00:00:00.000Z' }, daysSinceActivity: 1 },
    { userId: 'b', focus: { dueAt: '2026-10-01T00:00:00.000Z' }, daysSinceActivity: 2 },
    { userId: 'c', focus: { dueAt: '2026-11-20T00:00:00.000Z' }, daysSinceActivity: null },
  ]).map((c) => c.userId), ['b', 'c', 'a']);
});

test('a truncated reply is reported as model_reply_truncated, not as nobody to act on', async () => {
  setup(ON, none);
  const model = fakeModel({ content: '{"decisions":[{"ref":"L1","decision":"nudge","title":"Fin', response_metadata: { stopReason: 'max_tokens' } });
  const result = await runTrainingFollowUp(NOW, { model });
  assert.deepEqual(result, { acted: 0, candidates: 2, reason: 'model_reply_truncated' });
  const [line] = summaries();
  assert.deepEqual([line['agent.reason'], line['agent.acted'], line['agent.candidates'], line.level], ['model_reply_truncated', 0, 2, 'warn']);
  assert.deepEqual(await listAgentDrafts(), []);
});

test('an unparseable reply is reported as model_reply_unparseable', async () => {
  setup(ON, none);
  const result = await runTrainingFollowUp(NOW, { model: fakeModel({ content: 'Sure, here you go.', response_metadata: { stopReason: 'end_turn' } }) });
  assert.equal(result.reason, 'model_reply_unparseable');
});

test('guardrails: 7-day spacing after a staff message, escalation only after two unread nudges', async () => {
  setup(ON, (data) => ({ notifications: [...data.notifications, { id: 'ntf_0000000000e9', user_id: IDS.learner, type: 'staff_message', title: 't', body: 'b', link: '/notifications', created_at: '2026-11-08T08:00:00.000Z', read_at: null }] }));
  const model = fakeModel(replyWith('escalate'));
  const result = await runTrainingFollowUp(NOW, { model });
  assert.deepEqual(inputOf(model.calls[0]).map((l) => l.learner_name), ['Nia Nosub']);
  assert.deepEqual(result, { acted: 0, candidates: 1, reason: 'completed' }, 'an escalation that is not allowed is dropped in code');
});

test('HTTP: staff approve a draft and it is sent through sendStaffMessage; oversight derives its status', async () => {
  setup(ON, none);
  await runTrainingFollowUp(NOW, { model: fakeModel(replyWith('nudge')) });
  const staff = await testSessionCookie({ userId: IDS.staff, role: 'staff' });
  const list = JSON.parse((await handler(apiEvent('GET /api/admin/agent-drafts', { cookie: staff }))).body);
  assert.equal(list.drafts.length, 2);
  const lee = list.drafts.find((d) => d.learnerId === IDS.learner);
  assert.equal(lee.appliedByAgent, true);
  env.logs.clear();
  const approve = await handler(apiEvent('POST /api/admin/agent-drafts/{draftId}/approve', { cookie: staff, pathParameters: { draftId: lee.id }, body: {} }));
  assert.equal(approve.statusCode, 200);
  assert.equal(env.ses.sent.length, 1);
  assert.equal(env.logs.events('staff_message_sent').length, 1);
  const again = await handler(apiEvent('POST /api/admin/agent-drafts/{draftId}/approve', { cookie: staff, pathParameters: { draftId: lee.id }, body: {} }));
  assert.equal(again.statusCode, 409);
  const stored = (await listAgentDrafts()).find((d) => d.id === lee.id);
  assert.equal(stored.status, 'sent');
  assert.ok(stored.notification_id);
  const view = JSON.parse((await handler(apiEvent('GET /api/admin/agent-oversight', { cookie: staff }))).body);
  assert.deepEqual(view.people.map((p) => [p.name, p.status]), [['Lee Learner', 'sent']]);
  assert.equal(view.deadlines.organization[0].group, 'Acme Freight');
  const learner = await testSessionCookie({ userId: IDS.learner });
  assert.equal((await handler(apiEvent('GET /api/admin/agent-oversight', { cookie: learner }))).statusCode, 403);
  env.logs.restore();
});

test('HTTP: the review and oversight routes are off with the flag', async () => {
  setup({}, none);
  const staff = await testSessionCookie({ userId: IDS.staff, role: 'staff' });
  assert.equal((await handler(apiEvent('GET /api/admin/agent-drafts', { cookie: staff }))).statusCode, 404);
  assert.equal((await handler(apiEvent('GET /api/admin/agent-oversight', { cookie: staff }))).statusCode, 404);
  env.logs.restore();
});

test('deriveOversight: Sent, Opened, Came back and No response yet from existing records', () => {
  const sent = (id, to, at, ntf, extra = {}) => ({ id, learner_id: to, recipient_id: to, kind: 'nudge', course_title: 'C', title: 'T', status: 'sent', sent_at: at, notification_id: ntf, applied_by_agent: true, ...extra });
  const drafts = [
    sent('agd_a2', 'a', '2026-11-05T08:00:00.000Z', 'n_a2'),
    sent('agd_a1', 'a', '2026-11-01T08:00:00.000Z', 'n_a1'),
    sent('agd_b', 'b', '2026-11-01T08:00:00.000Z', 'n_b'),
    sent('agd_c', 'c', '2026-11-09T08:00:00.000Z', 'n_c'),
    sent('agd_d', 'd', '2026-10-20T08:00:00.000Z', 'n_d'),
    { ...sent('agd_e', 'e', null, null), status: 'pending' },
    sent('agd_f', 'f', '2026-11-01T08:00:00.000Z', 'n_f', { applied_by_agent: undefined }),
  ];
  const notifications = [{ id: 'n_a1', read_at: '2026-11-01T09:00:00.000Z' }, { id: 'n_b', read_at: '2026-11-02T09:00:00.000Z' }, { id: 'n_c', read_at: null }];
  const lastActivityByLearner = new Map([['a', '2026-11-03T10:00:00.000Z'], ['b', '2026-10-01T10:00:00.000Z']]);
  const names = new Map([['a', 'Ann'], ['b', 'Ben'], ['c', 'Cy'], ['d', 'Di']]);
  const { people, totals } = deriveOversight({ drafts, notifications, lastActivityByLearner, names, now: NOW });
  assert.deepEqual(Object.fromEntries(people.map((p) => [p.name, p.status])), { Ann: 'came_back', Ben: 'opened', Cy: 'sent', Di: 'no_response' });
  assert.deepEqual(people.find((p) => p.name === 'Ann').messages.map((m) => m.id), ['agd_a1', 'agd_a2'], 'oldest first');
  assert.deepEqual(totals, { sent: 5, opened: 2, cameBack: 1, cameBackOfOpened: 1 });
});

test('deriveDeadlines: on time, overdue and at risk by organization and per deadline', () => {
  const t = (org, assignments) => ({ learner: { organization: { name: org }, manager: null }, assignments });
  const view = deriveDeadlines([
    t('Acme', [{ status: 'completed', completedOnTime: true, dueAt: '2026-11-01T00:00:00.000Z' }, { status: 'overdue', dueAt: '2026-11-01T00:00:00.000Z' }]),
    t('Beta', [{ status: 'assigned', dueAt: '2026-11-15T00:00:00.000Z' }, { status: 'in_progress', dueAt: '2027-01-15T00:00:00.000Z' }]),
  ], NOW);
  assert.deepEqual(view.organization.map((r) => [r.group, r.on_time, r.overdue, r.at_risk, r.on_track]), [['Acme', 1, 1, 0, 0], ['Beta', 0, 0, 1, 1]]);
  assert.deepEqual(view.byDeadline.map((r) => [r.group, r.total]), [['2026-11-01', 2], ['2026-11-15', 1], ['2027-01-15', 1]]);
  assert.equal(view.manager[0].group, 'No manager');
});
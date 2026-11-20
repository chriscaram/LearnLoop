import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IDS, fixtureData, setupTestEnvironment } from '@learnloop/shared/testing';
import { createNotification, listNotifications, markRead } from '@learnloop/notifications/services/inbox';
import {
  DEFAULT_DEPS, FLAG_KEY, MAX_OUTPUT_TOKENS, MODEL_BATCH_SIZE, OUTPUT_TOKENS_PER_ITEM, orderByRisk, runLessonReminders,
} from '../src/jobs/lessonReminders.js';
import { GA_OVERSIGHT, deriveMessages, listReminderOversight, personStatus } from '../src/jobs/lessonRemindersOversight.js';
import { recordLessonProgress } from '../src/services/progress.js';

const NOW = new Date('2026-11-03T12:00:00Z');
let env;
const start = (on) => { env = setupTestEnvironment({ data: fixtureData(), flags: on ? { [FLAG_KEY]: { enabled: true } } : {} }); };
beforeEach(() => start(true));

const GOOD_REPLY = JSON.stringify({ decisions: [{
  ref: 'L1', nudge: true, courseId: IDS.cloud, title: 'Pick up Cloud Foundations',
  body: 'You are 17% through Cloud Foundations with 2 lessons left. Your next lesson is Two.',
}] });

function fakeModel(reply, stopReason = 'end_turn') {
  const seen = [];
  return { seen, invoke: async (messages) => { seen.push(messages); return { content: reply, response_metadata: { stopReason } }; } };
}

/** Real dependencies wrapped to count calls, with the model replaced. */
function spyDeps(model, extra = {}) {
  const calls = {};
  const deps = { createModel: async () => model, ...extra };
  for (const name of ['listSubscriptions', 'latestSubscriptionByUser', 'listNotifications', 'daysSinceLastActivity',
    'getLastActivityAt', 'listProgressOverview', 'nextLessonFor', 'validateMessage', 'createNotification', 'sendEmail']) {
    deps[name] = (...args) => { calls[name] = (calls[name] ?? 0) + 1; return DEFAULT_DEPS[name](...args); };
  }
  return { deps, calls };
}

const summary = () => env.logs.records.filter((r) => r.message === 'lesson_reminders_summary');
const agentReminders = async (userId) => (await listNotifications(userId)).filter((n) => n.type === 'lesson_reminder');

async function addStalledLearner(id, lastActivityAt) {
  await env.store.update('users', (u) => { u.push({ id, email: `${id}@example.com`, name: 'Cy', role: 'learner', created_at: '2026-06-01T09:00:00.000Z' }); });
  await env.store.update('subscriptions', (s) => { s.push({ id: `sub_${id.slice(4)}`, user_id: id, plan: 'monthly', price_usd: 19, status: 'active', started_at: '2026-06-10T08:00:00.000Z', current_period_start: '2026-10-10T08:00:00.000Z', current_period_end: '2026-11-10T08:00:00.000Z', cancelled_at: null }); });
  await env.store.update('enrolments', (e) => { e.push({ id: `enr_${id.slice(4)}`, user_id: id, course_id: IDS.cloud, enrolled_at: '2026-08-01T10:00:00.000Z' }); });
  await env.store.update('progress', (p) => { p.courses.push({ user_id: id, course_id: IDS.cloud, last_activity_at: lastActivityAt }); });
}

test('output budget covers a full batch with 50% headroom', () => {
  assert.ok(MAX_OUTPUT_TOKENS >= OUTPUT_TOKENS_PER_ITEM * MODEL_BATCH_SIZE * 1.5);
});

test('flag off: the job does nothing and logs flag_off', async () => {
  start(false);
  const model = fakeModel(GOOD_REPLY);
  const { deps, calls } = spyDeps(model);
  await runLessonReminders(NOW, deps);
  env.logs.restore();
  assert.equal(model.seen.length, 0);
  assert.equal(calls.listSubscriptions, undefined);
  assert.deepEqual(await agentReminders(IDS.learner), []);
  assert.equal(env.ses.sent.length, 0);
  assert.deepEqual(summary().map((s) => [s.reason, s.acted, s.candidates]), [['flag_off', 0, 0]]);
});

test('flag on: calls the deterministic code, nudges the stalled subscriber with the nextLessonFor link', async () => {
  const model = fakeModel(GOOD_REPLY);
  const { deps, calls } = spyDeps(model);
  await runLessonReminders(NOW, deps);
  env.logs.restore();
  for (const name of ['latestSubscriptionByUser', 'daysSinceLastActivity', 'listProgressOverview', 'listNotifications', 'nextLessonFor', 'validateMessage', 'createNotification', 'sendEmail']) {
    assert.ok(calls[name] > 0, `${name} was called`);
  }
  const payload = JSON.parse(model.seen[0][1][1]);
  assert.deepEqual(payload.learners.map((l) => [l.ref, l.daysInactive]), [['L1', 29]], 'only the active subscriber, no name or org');
  assert.ok(!JSON.stringify(payload).includes('Lee') && !JSON.stringify(payload).includes('Finance'));
  const [reminder] = await agentReminders(IDS.learner);
  assert.equal(reminder.link, `/lessons/${IDS.lesson2}`);
  assert.equal(reminder.applied_by_agent, true);
  assert.equal(env.ses.sent.length, 1);
  assert.deepEqual(summary().map((s) => [s.reason, s.acted, s.candidates]), [['completed', 1, 1]]);
});

test('truncated reply is reported as model_reply_truncated, never as "nobody to nudge"', async () => {
  const model = fakeModel('{"decisions":[{"ref":"L1","nudge":tru', 'max_tokens');
  await runLessonReminders(NOW, spyDeps(model).deps);
  env.logs.restore();
  assert.deepEqual(await agentReminders(IDS.learner), []);
  assert.deepEqual(summary().map((s) => [s.reason, s.acted, s.candidates]), [['model_reply_truncated', 0, 1]]);
});

test('unparseable reply and invented links are rejected', async () => {
  await runLessonReminders(NOW, spyDeps(fakeModel('Sure, here you go!')).deps);
  assert.equal(summary().at(-1).reason, 'model_reply_unparseable');
  const promo = JSON.stringify({ decisions: [{ ref: 'L1', nudge: true, courseId: IDS.cloud, title: 'Come back', body: 'Get a 50% discount at https://x.example' }] });
  await runLessonReminders(NOW, spyDeps(fakeModel(promo)).deps);
  env.logs.restore();
  assert.deepEqual([summary().at(-1).reason, summary().at(-1).acted], ['completed', 0]);
  assert.deepEqual(await agentReminders(IDS.learner), []);
});

test('guardrails: one nudge per 7 days, at most 3 unanswered, daily cap', async () => {
  const nudge = (at) => createNotification(IDS.learner, { type: 'lesson_reminder', title: 't', body: 'b', link: '/x', appliedByAgent: true }, new Date(at));
  await nudge('2026-11-01T09:00:00Z');
  const model = fakeModel(GOOD_REPLY);
  await runLessonReminders(NOW, spyDeps(model).deps);
  assert.equal(summary().at(-1).reason, 'no_candidates');

  start(true);
  for (const at of ['2026-10-10T09:00:00Z', '2026-10-17T09:00:00Z', '2026-10-24T09:00:00Z']) await nudge(at);
  await runLessonReminders(NOW, spyDeps(model).deps);
  assert.equal(summary().at(-1).reason, 'no_candidates');

  start(true);
  await runLessonReminders(NOW, spyDeps(model, { dailyCap: 0 }).deps);
  env.logs.restore();
  assert.deepEqual([summary().at(-1).reason, summary().at(-1).candidates], ['daily_cap', 1]);
  assert.equal(model.seen.length, 0);
});

test('under a cap the longest-stalled learner goes first', async () => {
  await addStalledLearner('usr_0000000000c3', '2026-09-01T10:00:00.000Z');
  const model = fakeModel('{"decisions":[{"ref":"L1","nudge":false}]}');
  await runLessonReminders(NOW, spyDeps(model, { runLimit: 1 }).deps);
  env.logs.restore();
  const payload = JSON.parse(model.seen[0][1][1]);
  assert.deepEqual(payload.learners.map((l) => l.daysInactive), [63]);
  assert.deepEqual([summary().at(-1).candidates, summary().at(-1).selected], [2, 1]);
  const c = (id, days, percent) => ({ user: { id }, daysInactive: days, courses: [{ percent }] });
  assert.deepEqual(orderByRisk([c('a', 10, 90), c('b', 30, 5), c('c', 10, 95)]).map((x) => x.user.id), ['b', 'c', 'a']);
});

test('oversight read: statuses derived from agent notifications and lesson progress', async () => {
  assert.equal(GA_OVERSIGHT, 'ga-oversight');
  const m = (createdAt, extra = {}) => ({ createdAt, opened: false, cameBackAt: null, ...extra });
  assert.equal(personStatus([m('2026-11-02T09:00:00Z')], NOW), 'sent');
  assert.equal(personStatus([m('2026-10-25T09:00:00Z')], NOW), 'no_response');
  assert.equal(personStatus([m('2026-10-25T09:00:00Z', { opened: true })], NOW), 'opened');
  const msgs = deriveMessages([
    { id: 'ntf_2', applied_by_agent: true, created_at: '2026-10-28T09:00:00.000Z', read_at: null },
    { id: 'ntf_1', applied_by_agent: true, created_at: '2026-10-20T09:00:00.000Z', read_at: null },
    { id: 'ntf_x', created_at: '2026-10-21T09:00:00.000Z', read_at: null },
  ], ['2026-10-29T08:00:00.000Z']);
  assert.deepEqual(msgs.map((x) => [x.id, x.cameBackAt]), [['ntf_1', null], ['ntf_2', '2026-10-29T08:00:00.000Z']]);

  await createNotification(IDS.learner, { type: 'lesson_reminder', title: 'A', body: 'B', link: '/l', appliedByAgent: true }, new Date('2026-10-20T09:00:00Z'));
  const second = await createNotification(IDS.learner, { type: 'lesson_reminder', title: 'C', body: 'D', link: '/l', appliedByAgent: true }, new Date('2026-10-28T09:00:00Z'));
  await markRead(IDS.learner, second.id, new Date('2026-10-28T10:00:00Z'));
  await recordLessonProgress(IDS.learner, IDS.lesson3, 'started', new Date('2026-10-29T08:00:00Z'));
  const { people, stats } = await listReminderOversight(NOW);
  env.logs.restore();
  assert.deepEqual(people.map((p) => [p.userId, p.status, p.messages.length]), [[IDS.learner, 'came_back', 2]]);
  assert.deepEqual(people[0].messages.map((x) => [x.title, x.opened, x.appliedByAgent]), [['A', false, true], ['C', true, true]]);
  assert.deepEqual(stats, { sent: 2, opened: 1, cameBack: 1 });
});
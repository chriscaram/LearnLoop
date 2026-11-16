import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IDS, apiEvent, checkRoutesTable, fixtureData, setupTestEnvironment, testSessionCookie } from '@learnloop/shared/testing';
import { latestSubscriptionByUser, listLearners, planLabel } from '../src/services/learners.js';
import { sendStaffMessage, validateMessage } from '../src/services/messages.js';
import { getFlags, updateFlag } from '../src/services/flags.js';
import { SUPPORT_BACKLOG_JOB, checkSupportBacklog, listSupportQueue, replyToLearner } from '../src/services/support.js';
import { routes } from '../src/routes.js';
import { handler } from '../src/handler.js';

let env;
beforeEach(() => { env = setupTestEnvironment({ data: fixtureData(), flags: { new_catalog_filters: { enabled: false } } }); });
const NOW = new Date('2026-11-03T12:00:00Z');

test('routes table (all staff-only)', () => {
  checkRoutesTable(assert, routes, { service: 'admin', expected: [
    'GET /api/admin/learners', 'POST /api/admin/learners/{userId}/message', 'GET /api/admin/flags', 'PUT /api/admin/flags/{flagKey}',
    'GET /api/admin/support-requests', 'POST /api/admin/support-requests/{requestId}/reply',
  ] });
  assert.ok(routes.every((r) => r.auth === 'staff'));
});

test('latestSubscriptionByUser and planLabel', () => {
  const subs = [
    { user_id: 'a', started_at: '2026-01-01', status: 'cancelled' },
    { user_id: 'a', started_at: '2026-05-01', status: 'active' },
  ];
  assert.equal(latestSubscriptionByUser(subs).get('a').status, 'active');
  assert.equal(planLabel(null), 'No plan');
  assert.equal(planLabel({ status: 'cancelled' }), 'Monthly (cancelled)');
});

test('listLearners uses learning progress for last activity', async () => {
  const rows = await listLearners(NOW);
  assert.deepEqual(rows.map((r) => r.name), ['Lee Learner', 'Nia Nosub']);
  assert.equal(rows[0].daysSinceLastActivity, 29);
  assert.deepEqual(rows[0].enrolledCourses, ['Cloud Foundations']);
  assert.equal(rows[1].plan, 'No plan');
});

test('validateMessage', () => {
  assert.deepEqual(validateMessage({ title: ' Hi ', body: ' There ' }), { title: 'Hi', body: 'There' });
  assert.throws(() => validateMessage({ title: '', body: 'x' }), (e) => e.status === 400);
});

test('sendStaffMessage creates a staff_message notification and sends the email', async () => {
  const result = await sendStaffMessage(IDS.staff, IDS.learner, { title: 'Course update', body: 'New exercises are available.' }, NOW);
  assert.equal(result.email, 'sent');
  assert.equal(env.ses.sent[0].Message.Subject.Data, 'Course update');
  await assert.rejects(sendStaffMessage(IDS.staff, IDS.staff, { title: 'a', body: 'b' }), (e) => e.status === 404);
  env.logs.restore();
  const names = env.logs.events().map((e) => [e.event, e.actor_type]);
  assert.deepEqual(names, [['notification_created', 'system'], ['staff_message_sent', 'staff'], ['email_sent', 'system']]);
  assert.ok(!env.logs.lines.join('').includes('New exercises'), 'free text is never logged');
});

test('getFlags and updateFlag', async () => {
  assert.equal((await getFlags())[0].enabled, false);
  await updateFlag('new_catalog_filters', true);
  assert.equal((await getFlags())[0].enabled, true);
  await assert.rejects(updateFlag('new_catalog_filters', 'yes'), (e) => e.status === 400);
  env.logs.restore();
  const [event] = env.logs.events('feature_flag_changed');
  assert.equal(event['entity.id'], 'new_catalog_filters');
  assert.equal(event.actor_type, 'staff');
});

test('HTTP: learners need staff role; message and flag toggle work', async () => {
  const learner = await testSessionCookie({ userId: IDS.learner });
  assert.equal((await handler(apiEvent('GET /api/admin/learners', { cookie: learner }))).statusCode, 403);
  const staff = await testSessionCookie({ userId: IDS.staff, role: 'staff' });
  const list = JSON.parse((await handler(apiEvent('GET /api/admin/learners', { cookie: staff }))).body);
  assert.equal(list.learners.length, 2);
  const msg = await handler(apiEvent('POST /api/admin/learners/{userId}/message', { cookie: staff, pathParameters: { userId: IDS.learner }, body: { title: 'Hello', body: 'Thanks for your question about the course.' } }));
  assert.equal(msg.statusCode, 200);
  const flag = await handler(apiEvent('PUT /api/admin/flags/{flagKey}', { cookie: staff, pathParameters: { flagKey: 'new_catalog_filters' }, body: { enabled: true } }));
  env.logs.restore();
  assert.equal(JSON.parse(flag.body).flag.enabled, true);
});

test('listSupportQueue: open questions oldest first with the learner and whether the reply is overdue', async () => {
  const open = await listSupportQueue('open', NOW);
  assert.deepEqual(open.map((r) => [r.id, r.learner.name, r.overdue]), [[IDS.supportOpen, 'Lee Learner', true]]);
  assert.equal(open[0].learner.email, 'lee.learner@example.com');
  const early = await listSupportQueue('open', new Date('2026-10-31T09:00:00Z'));
  assert.equal(early[0].overdue, false);
  const answered = await listSupportQueue('answered', NOW);
  assert.deepEqual(answered.map((r) => [r.id, r.overdue, r.replies[0].staffName]), [[IDS.supportAnswered, false, 'Sam']]);
});

test('replyToLearner answers the question and names the staff member', async () => {
  const { supportRequest } = await replyToLearner(IDS.staff, IDS.supportOpen, { body: 'Yes, from next month.' }, NOW);
  env.logs.restore();
  assert.equal(supportRequest.status, 'answered');
  assert.equal(supportRequest.replies[0].staffName, 'Sam');
  assert.deepEqual((await listSupportQueue('open', NOW)), []);
  assert.equal(env.logs.events('support_reply_sent')[0].actor_type, 'staff');
});

test('the daily backlog check warns once per overdue open question', async () => {
  assert.equal(await checkSupportBacklog(new Date('2026-10-31T07:00:00Z')), 0);
  assert.equal(await checkSupportBacklog(new Date('2026-11-03T07:00:00Z')), 1);
  env.logs.restore();
  const warnings = env.logs.records.filter((r) => r.kind === 'log');
  assert.equal(warnings.length, 1);
  assert.deepEqual([warnings[0].level, warnings[0]['error.type'], warnings[0].message], ['warn', 'SupportReplyTimeout', 'support request waiting for a reply']);
});

test('the backlog check is a scheduled job of the admin function, logged as the system', async () => {
  assert.deepEqual(await handler({ listJobs: true }), { jobs: [SUPPORT_BACKLOG_JOB] });
  env.logs.clear();
  assert.deepEqual(await handler({ job: SUPPORT_BACKLOG_JOB }), { ok: true });
  env.logs.restore();
  for (const r of env.logs.records) {
    assert.equal(r['service.name'], 'admin');
    assert.equal(r['user.id'], undefined);
  }
});

test('HTTP: support queue and reply are staff-only', async () => {
  const learner = await testSessionCookie({ userId: IDS.learner });
  assert.equal((await handler(apiEvent('GET /api/admin/support-requests', { cookie: learner }))).statusCode, 403);
  const staff = await testSessionCookie({ userId: IDS.staff, role: 'staff' });
  const open = JSON.parse((await handler(apiEvent('GET /api/admin/support-requests', { cookie: staff }))).body);
  assert.equal(open.supportRequests.length, 1);
  const bad = await handler(apiEvent('GET /api/admin/support-requests', { cookie: staff, query: { status: 'closed' } }));
  assert.equal(bad.statusCode, 400);
  const reply = await handler(apiEvent('POST /api/admin/support-requests/{requestId}/reply', { cookie: staff, pathParameters: { requestId: IDS.supportOpen }, body: { body: 'Done.' } }));
  const missing = await handler(apiEvent('POST /api/admin/support-requests/{requestId}/reply', { cookie: staff, pathParameters: { requestId: 'sup_ffffffffffff' }, body: { body: 'Done.' } }));
  const answered = JSON.parse((await handler(apiEvent('GET /api/admin/support-requests', { cookie: staff, query: { status: 'answered' } }))).body);
  env.logs.restore();
  assert.equal(reply.statusCode, 200);
  assert.equal(missing.statusCode, 404);
  assert.equal(answered.supportRequests.length, 2);
});

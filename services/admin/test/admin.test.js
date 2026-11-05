import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IDS, apiEvent, checkRoutesTable, fixtureData, setupTestEnvironment, testSessionCookie } from '@learnloop/shared/testing';
import { latestSubscriptionByUser, listLearners, planLabel } from '../src/services/learners.js';
import { sendStaffMessage, validateMessage } from '../src/services/messages.js';
import { getFlags, updateFlag } from '../src/services/flags.js';
import { routes } from '../src/routes.js';
import { handler } from '../src/handler.js';

let env;
beforeEach(() => { env = setupTestEnvironment({ data: fixtureData(), flags: { new_catalog_filters: { enabled: false } } }); });
const NOW = new Date('2026-11-03T12:00:00Z');

test('routes table (all staff-only)', () => {
  checkRoutesTable(assert, routes, { service: 'admin', expected: [
    'GET /api/admin/learners', 'POST /api/admin/learners/{userId}/message', 'GET /api/admin/flags', 'PUT /api/admin/flags/{flagKey}',
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

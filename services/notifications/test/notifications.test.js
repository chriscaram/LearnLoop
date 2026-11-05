import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IDS, apiEvent, checkRoutesTable, fixtureData, setupTestEnvironment, testSessionCookie } from '@learnloop/shared/testing';
import { NOTIFICATION_TYPES, createNotification, listNotifications, markRead, newNotificationId, toPublicNotification, unreadCount } from '../src/services/inbox.js';
import { EMAIL_TEMPLATES, renderEmail, sendEmail } from '../src/services/email.js';
import { routes } from '../src/routes.js';
import { handler } from '../src/handler.js';

let env;
beforeEach(() => { env = setupTestEnvironment({ data: fixtureData() }); });

test('routes table', () => {
  checkRoutesTable(assert, routes, { service: 'notifications', expected: [
    'GET /api/me/notifications', 'POST /api/me/notifications/{notificationId}/read', 'GET /api/me/notifications/unread-count',
  ] });
});

test('notification types are transactional only', () => {
  assert.deepEqual([...NOTIFICATION_TYPES], ['welcome', 'payment_receipt', 'new_course_published', 'staff_message']);
  assert.match(newNotificationId(), /^ntf_[0-9a-f]{12}$/);
});

test('createNotification stores it unread and logs notification_created', async () => {
  const n = await createNotification(IDS.learner, { type: 'staff_message', title: 'Hello', body: 'Body', link: '/notifications' }, new Date('2026-10-20T10:00:00Z'));
  env.logs.restore();
  assert.equal(n.read_at, null);
  assert.equal(await unreadCount(IDS.learner), 2);
  assert.equal(env.logs.events('notification_created')[0]['entity.id'], n.id);
  await assert.rejects(createNotification(IDS.learner, { type: 'promo', title: 'x' }), TypeError);
});

test('listNotifications is newest first and limited', async () => {
  const all = await listNotifications(IDS.learner);
  assert.deepEqual(all.map((n) => n.id), [IDS.ntfUnread, IDS.ntfRead]);
  assert.equal((await listNotifications(IDS.learner, { limit: 1 })).length, 1);
  assert.deepEqual(await listNotifications(IDS.staff), []);
});

test('markRead logs notification_opened once and ignores other users', async () => {
  await markRead(IDS.learner, IDS.ntfUnread);
  await markRead(IDS.learner, IDS.ntfUnread);
  assert.equal(await markRead(IDS.staff, IDS.ntfUnread), null);
  env.logs.restore();
  assert.equal(await unreadCount(IDS.learner), 0);
  assert.equal(env.logs.events('notification_opened').length, 1);
});

test('unreadCount and toPublicNotification', async () => {
  assert.equal(await unreadCount(IDS.learner), 1);
  assert.equal(toPublicNotification(fixtureData().notifications[0]).read, true);
});

test('renderEmail has the three transactional templates', () => {
  assert.deepEqual(Object.keys(EMAIL_TEMPLATES), ['welcome', 'payment_receipt', 'staff_message']);
  assert.match(renderEmail('payment_receipt', { name: 'A', amount: 19, periodEnd: '2026-12-01' }).text, /19 USD/);
  assert.throws(() => renderEmail('newsletter', {}), TypeError);
});

test('sendEmail uses SES and logs email_sent; failures return ok:false', async () => {
  const sent = await sendEmail({ to: 'lee.learner@example.com', template: 'welcome', data: { name: 'Lee' } });
  assert.equal(sent.ok, true);
  assert.deepEqual(env.ses.sent[0].Destination.ToAddresses, ['lee.learner@example.com']);
  env.ses.fail = true;
  const failed = await sendEmail({ to: 'lee.learner@example.com', template: 'welcome', data: { name: 'Lee' } });
  env.logs.restore();
  assert.deepEqual(failed, { ok: false, errorType: 'MessageRejected' });
  const events = env.logs.events('email_sent');
  assert.deepEqual(events.map((e) => e.outcome), ['ok', 'failed']);
  assert.ok(!env.logs.lines.join('').includes('example.com'));
});

test('sendEmail honours EMAIL_RECIPIENT_OVERRIDE (SES sandbox)', async () => {
  process.env.EMAIL_RECIPIENT_OVERRIDE = 'verified@example.org';
  try {
    await sendEmail({ to: 'lee.learner@example.com', template: 'welcome', data: { name: 'Lee' } });
  } finally {
    delete process.env.EMAIL_RECIPIENT_OVERRIDE;
    env.logs.restore();
  }
  assert.deepEqual(env.ses.sent[0].Destination.ToAddresses, ['verified@example.org']);
});

test('HTTP: list, unread count, mark read', async () => {
  const cookie = await testSessionCookie({ userId: IDS.learner });
  const count = JSON.parse((await handler(apiEvent('GET /api/me/notifications/unread-count', { cookie }))).body);
  assert.equal(count.unread, 1);
  const list = JSON.parse((await handler(apiEvent('GET /api/me/notifications', { cookie }))).body);
  assert.equal(list.notifications.length, 2);
  const read = await handler(apiEvent('POST /api/me/notifications/{notificationId}/read', { cookie, pathParameters: { notificationId: IDS.ntfUnread } }));
  const missing = await handler(apiEvent('POST /api/me/notifications/{notificationId}/read', { cookie, pathParameters: { notificationId: 'ntf_ffffffffffff' } }));
  env.logs.restore();
  assert.equal(read.statusCode, 200);
  assert.equal(missing.statusCode, 404);
});

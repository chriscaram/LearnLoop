import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IDS, apiEvent, checkRoutesTable, fixtureData, setupTestEnvironment, testSessionCookie } from '@learnloop/shared/testing';
import { NOTIFICATION_TYPES, createNotification, listNotifications, markRead, newNotificationId, toPublicNotification, unreadCount } from '../src/services/inbox.js';
import { EMAIL_TEMPLATES, renderEmail, sendEmail } from '../src/services/email.js';
import {
  SUPPORT_TOPICS, createSupportRequest, listSupportRequestsByStatus, listUserSupportRequests, newSupportRequestId,
  overdueRequests, replyDueAt, replyToSupportRequest, staffNames, toPublicSupportRequest,
} from '../src/services/support.js';
import { routes } from '../src/routes.js';
import { handler } from '../src/handler.js';

let env;
beforeEach(() => { env = setupTestEnvironment({ data: fixtureData() }); });

test('routes table', () => {
  checkRoutesTable(assert, routes, { service: 'notifications', expected: [
    'GET /api/me/notifications', 'POST /api/me/notifications/{notificationId}/read', 'GET /api/me/notifications/unread-count',
    'GET /api/me/support-requests', 'POST /api/me/support-requests',
  ] });
});

test('notification types are transactional only', () => {
  assert.deepEqual([...NOTIFICATION_TYPES], ['welcome', 'payment_receipt', 'new_course_published', 'staff_message', 'support_reply']);
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

test('support: topics, ids and the one-business-day reply target', () => {
  assert.deepEqual([...SUPPORT_TOPICS], ['billing', 'certificate', 'account', 'course_content', 'other']);
  assert.match(newSupportRequestId(), /^sup_[0-9a-f]{12}$/);
  assert.equal(replyDueAt('2026-11-03T10:00:00.000Z').toISOString(), '2026-11-04T10:00:00.000Z'); // Tuesday -> Wednesday
  assert.equal(replyDueAt('2026-11-06T15:00:00.000Z').toISOString(), '2026-11-09T15:00:00.000Z'); // Friday -> Monday
  assert.equal(replyDueAt('2026-11-07T10:00:00.000Z').toISOString(), '2026-11-09T10:00:00.000Z'); // Saturday -> Monday
  const requests = fixtureData().support_requests;
  assert.deepEqual(overdueRequests(requests, new Date('2026-10-31T15:59:00Z')).map((r) => r.id), []);
  assert.deepEqual(overdueRequests(requests, new Date('2026-11-02T16:00:00Z')).map((r) => r.id), [IDS.supportOpen]);
});

test('createSupportRequest validates, stores the question and logs support_request_created without its text', async () => {
  const NOW = new Date('2026-11-03T12:00:00Z');
  const r = await createSupportRequest(IDS.learner, { topic: 'account', body: '  How do I change my e-mail?  ' }, NOW);
  assert.deepEqual([r.topic, r.body, r.status, r.created_at, r.answered_at, r.replies], ['account', 'How do I change my e-mail?', 'open', NOW.toISOString(), null, []]);
  await assert.rejects(createSupportRequest(IDS.learner, { topic: 'refund', body: 'x' }, NOW), (e) => e.code === 'invalid_topic');
  await assert.rejects(createSupportRequest(IDS.learner, { topic: 'other', body: '   ' }, NOW), (e) => e.code === 'invalid_body');
  await assert.rejects(createSupportRequest(IDS.learner, { topic: 'other', body: 'x'.repeat(2001) }, NOW), (e) => e.code === 'invalid_body');
  env.logs.restore();
  const [event] = env.logs.events('support_request_created');
  assert.deepEqual([event['entity.type'], event['entity.id'], event.actor_type], ['support_request', r.id, 'system']);
  assert.ok(!env.logs.lines.join('').includes('change my'), 'the question text is never logged');
});

test('listUserSupportRequests newest first; staff lists open oldest first and answered by answer time', async () => {
  assert.deepEqual((await listUserSupportRequests(IDS.learner)).map((r) => r.id), [IDS.supportOpen, IDS.supportAnswered]);
  assert.deepEqual(await listUserSupportRequests(IDS.learnerNoSub), []);
  assert.deepEqual((await listSupportRequestsByStatus('open')).map((r) => r.id), [IDS.supportOpen]);
  assert.deepEqual((await listSupportRequestsByStatus('answered')).map((r) => r.id), [IDS.supportAnswered]);
  await assert.rejects(listSupportRequestsByStatus('closed'), (e) => e.code === 'invalid_status');
});

test('replyToSupportRequest: first reply answers it, every reply notifies the learner', async () => {
  const NOW = new Date('2026-10-31T09:30:00Z');
  const r = await replyToSupportRequest(IDS.staff, IDS.supportOpen, { body: 'Certificates arrive next month.' }, NOW);
  assert.deepEqual([r.status, r.answered_at, r.replies.length], ['answered', NOW.toISOString(), 1]);
  const again = await replyToSupportRequest(IDS.staff, IDS.supportOpen, { body: 'They are live now.' }, new Date('2026-11-02T09:00:00Z'));
  assert.deepEqual([again.answered_at, again.replies.length], [NOW.toISOString(), 2]);
  await assert.rejects(replyToSupportRequest(IDS.staff, 'sup_ffffffffffff', { body: 'x' }), (e) => e.status === 404);
  await assert.rejects(replyToSupportRequest(IDS.staff, IDS.supportOpen, { body: '' }), (e) => e.code === 'invalid_body');
  env.logs.restore();
  const inbox = (await listNotifications(IDS.learner)).filter((n) => n.type === 'support_reply');
  assert.equal(inbox.length, 2);
  assert.equal(inbox[0].link, '/help');
  assert.deepEqual(env.logs.events().map((e) => [e.event, e['entity.type'], e.actor_type]), [
    ['notification_created', 'notification', 'system'], ['support_reply_sent', 'support_request', 'staff'],
    ['notification_created', 'notification', 'system'], ['support_reply_sent', 'support_request', 'staff'],
  ]);
  const view = toPublicSupportRequest(again, await staffNames());
  assert.deepEqual(view.replies.map((x) => x.staffName), ['Sam', 'Sam']);
  assert.equal(view.replyDueAt, '2026-11-02T16:00:00.000Z'); // asked on a Friday afternoon
});

test('HTTP: a learner asks and lists their questions', async () => {
  const cookie = await testSessionCookie({ userId: IDS.learnerNoSub });
  const created = await handler(apiEvent('POST /api/me/support-requests', { cookie, body: { topic: 'billing', body: 'Do you offer invoices?' } }));
  const invalid = await handler(apiEvent('POST /api/me/support-requests', { cookie, body: { topic: 'nope', body: 'x' } }));
  const list = JSON.parse((await handler(apiEvent('GET /api/me/support-requests', { cookie }))).body);
  const anon = await handler(apiEvent('GET /api/me/support-requests'));
  env.logs.restore();
  assert.equal(created.statusCode, 200);
  assert.equal(invalid.statusCode, 400);
  assert.equal(anon.statusCode, 401);
  assert.deepEqual(list.supportRequests.map((r) => [r.topic, r.status]), [['billing', 'open']]);
  const lines = env.logs.records.filter((r) => r.kind !== 'log').map((r) => r.kind === 'event' ? r.event : r['http.route']);
  assert.deepEqual(lines, ['support_request_created', '/api/me/support-requests', '/api/me/support-requests', '/api/me/support-requests', '/api/me/support-requests']);
  assert.equal(env.logs.events('support_request_created')[0].actor_type, 'learner');
});

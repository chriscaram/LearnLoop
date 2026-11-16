import { notFound, ok } from '@learnloop/shared/http';
import { listNotifications, markRead, toPublicNotification, unreadCount } from './services/inbox.js';
import { createSupportRequest, listUserSupportRequests, staffNames, toPublicSupportRequest } from './services/support.js';

async function list({ user, query }) {
  const limit = Math.min(Math.max(Number.parseInt(query.limit ?? '50', 10) || 50, 1), 100);
  const items = await listNotifications(user.userId, { limit });
  return ok({ notifications: items.map(toPublicNotification), unread: await unreadCount(user.userId) });
}

async function read({ user, params, now }) {
  const notification = await markRead(user.userId, params.notificationId, now);
  if (!notification) throw notFound('notification_not_found');
  return ok({ notification: toPublicNotification(notification) });
}

async function count({ user }) {
  return ok({ unread: await unreadCount(user.userId) });
}

async function mySupportRequests({ user }) {
  const [requests, names] = await Promise.all([listUserSupportRequests(user.userId), staffNames()]);
  return ok({ supportRequests: requests.map((r) => toPublicSupportRequest(r, names)) });
}

async function askSupport({ user, body, now }) {
  return ok({ supportRequest: toPublicSupportRequest(await createSupportRequest(user.userId, body, now)) });
}

export const routes = [
  { method: 'GET', path: '/api/me/notifications', auth: 'user', handler: list },
  { method: 'POST', path: '/api/me/notifications/{notificationId}/read', auth: 'user', handler: read },
  { method: 'GET', path: '/api/me/notifications/unread-count', auth: 'user', handler: count },
  { method: 'GET', path: '/api/me/support-requests', auth: 'user', handler: mySupportRequests },
  { method: 'POST', path: '/api/me/support-requests', auth: 'user', handler: askSupport },
];

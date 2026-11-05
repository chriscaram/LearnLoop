import { notFound, ok } from '@learnloop/shared/http';
import { listNotifications, markRead, toPublicNotification, unreadCount } from './services/inbox.js';

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

export const routes = [
  { method: 'GET', path: '/api/me/notifications', auth: 'user', handler: list },
  { method: 'POST', path: '/api/me/notifications/{notificationId}/read', auth: 'user', handler: read },
  { method: 'GET', path: '/api/me/notifications/unread-count', auth: 'user', handler: count },
];

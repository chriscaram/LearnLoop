import { randomBytes } from 'node:crypto';
import { logEvent } from '@learnloop/shared/logger';
import { listNotificationsForUser, insertNotification, setNotificationRead } from '../repositories/notifications.js';

/** Transactional notification types. */
export const NOTIFICATION_TYPES = Object.freeze(['welcome', 'payment_receipt', 'new_course_published', 'staff_message']);

export const newNotificationId = () => `ntf_${randomBytes(6).toString('hex')}`;

export async function createNotification(userId, { type, title, body, link = null }, now = new Date()) {
  if (!NOTIFICATION_TYPES.includes(type)) throw new TypeError(`unknown notification type: ${type}`);
  const notification = await insertNotification({
    id: newNotificationId(),
    user_id: userId,
    type,
    title: String(title).slice(0, 200),
    body: String(body ?? '').slice(0, 4000),
    link,
    created_at: now.toISOString(),
    read_at: null,
  });
  logEvent({ event: 'notification_created', entityType: 'notification', entityId: notification.id, actorType: 'system' });
  return notification;
}

/** Newest first. */
export async function listNotifications(userId, { limit } = {}) {
  const items = (await listNotificationsForUser(userId))
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
  return limit ? items.slice(0, limit) : items;
}

export async function unreadCount(userId) {
  return (await listNotificationsForUser(userId)).filter((n) => !n.read_at).length;
}

export async function markRead(userId, notificationId, now = new Date()) {
  const result = await setNotificationRead(userId, notificationId, now.toISOString());
  if (!result) return null;
  if (result.wasUnread) logEvent({ event: 'notification_opened', entityType: 'notification', entityId: notificationId });
  return result.notification;
}

export function toPublicNotification(n) {
  return { id: n.id, type: n.type, title: n.title, body: n.body, link: n.link, createdAt: n.created_at, read: Boolean(n.read_at) };
}

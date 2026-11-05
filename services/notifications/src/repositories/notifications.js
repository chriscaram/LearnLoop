import { getStore } from '@learnloop/shared/store';

export async function listNotificationsForUser(userId) {
  const all = await getStore().read('notifications');
  return all.filter((n) => n.user_id === userId);
}

export async function insertNotification(notification) {
  await getStore().update('notifications', (all) => {
    all.push(notification);
  });
  return notification;
}

/** Sets read_at if unset. Returns the notification, or null when it is not the user's. */
export async function setNotificationRead(userId, notificationId, readAt) {
  return getStore().update('notifications', (all) => {
    const found = all.find((n) => n.id === notificationId && n.user_id === userId);
    if (!found) return null;
    const wasUnread = !found.read_at;
    if (wasUnread) found.read_at = readAt;
    return { notification: { ...found }, wasUnread };
  });
}

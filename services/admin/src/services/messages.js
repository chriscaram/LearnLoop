import { badRequest, notFound } from '@learnloop/shared/http';
import { logEvent } from '@learnloop/shared/logger';
import { createNotification } from '@learnloop/notifications/services/inbox';
import { sendEmail } from '@learnloop/notifications/services/email';
import { findUserById } from '../repositories/learners.js';

export function validateMessage({ title, body } = {}) {
  const cleanTitle = String(title ?? '').trim();
  const cleanBody = String(body ?? '').trim();
  if (!cleanTitle || cleanTitle.length > 120) throw badRequest('invalid_title');
  if (!cleanBody || cleanBody.length > 2000) throw badRequest('invalid_body');
  return { title: cleanTitle, body: cleanBody };
}

/** A staff member writes to one learner: inbox notification plus email. */
export async function sendStaffMessage(staffUserId, learnerId, message, now = new Date()) {
  const { title, body } = validateMessage(message);
  const [learner, staff] = await Promise.all([findUserById(learnerId), findUserById(staffUserId)]);
  if (!learner || learner.role !== 'learner') throw notFound('learner_not_found');
  const notification = await createNotification(learner.id, { type: 'staff_message', title, body, link: '/notifications' }, now);
  logEvent({ event: 'staff_message_sent', entityType: 'notification', entityId: notification.id, actorType: 'staff' });
  const email = await sendEmail({
    to: learner.email,
    template: 'staff_message',
    data: { name: learner.name, title, body, staffName: staff?.name ?? 'LearnLoop staff' },
  });
  return { notificationId: notification.id, email: email.ok ? 'sent' : 'failed' };
}

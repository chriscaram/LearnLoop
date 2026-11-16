import {
  listSupportRequestsByStatus, replyDueAt, replyToSupportRequest, staffNames, toPublicSupportRequest,
} from '@learnloop/notifications/services/support';
import { findUserById, listUsersByRole } from '../repositories/learners.js';

/** Support requests for the Admin page, with the learner who asked. */
export async function listSupportQueue(status = 'open', now = new Date()) {
  const [requests, learners, names] = await Promise.all([listSupportRequestsByStatus(status), listUsersByRole('learner'), staffNames()]);
  const byId = new Map(learners.map((u) => [u.id, u]));
  return requests.map((r) => {
    const learner = byId.get(r.user_id);
    return {
      ...toPublicSupportRequest(r, names),
      learner: learner ? { userId: learner.id, name: learner.name, email: learner.email } : null,
      overdue: r.status === 'open' && replyDueAt(r.created_at) <= now,
    };
  });
}

export async function replyToLearner(staffUserId, requestId, body, now = new Date()) {
  const updated = await replyToSupportRequest(staffUserId, requestId, body, now);
  const staff = await findUserById(staffUserId);
  return { supportRequest: toPublicSupportRequest(updated, new Map(staff ? [[staff.id, staff.name.split(' ')[0]]] : [])) };
}

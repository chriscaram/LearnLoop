import { logWarn } from '@learnloop/shared/logger';
import {
  listSupportRequestsByStatus, overdueRequests, replyDueAt, replyToSupportRequest, staffNames, toPublicSupportRequest,
} from '@learnloop/notifications/services/support';
import { listSupportRequests } from '@learnloop/notifications/repositories/supportRequests';
import { findUserById, listUsersByRole } from '../repositories/learners.js';

export const SUPPORT_BACKLOG_JOB = 'check_support_backlog';

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

/**
 * Daily check (EventBridge, 07:00 UTC): one warning per open question that has waited
 * longer than one business day, so the backlog shows up next to the service's other
 * operational warnings. Returns how many were overdue.
 */
export async function checkSupportBacklog(now = new Date()) {
  const overdue = overdueRequests(await listSupportRequests(), now);
  for (let i = 0; i < overdue.length; i += 1) {
    logWarn('support request waiting for a reply', { errorType: 'SupportReplyTimeout' });
  }
  return overdue.length;
}

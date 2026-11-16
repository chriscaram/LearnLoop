import { ok } from '@learnloop/shared/http';
import { getFlags, updateFlag } from './services/flags.js';
import { listLearners, listOrganizationNames } from './services/learners.js';
import { sendStaffMessage } from './services/messages.js';
import { listSupportQueue, replyToLearner } from './services/support.js';
import { getLearnerTraining } from './services/training.js';

async function learners({ query, now }) {
  const [rows, organizations] = await Promise.all([listLearners(now, { organizationId: query.organization }), listOrganizationNames()]);
  return ok({ learners: rows, organizations });
}

async function training({ params, now }) {
  return ok(await getLearnerTraining(params.userId, now));
}

async function message({ user, params, body, now }) {
  return ok(await sendStaffMessage(user.userId, params.userId, body, now));
}

async function flags() {
  return ok({ flags: await getFlags() });
}

async function putFlag({ params, body }) {
  return ok({ flag: await updateFlag(params.flagKey, body.enabled) });
}

async function supportRequests({ query, now }) {
  return ok({ supportRequests: await listSupportQueue(query.status ?? 'open', now) });
}

async function replySupport({ user, params, body, now }) {
  return ok(await replyToLearner(user.userId, params.requestId, body, now));
}

export const routes = [
  { method: 'GET', path: '/api/admin/learners', auth: 'staff', handler: learners },
  { method: 'GET', path: '/api/admin/learners/{userId}/training', auth: 'staff', handler: training },
  { method: 'POST', path: '/api/admin/learners/{userId}/message', auth: 'staff', handler: message },
  { method: 'GET', path: '/api/admin/flags', auth: 'staff', handler: flags },
  { method: 'PUT', path: '/api/admin/flags/{flagKey}', auth: 'staff', handler: putFlag },
  { method: 'GET', path: '/api/admin/support-requests', auth: 'staff', handler: supportRequests },
  { method: 'POST', path: '/api/admin/support-requests/{requestId}/reply', auth: 'staff', handler: replySupport },
];

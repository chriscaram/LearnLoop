import { ok } from '@learnloop/shared/http';
import { getFlags, updateFlag } from './services/flags.js';
import { listLearners } from './services/learners.js';
import { sendStaffMessage } from './services/messages.js';

async function learners({ now }) {
  return ok({ learners: await listLearners(now) });
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

export const routes = [
  { method: 'GET', path: '/api/admin/learners', auth: 'staff', handler: learners },
  { method: 'POST', path: '/api/admin/learners/{userId}/message', auth: 'staff', handler: message },
  { method: 'GET', path: '/api/admin/flags', auth: 'staff', handler: flags },
  { method: 'PUT', path: '/api/admin/flags/{flagKey}', auth: 'staff', handler: putFlag },
];

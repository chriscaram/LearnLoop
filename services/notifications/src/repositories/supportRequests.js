import { getStore } from '@learnloop/shared/store';

export async function listSupportRequests() {
  return getStore().read('support_requests');
}

export async function listSupportRequestsForUser(userId) {
  return (await listSupportRequests()).filter((r) => r.user_id === userId);
}

export async function insertSupportRequest(request) {
  await getStore().update('support_requests', (all) => {
    all.push(request);
  });
  return request;
}

/** Applies `change(request)` to one request; returns the updated copy, or null when it does not exist. */
export async function updateSupportRequest(requestId, change) {
  return getStore().update('support_requests', (all) => {
    const found = all.find((r) => r.id === requestId);
    if (!found) return null;
    change(found);
    return structuredClone(found);
  });
}

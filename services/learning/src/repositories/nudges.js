import { getStore } from '@learnloop/shared/store';

export async function listLearnerUsers() {
  return (await getStore().read('users')).filter((u) => u.role === 'learner');
}

/** Marks a notification the nudge agent created, so staff and the UI can tell. */
export async function markNotificationAppliedByAgent(notificationId) {
  return getStore().update('notifications', (all) => {
    const found = all.find((n) => n.id === notificationId);
    if (!found) return null;
    found.applied_by_agent = true;
    return { ...found };
  });
}
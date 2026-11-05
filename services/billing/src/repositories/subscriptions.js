import { getStore } from '@learnloop/shared/store';

export async function listSubscriptionsForUser(userId) {
  return (await getStore().read('subscriptions')).filter((s) => s.user_id === userId);
}

export async function listAllSubscriptions() {
  return getStore().read('subscriptions');
}

export async function insertSubscription(subscription) {
  await getStore().update('subscriptions', (all) => {
    all.push(subscription);
  });
  return subscription;
}

/** Applies `change(subscription)` to one record; returns the updated copy or null. */
export async function updateSubscription(subscriptionId, change) {
  return getStore().update('subscriptions', (all) => {
    const found = all.find((s) => s.id === subscriptionId);
    if (!found) return null;
    const keep = change(found);
    return keep === false ? null : { ...found };
  });
}

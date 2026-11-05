// Daily renewal job. EventBridge invokes the billing function at 00:10 UTC with
// { "job": "renew_subscriptions" }; handler.js routes that here. Payments are
// mocked and always succeed. Logs go through the shared logger like any request,
// with actor_type "system" and the subscriber as user.id (no session.id).
import { getLogContext, logEvent, runWithLogContext } from '@learnloop/shared/logger';
import { listAllSubscriptions, updateSubscription } from '../repositories/subscriptions.js';
import { findUserById } from '../repositories/users.js';
import { addMonths, sendReceipt } from '../services/subscription.js';

export const RENEWAL_JOB = 'renew_subscriptions';

/** Active subscriptions whose paid period has ended at `now`. */
export function dueForRenewal(subscriptions, now = new Date()) {
  return subscriptions.filter((s) => s.status === 'active' && new Date(s.current_period_end) <= now);
}

/** Moves the paid period forward until it covers `now`. Mutates and returns the subscription. */
export function advancePeriod(subscription, now = new Date()) {
  while (new Date(subscription.current_period_end) <= now) {
    subscription.current_period_start = subscription.current_period_end;
    subscription.current_period_end = addMonths(new Date(subscription.current_period_end), 1).toISOString();
  }
  return subscription;
}

/** Renews one subscription if it is still due; returns the updated copy or null. */
export async function renewSubscription(subscriptionId, now = new Date()) {
  const updated = await updateSubscription(subscriptionId, (s) => {
    if (s.status !== 'active' || new Date(s.current_period_end) > now) return false;
    advancePeriod(s, now);
    return true;
  });
  if (!updated) return null;
  logEvent({ event: 'subscription_renewed', entityType: 'subscription', entityId: updated.id, actorType: 'system' });
  const user = await findUserById(updated.user_id);
  if (user) await sendReceipt(user, updated);
  return updated;
}

/** Renews every due subscription; returns how many were renewed. */
export async function renewDueSubscriptions(now = new Date()) {
  const due = dueForRenewal(await listAllSubscriptions(), now);
  const parent = getLogContext() ?? {};
  let renewed = 0;
  for (const subscription of due) {
    const ctx = { ...parent, userId: subscription.user_id, sessionId: undefined, role: 'system' };
    if (await runWithLogContext(ctx, () => renewSubscription(subscription.id, now))) renewed += 1;
  }
  return renewed;
}

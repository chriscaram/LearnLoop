import { randomBytes } from 'node:crypto';
import { conflict } from '@learnloop/shared/http';
import { logEvent } from '@learnloop/shared/logger';
import { createNotification } from '@learnloop/notifications/services/inbox';
import { sendEmail } from '@learnloop/notifications/services/email';
import { insertSubscription, listSubscriptionsForUser, updateSubscription } from '../repositories/subscriptions.js';
import { findUserById } from '../repositories/users.js';

/** The only plan. */
export const MONTHLY_PLAN = Object.freeze({ id: 'monthly', name: 'Monthly', priceUsd: 19, interval: 'month' });

const DAY_MS = 86_400_000;

/** Same day-of-month n months later (clamped to the month's last day), same time. */
export function addMonths(date, months) {
  const d = new Date(date);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1,
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
}

/** The user's most recent subscription, or null. */
export async function getSubscription(userId) {
  const all = await listSubscriptionsForUser(userId);
  return all.sort((a, b) => b.started_at.localeCompare(a.started_at))[0] ?? null;
}

/** Active, or cancelled but still inside the paid period. */
export function isActive(subscription, now = new Date()) {
  if (!subscription) return false;
  if (subscription.status === 'active') return true;
  return subscription.status === 'cancelled' && new Date(subscription.current_period_end) > now;
}

/** Whole days until the next renewal; null when it will not renew. */
export function daysUntilRenewal(subscription, now = new Date()) {
  if (!subscription || subscription.status !== 'active') return null;
  return Math.max(0, Math.ceil((new Date(subscription.current_period_end) - now) / DAY_MS));
}

export function toPublicSubscription(subscription, now = new Date()) {
  if (!subscription) return { status: 'none', active: false, plan: MONTHLY_PLAN };
  return {
    id: subscription.id,
    status: subscription.status,
    active: isActive(subscription, now),
    plan: MONTHLY_PLAN,
    startedAt: subscription.started_at,
    currentPeriodEnd: subscription.current_period_end,
    cancelledAt: subscription.cancelled_at,
    daysUntilRenewal: daysUntilRenewal(subscription, now),
  };
}

/** Inbox notification and email for a paid period. */
export async function sendReceipt(user, subscription) {
  const periodEnd = subscription.current_period_end.slice(0, 10);
  await createNotification(user.id, {
    type: 'payment_receipt',
    title: 'Payment received',
    body: `Your monthly plan is paid until ${periodEnd}.`,
    link: '/subscription',
  });
  await sendEmail({ to: user.email, template: 'payment_receipt', data: { name: user.name, amount: MONTHLY_PLAN.priceUsd, periodEnd } });
}

/** Mock checkout: always succeeds and starts a monthly subscription. */
export async function startSubscription(userId, now = new Date()) {
  logEvent({ event: 'checkout_started', entityType: 'plan', entityId: MONTHLY_PLAN.id });
  const previous = await listSubscriptionsForUser(userId);
  const current = await getSubscription(userId);
  if (current?.status === 'active') throw conflict('already_subscribed');
  const subscription = await insertSubscription({
    id: `sub_${randomBytes(6).toString('hex')}`,
    user_id: userId,
    plan: MONTHLY_PLAN.id,
    price_usd: MONTHLY_PLAN.priceUsd,
    status: 'active',
    started_at: now.toISOString(),
    current_period_start: now.toISOString(),
    current_period_end: addMonths(now, 1).toISOString(),
    cancelled_at: null,
  });
  logEvent({ event: 'subscription_started', entityType: 'subscription', entityId: subscription.id });
  const user = await findUserById(userId);
  if (user) {
    if (previous.length === 0) {
      await createNotification(userId, { type: 'welcome', title: 'Welcome to LearnLoop', body: 'Your subscription is active. Pick a course from the catalog to get started.', link: '/courses' });
      await sendEmail({ to: user.email, template: 'welcome', data: { name: user.name } });
    }
    await sendReceipt(user, subscription);
  }
  return subscription;
}

/** Stops renewal; access continues until the end of the paid period. */
export async function cancelSubscription(userId, now = new Date()) {
  const current = await getSubscription(userId);
  if (!current || current.status !== 'active') throw conflict('no_active_subscription');
  const updated = await updateSubscription(current.id, (s) => {
    if (s.status !== 'active') return false;
    s.status = 'cancelled';
    s.cancelled_at = now.toISOString();
    return true;
  });
  if (!updated) throw conflict('no_active_subscription');
  logEvent({ event: 'subscription_cancelled', entityType: 'subscription', entityId: updated.id });
  return updated;
}

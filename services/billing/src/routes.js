import { ok } from '@learnloop/shared/http';
import { cancelSubscription, getSubscription, startSubscription, toPublicSubscription } from './services/subscription.js';

async function mySubscription({ user, now }) {
  return ok({ subscription: toPublicSubscription(await getSubscription(user.userId), now) });
}

async function checkout({ user, now }) {
  return ok({ subscription: toPublicSubscription(await startSubscription(user.userId, now), now) });
}

async function cancel({ user, now }) {
  return ok({ subscription: toPublicSubscription(await cancelSubscription(user.userId, now), now) });
}

export const routes = [
  { method: 'GET', path: '/api/me/subscription', auth: 'user', handler: mySubscription },
  { method: 'POST', path: '/api/checkout', auth: 'user', handler: checkout },
  { method: 'POST', path: '/api/me/subscription/cancel', auth: 'user', handler: cancel },
];

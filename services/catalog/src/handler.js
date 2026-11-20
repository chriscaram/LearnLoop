import { createHandler } from '@learnloop/shared/http';
import { CART_REMINDER_JOB, nudgeStalledCarts } from './agents/cartReminder.js';
import { routes } from './routes.js';

export const handler = createHandler({
  service: 'catalog',
  routes,
  jobs: { [CART_REMINDER_JOB]: (now) => nudgeStalledCarts(now) },
});
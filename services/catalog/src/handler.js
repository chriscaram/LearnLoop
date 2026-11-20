import { createHandler } from '@learnloop/shared/http';
import { CART_FOLLOW_UP_JOB, cartFollowUpJob } from './agents/cartFollowUp.js';
import { routes } from './routes.js';

export const handler = createHandler({ service: 'catalog', routes, jobs: { [CART_FOLLOW_UP_JOB]: cartFollowUpJob } });
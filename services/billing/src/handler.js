import { createHandler } from '@learnloop/shared/http';
import { RENEWAL_JOB, renewDueSubscriptions } from './jobs/renewals.js';
import { routes } from './routes.js';

export const handler = createHandler({
  service: 'billing',
  routes,
  jobs: { [RENEWAL_JOB]: renewDueSubscriptions },
});

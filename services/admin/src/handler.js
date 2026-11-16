import { createHandler } from '@learnloop/shared/http';
import { SUPPORT_BACKLOG_JOB, checkSupportBacklog } from './services/support.js';
import { routes } from './routes.js';

export const handler = createHandler({
  service: 'admin',
  routes,
  jobs: { [SUPPORT_BACKLOG_JOB]: checkSupportBacklog },
});

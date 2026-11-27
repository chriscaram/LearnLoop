import { createHandler } from '@learnloop/shared/http';
import { REENGAGEMENT_JOB, runReengagementJob } from './agents/reengagement.js';
import { routes } from './routes.js';

export const handler = createHandler({
  service: 'learning',
  routes,
  jobs: { [REENGAGEMENT_JOB]: runReengagementJob },
});
import { createHandler } from '@learnloop/shared/http';
import { NUDGE_JOB, nudgeLapsedLearners } from './agents/nudgeLapsedLearners.js';
import { routes } from './routes.js';

export const handler = createHandler({
  service: 'learning',
  routes,
  jobs: { [NUDGE_JOB]: nudgeLapsedLearners },
});
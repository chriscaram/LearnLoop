import { createHandler } from '@learnloop/shared/http';
import { REENGAGEMENT_JOB, reengageInactiveLearners } from './jobs/reengagement.js';
import { routes } from './routes.js';

export const handler = createHandler({
  service: 'learning',
  routes,
  jobs: { [REENGAGEMENT_JOB]: reengageInactiveLearners },
});
import { createHandler } from '@learnloop/shared/http';
import { oversightRoutes } from './agents/followUpOversight.js';
import { FOLLOW_UP_JOB, runTrainingFollowUp } from './agents/trainingFollowUp.js';
import { routes } from './routes.js';

export const handler = createHandler({
  service: 'admin',
  routes: [...routes, ...oversightRoutes],
  jobs: { [FOLLOW_UP_JOB]: (now) => runTrainingFollowUp(now) },
});
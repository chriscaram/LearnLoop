import { createHandler } from '@learnloop/shared/http';
import { oversightRoutes } from './agents/oversight.js';
import { TRAINING_FOLLOW_UP_JOB, agentRoutes, runTrainingFollowUp } from './agents/trainingFollowUp.js';
import { routes } from './routes.js';

export const handler = createHandler({
  service: 'admin',
  routes: [...routes, ...agentRoutes, ...oversightRoutes],
  jobs: { [TRAINING_FOLLOW_UP_JOB]: (now) => runTrainingFollowUp(now) },
});
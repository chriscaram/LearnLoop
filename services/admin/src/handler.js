import { createHandler } from '@learnloop/shared/http';
import { FOLLOW_UP_JOB, runTrainingFollowUp } from './agents/trainingFollowUp.js';
import { routes } from './routes.js';

export const handler = createHandler({
  service: 'admin',
  routes,
  jobs: { [FOLLOW_UP_JOB]: (now) => runTrainingFollowUp(now) },
});
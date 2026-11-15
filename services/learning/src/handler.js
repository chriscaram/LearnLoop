import { createHandler } from '@learnloop/shared/http';
import { LAPSED_NUDGE_JOB, runLapsedLearnerNudges } from './jobs/lapsedNudges.js';
import { routes } from './routes.js';

export const handler = createHandler({
  service: 'learning',
  routes,
  jobs: { [LAPSED_NUDGE_JOB]: runLapsedLearnerNudges },
});
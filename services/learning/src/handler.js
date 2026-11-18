import { createHandler } from '@learnloop/shared/http';
import { NUDGE_JOB, runInactivityNudges } from './agents/inactivityNudges.js';
import { routes } from './routes.js';

export const handler = createHandler({
  service: 'learning',
  routes,
  jobs: { [NUDGE_JOB]: (now) => runInactivityNudges(now) },
});
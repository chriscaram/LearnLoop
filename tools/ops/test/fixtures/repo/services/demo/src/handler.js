import { createHandler } from '@learnloop/shared/http';

export const handler = createHandler({ service: 'demo', routes: [], jobs: { first_job: async () => {}, second_job: async () => {} } });

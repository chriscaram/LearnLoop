import { createHandler } from '@learnloop/shared/http';
import { routes } from './routes.js';

export const handler = createHandler({ service: 'learning', routes });

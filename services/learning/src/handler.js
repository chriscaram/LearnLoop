import { createHandler } from '@learnloop/shared/http';
import { LESSON_REMINDER_JOB, runLessonReminders } from './jobs/lessonReminders.js';
import { routes } from './routes.js';

export const handler = createHandler({
  service: 'learning',
  routes,
  jobs: { [LESSON_REMINDER_JOB]: runLessonReminders },
});
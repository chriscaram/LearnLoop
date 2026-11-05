import { ok } from '@learnloop/shared/http';
import { logEvent } from '@learnloop/shared/logger';
import { getLessonForLearner, listCourseLessons } from './services/lessons.js';
import { listProgressOverview, recordLessonProgress } from './services/progress.js';
import { submitQuiz } from './services/quiz.js';

async function courseLessons({ user, params }) {
  return ok({ lessons: await listCourseLessons(user.userId, params.courseId) });
}

async function lesson({ user, params }) {
  return ok({ lesson: await getLessonForLearner(user.userId, params.lessonId) });
}

async function progress({ user, params, body, now }) {
  const record = await recordLessonProgress(user.userId, params.lessonId, body.status, now);
  return ok({ progress: { lessonId: record.lesson_id, status: record.status, startedAt: record.started_at, completedAt: record.completed_at } });
}

async function quiz({ user, params, body, now }) {
  return ok({ result: await submitQuiz(user.userId, params.lessonId, body.answers, now) });
}

async function myProgress({ user }) {
  const courses = await listProgressOverview(user.userId);
  logEvent({ event: 'progress_viewed' });
  return ok({ courses });
}

export const routes = [
  { method: 'GET', path: '/api/courses/{courseId}/lessons', auth: 'user', handler: courseLessons },
  { method: 'GET', path: '/api/lessons/{lessonId}', auth: 'user', handler: lesson },
  { method: 'POST', path: '/api/lessons/{lessonId}/progress', auth: 'user', handler: progress },
  { method: 'POST', path: '/api/lessons/{lessonId}/quiz', auth: 'user', handler: quiz },
  { method: 'GET', path: '/api/me/progress', auth: 'user', handler: myProgress },
];

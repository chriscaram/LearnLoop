import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IDS, apiEvent, checkRoutesTable, fixtureData, setupTestEnvironment, testSessionCookie } from '@learnloop/shared/testing';
import {
  assertEnrolled, completionPercent, daysSinceLastActivity, getCourseProgress, getLastActivityAt,
  getLastLessonViewed, listProgressOverview, nextLessonFor, recordLessonProgress,
} from '../src/services/progress.js';
import { getLessonForLearner, listCourseLessons, publicQuiz } from '../src/services/lessons.js';
import { gradeQuiz, submitQuiz } from '../src/services/quiz.js';
import { routes } from '../src/routes.js';
import { handler } from '../src/handler.js';

let env;
beforeEach(() => { env = setupTestEnvironment({ data: fixtureData() }); });
const NOW = new Date('2026-11-03T12:00:00Z');

test('routes table', () => {
  checkRoutesTable(assert, routes, { service: 'learning', expected: [
    'GET /api/courses/{courseId}/lessons', 'GET /api/lessons/{lessonId}', 'POST /api/lessons/{lessonId}/progress',
    'POST /api/lessons/{lessonId}/quiz', 'GET /api/me/progress',
  ] });
});

test('completionPercent weights lessons by duration', () => {
  const course = { lessons: [{ id: 'a', duration_min: 10 }, { id: 'b', duration_min: 30 }] };
  assert.equal(completionPercent([{ lesson_id: 'a', status: 'completed' }], course), 25);
  assert.equal(completionPercent([{ lesson_id: 'b', status: 'started' }], course), 0);
  assert.equal(completionPercent([], { lessons: [] }), 0);
});

test('getCourseProgress summarises one course', async () => {
  const p = await getCourseProgress(IDS.learner, IDS.cloud);
  assert.equal(p.percent, 17);
  assert.equal(p.lastLesson.id, IDS.lesson2);
  assert.equal(p.nextLesson.id, IDS.lesson2);
  assert.equal(p.lastActivityAt, '2026-10-05T10:00:00.000Z');
  assert.equal(await getCourseProgress(IDS.learner, 'crs_ffffffffffff'), null);
});

test('getLastLessonViewed and nextLessonFor', async () => {
  assert.equal((await getLastLessonViewed(IDS.learner, IDS.cloud)).id, IDS.lesson2);
  assert.equal(await getLastLessonViewed(IDS.learner, IDS.data), null);
  assert.equal((await nextLessonFor(IDS.learnerNoSub, IDS.cloud)).id, IDS.lesson1);
});

test('getLastActivityAt and daysSinceLastActivity', async () => {
  assert.equal(await getLastActivityAt(IDS.learner), '2026-10-05T10:00:00.000Z');
  assert.equal(await daysSinceLastActivity(IDS.learner, NOW), 29);
  assert.equal(await daysSinceLastActivity(IDS.learnerNoSub, NOW), null);
});

test('listProgressOverview covers enrolled courses only', async () => {
  const overview = await listProgressOverview(IDS.learner);
  assert.deepEqual(overview.map((c) => c.courseId), [IDS.cloud]);
});

test('assertEnrolled rejects other courses', async () => {
  await assertEnrolled(IDS.learner, IDS.cloud);
  await assert.rejects(assertEnrolled(IDS.learner, IDS.data), (e) => e.status === 403);
});

test('recordLessonProgress: started then completed, updates last activity, logs events with duration', async () => {
  await recordLessonProgress(IDS.learner, IDS.lesson3, 'started', NOW);
  const done = await recordLessonProgress(IDS.learner, IDS.lesson3, 'completed', new Date('2026-11-03T12:20:00Z'));
  assert.equal(done.status, 'completed');
  const again = await recordLessonProgress(IDS.learner, IDS.lesson3, 'started', new Date('2026-11-03T12:30:00Z'));
  assert.equal(again.status, 'completed', 'completed is final');
  assert.equal(await getLastActivityAt(IDS.learner), '2026-11-03T12:30:00.000Z');
  await assert.rejects(recordLessonProgress(IDS.learner, IDS.lesson3, 'paused', NOW), (e) => e.status === 400);
  await assert.rejects(recordLessonProgress(IDS.learner, IDS.dataLesson, 'started', NOW), (e) => e.status === 403);
  env.logs.restore();
  const [completed] = env.logs.events('lesson_completed');
  assert.equal(completed['entity.id'], IDS.lesson3);
  assert.equal(completed.value, 30);
  assert.equal(env.logs.events('lesson_started').length, 2);
});

test('getLessonForLearner hides quiz answers; listCourseLessons has statuses', async () => {
  const lesson = await getLessonForLearner(IDS.learner, IDS.lesson3);
  assert.equal(lesson.status, 'not_started');
  assert.equal(lesson.quiz.questions[0].answer_index, undefined);
  assert.equal(publicQuiz(null), null);
  const list = await listCourseLessons(IDS.learner, IDS.cloud);
  assert.deepEqual(list.map((l) => l.status), ['completed', 'started', 'not_started']);
  await assert.rejects(getLessonForLearner(IDS.learner, 'les_ffffffffffff'), (e) => e.status === 404);
});

test('gradeQuiz scores in percent', () => {
  const quiz = fixtureData().lessons[2].quiz;
  assert.equal(gradeQuiz(quiz, { q1: 0, q2: 1 }).score, 50);
  assert.equal(gradeQuiz(quiz, { q1: '0', q2: 0 }).score, 100);
  assert.equal(gradeQuiz({ questions: [] }, {}).score, 0);
});

test('submitQuiz stores the result and logs quiz_submitted with the score', async () => {
  const result = await submitQuiz(IDS.learner, IDS.lesson3, { q1: 0, q2: 0 }, NOW);
  assert.equal(result.score, 100);
  await assert.rejects(submitQuiz(IDS.learner, IDS.lesson1, {}, NOW), (e) => e.status === 400);
  env.logs.restore();
  assert.equal(env.logs.events('quiz_submitted')[0].value, 100);
});

test('HTTP: lessons, lesson, progress, quiz, my progress', async () => {
  const cookie = await testSessionCookie({ userId: IDS.learner });
  const lessons = await handler(apiEvent('GET /api/courses/{courseId}/lessons', { cookie, pathParameters: { courseId: IDS.cloud } }));
  assert.equal(JSON.parse(lessons.body).lessons.length, 3);
  const lesson = await handler(apiEvent('GET /api/lessons/{lessonId}', { cookie, pathParameters: { lessonId: IDS.lesson2 } }));
  assert.equal(JSON.parse(lesson.body).lesson.video.placeholder, true);
  const progress = await handler(apiEvent('POST /api/lessons/{lessonId}/progress', { cookie, pathParameters: { lessonId: IDS.lesson2 }, body: { status: 'completed' } }));
  assert.equal(JSON.parse(progress.body).progress.status, 'completed');
  const quiz = await handler(apiEvent('POST /api/lessons/{lessonId}/quiz', { cookie, pathParameters: { lessonId: IDS.lesson3 }, body: { answers: { q1: 0 } } }));
  assert.equal(JSON.parse(quiz.body).result.score, 50);
  const mine = JSON.parse((await handler(apiEvent('GET /api/me/progress', { cookie }))).body);
  env.logs.restore();
  assert.equal(mine.courses[0].percent, 50);
  assert.equal(env.logs.events('progress_viewed').length, 1);
  const routesLogged = env.logs.records.filter((r) => r.kind === 'request').map((r) => r['http.route']);
  assert.deepEqual(routesLogged, ['/api/courses/{courseId}/lessons', '/api/lessons/{lessonId}', '/api/lessons/{lessonId}/progress', '/api/lessons/{lessonId}/quiz', '/api/me/progress']);
});

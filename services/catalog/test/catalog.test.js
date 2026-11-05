import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IDS, apiEvent, checkRoutesTable, fixtureData, setupTestEnvironment, testSessionCookie } from '@learnloop/shared/testing';
import { CATEGORIES, getCourseDetail, listCatalog, toCourseSummary } from '../src/services/catalog.js';
import { enrol, isEnrolled, listUserEnrolments } from '../src/services/enrolment.js';
import { routes } from '../src/routes.js';
import { handler } from '../src/handler.js';

let env;
const setup = (flags = {}) => { env = setupTestEnvironment({ data: fixtureData(), flags }); };
beforeEach(() => setup());
const NOW = new Date('2026-11-03T12:00:00Z');

test('routes table', () => {
  checkRoutesTable(assert, routes, { service: 'catalog', expected: [
    'GET /api/courses', 'GET /api/courses/{courseId}', 'POST /api/courses/{courseId}/enrol', 'GET /api/me/enrolments',
  ] });
});

test('listCatalog lists and filters by category', async () => {
  assert.deepEqual(CATEGORIES, ['Data', 'Cloud', 'Leadership', 'Design']);
  assert.deepEqual((await listCatalog()).map((c) => c.category), ['Data', 'Cloud']);
  assert.deepEqual((await listCatalog({ category: 'cloud' })).map((c) => c.id), [IDS.cloud]);
  assert.equal(toCourseSummary(fixtureData().courses[0]).lessonCount, 3);
});

test('getCourseDetail includes the lesson outline', async () => {
  const detail = await getCourseDetail(IDS.cloud);
  assert.deepEqual(detail.lessons.map((l) => l.id), [IDS.lesson1, IDS.lesson2, IDS.lesson3]);
  assert.equal(await getCourseDetail('crs_ffffffffffff'), null);
});

test('enrol requires an active subscription and is idempotent', async () => {
  const e = await enrol(IDS.learner, IDS.data, NOW);
  assert.equal(e.course_id, IDS.data);
  await enrol(IDS.learner, IDS.data, NOW);
  await assert.rejects(enrol(IDS.learnerNoSub, IDS.data, NOW), (err) => err.status === 402);
  await assert.rejects(enrol(IDS.learner, 'crs_ffffffffffff', NOW), (err) => err.status === 404);
  env.logs.restore();
  assert.equal(env.logs.events('course_enrolled').length, 1);
});

test('isEnrolled and listUserEnrolments', async () => {
  assert.equal(await isEnrolled(IDS.learner, IDS.cloud), true);
  assert.equal(await isEnrolled(IDS.learner, IDS.data), false);
  assert.equal((await listUserEnrolments(IDS.learner)).length, 1);
});

test('category filter is gated by the new_catalog_filters flag', async () => {
  const off = JSON.parse((await handler(apiEvent('GET /api/courses', { query: { category: 'Cloud' } }))).body);
  assert.equal(off.categories, null);
  assert.equal(off.courses.length, 2, 'filter ignored while the flag is off');
  setup({ new_catalog_filters: { enabled: true } });
  const on = JSON.parse((await handler(apiEvent('GET /api/courses', { query: { category: 'Cloud' } }))).body);
  env.logs.restore();
  assert.deepEqual(on.categories, CATEGORIES);
  assert.deepEqual(on.courses.map((c) => c.id), [IDS.cloud]);
  assert.equal(env.logs.events('catalog_viewed').length, 1);
});

test('HTTP: course detail (anonymous and enrolled), enrol, my enrolments', async () => {
  const anon = JSON.parse((await handler(apiEvent('GET /api/courses/{courseId}', { pathParameters: { courseId: IDS.cloud } }))).body);
  assert.equal(anon.course.enrolled, false);
  const cookie = await testSessionCookie({ userId: IDS.learner });
  const mine = JSON.parse((await handler(apiEvent('GET /api/courses/{courseId}', { cookie, pathParameters: { courseId: IDS.cloud } }))).body);
  assert.equal(mine.course.enrolled, true);
  const res = await handler(apiEvent('POST /api/courses/{courseId}/enrol', { cookie, pathParameters: { courseId: IDS.data } }));
  assert.equal(res.statusCode, 200);
  const list = JSON.parse((await handler(apiEvent('GET /api/me/enrolments', { cookie }))).body);
  env.logs.restore();
  assert.equal(list.enrolments.length, 2);
  assert.equal(env.logs.events('course_opened').length, 2);
});

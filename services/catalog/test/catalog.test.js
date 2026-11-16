import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IDS, apiEvent, checkRoutesTable, fixtureData, setupTestEnvironment, testSessionCookie } from '@learnloop/shared/testing';
import { CATEGORIES, getCourseDetail, listCatalog, toCourseSummary } from '../src/services/catalog.js';
import { addToCart, clearPurchasedCourse, getCart, removeFromCart, validateCourseId } from '../src/services/cart.js';
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
    'GET /api/me/cart', 'POST /api/me/cart/items', 'DELETE /api/me/cart/items/{courseId}',
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

test('getCart lists the items with their course summary, oldest first', async () => {
  const cart = await getCart(IDS.learner);
  assert.equal(cart.count, 1);
  assert.deepEqual(cart.items.map((i) => [i.courseId, i.addedAt, i.course.title]), [[IDS.data, '2026-10-28T18:00:00.000Z', 'SQL for Analysts']]);
  assert.deepEqual(await getCart(IDS.learnerNoSub), { items: [], count: 0 });
});

test('addToCart: once per course, never an enrolled or unknown course; logs cart_item_added', async () => {
  const first = await addToCart(IDS.learnerNoSub, IDS.data, NOW);
  const again = await addToCart(IDS.learnerNoSub, IDS.data, new Date('2026-11-04T09:00:00Z'));
  assert.deepEqual(again, first, 'adding twice keeps the first added_at');
  assert.equal(first.items[0].addedAt, NOW.toISOString());
  await assert.rejects(addToCart(IDS.learner, IDS.cloud, NOW), (e) => e.status === 409 && e.code === 'already_enrolled');
  await assert.rejects(addToCart(IDS.learner, 'crs_ffffffffffff', NOW), (e) => e.status === 404);
  await assert.rejects(addToCart(IDS.learner, 'not-a-course', NOW), (e) => e.status === 400);
  assert.throws(() => validateCourseId(undefined), (e) => e.code === 'invalid_course_id');
  env.logs.restore();
  const events = env.logs.events('cart_item_added');
  assert.equal(events.length, 1);
  assert.equal(events[0]['entity.type'], 'course');
  assert.equal(events[0]['entity.id'], IDS.data);
});

test('removeFromCart logs cart_item_removed only when something was removed; empty carts leave the document', async () => {
  const after = await removeFromCart(IDS.learner, IDS.data);
  await removeFromCart(IDS.learner, IDS.data);
  env.logs.restore();
  assert.equal(after.count, 0);
  assert.deepEqual(await env.store.read('carts'), []);
  assert.equal(env.logs.events('cart_item_removed').length, 1);
});

test('enrolling takes the course out of the cart without a removal event', async () => {
  await enrol(IDS.learner, IDS.data, NOW);
  env.logs.restore();
  assert.equal((await getCart(IDS.learner)).count, 0);
  assert.equal(env.logs.events('cart_item_removed').length, 0);
  assert.equal(await clearPurchasedCourse(IDS.learner, IDS.data), false);
});

test('HTTP: cart read, add and remove for the signed-in user; anonymous is refused', async () => {
  const anon = await handler(apiEvent('GET /api/me/cart'));
  assert.equal(anon.statusCode, 401);
  const cookie = await testSessionCookie({ userId: IDS.learnerNoSub });
  const added = await handler(apiEvent('POST /api/me/cart/items', { cookie, body: { courseId: IDS.cloud } }));
  assert.equal(added.statusCode, 200);
  assert.deepEqual(JSON.parse(added.body).cart.items.map((i) => i.courseId), [IDS.cloud]);
  const bad = await handler(apiEvent('POST /api/me/cart/items', { cookie, body: {} }));
  assert.equal(bad.statusCode, 400);
  const read = JSON.parse((await handler(apiEvent('GET /api/me/cart', { cookie }))).body);
  assert.equal(read.cart.count, 1);
  const removed = await handler(apiEvent('DELETE /api/me/cart/items/{courseId}', { cookie, pathParameters: { courseId: IDS.cloud } }));
  env.logs.restore();
  assert.equal(JSON.parse(removed.body).cart.count, 0);
  const requests = env.logs.records.filter((r) => r.kind === 'request').map((r) => `${r['http.method']} ${r['http.route']} ${r['http.status_code']}`);
  assert.deepEqual(requests, [
    'GET /api/me/cart 401', 'POST /api/me/cart/items 200', 'POST /api/me/cart/items 400', 'GET /api/me/cart 200', 'DELETE /api/me/cart/items/{courseId} 200',
  ]);
  const lines = env.logs.records.filter((r) => r.kind === 'event').map((r) => r.event);
  assert.deepEqual(lines, ['cart_item_added', 'cart_item_removed']);
});

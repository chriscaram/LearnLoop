import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addOnServer, coursesToMerge, fromServerCart, mergeIntoServer, removeOnServer, snapshot } from '../src/lib/cart-sync.js';

const course = (id, title = id) => ({ id, title, category: 'Data', level: 'Beginner', summary: 's', lessonCount: 6, durationMin: 90, extra: 'dropped' });
const serverItem = (id, addedAt = '2026-11-01T10:00:00.000Z') => ({ courseId: id, addedAt, course: snapshot(course(id)) });

/** A fake API client holding one server cart; records every call. */
function fakeServer(initial = [], { reject = {} } = {}) {
  const items = [...initial];
  const calls = [];
  const cart = () => ({ items: [...items], count: items.length });
  const call = async (path, { method = 'GET', body } = {}) => {
    calls.push(`${method} ${path}${body ? ` ${body.courseId}` : ''}`);
    if (method === 'GET' && path === '/api/me/cart') return { cart: cart() };
    if (method === 'POST' && path === '/api/me/cart/items') {
      if (reject[body.courseId]) throw Object.assign(new Error('x'), { status: reject[body.courseId] });
      if (!items.some((i) => i.courseId === body.courseId)) items.push(serverItem(body.courseId, '2026-11-03T12:00:00.000Z'));
      return { cart: cart() };
    }
    const m = /^\/api\/me\/cart\/items\/(.+)$/.exec(path);
    if (method === 'DELETE' && m) {
      const index = items.findIndex((i) => i.courseId === m[1]);
      if (index >= 0) items.splice(index, 1);
      return { cart: cart() };
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { call, calls };
}

test('snapshot keeps only the fields the cart renders', () => {
  assert.deepEqual(Object.keys(snapshot(course('crs_000000000001'))), ['id', 'title', 'category', 'level', 'summary', 'lessonCount', 'durationMin']);
});

test('fromServerCart turns server items into cart items with their added date', () => {
  const items = fromServerCart({ items: [serverItem('crs_000000000001')] });
  assert.deepEqual(items, [{ ...snapshot(course('crs_000000000001')), addedAt: '2026-11-01T10:00:00.000Z' }]);
  assert.deepEqual(fromServerCart(undefined), []);
});

test('coursesToMerge: local courses missing on the server, once each, in local order', () => {
  const local = [course('crs_b'), course('crs_a'), course('crs_b'), { title: 'no id' }];
  assert.deepEqual(coursesToMerge(local, { items: [serverItem('crs_a')] }), ['crs_b']);
  assert.deepEqual(coursesToMerge([], { items: [] }), []);
});

test('mergeIntoServer adds the signed-out cart to the account once and returns the server cart', async () => {
  const server = fakeServer([serverItem('crs_a')]);
  const cart = await mergeIntoServer([course('crs_a'), course('crs_b'), course('crs_c')], server.call);
  assert.deepEqual(cart.items.map((i) => i.courseId), ['crs_a', 'crs_b', 'crs_c']);
  assert.deepEqual(server.calls, ['GET /api/me/cart', 'POST /api/me/cart/items crs_b', 'POST /api/me/cart/items crs_c']);
  const again = await mergeIntoServer(fromServerCart(cart), server.call);
  assert.equal(again.count, 3, 'a second merge adds nothing');
  assert.equal(server.calls.length, 4);
});

test('mergeIntoServer skips courses the server refuses (enrolled, unknown) but not other failures', async () => {
  const server = fakeServer([], { reject: { crs_enrolled: 409, crs_gone: 404 } });
  const cart = await mergeIntoServer([course('crs_enrolled'), course('crs_gone'), course('crs_ok')], server.call);
  assert.deepEqual(cart.items.map((i) => i.courseId), ['crs_ok']);
  const failing = fakeServer([], { reject: { crs_x: 503 } });
  await assert.rejects(mergeIntoServer([course('crs_x')], failing.call), (e) => e.status === 503);
});

test('addOnServer and removeOnServer return the updated server cart', async () => {
  const server = fakeServer();
  assert.equal((await addOnServer(server.call, 'crs_a')).count, 1);
  assert.equal((await removeOnServer(server.call, 'crs_a')).count, 0);
  assert.deepEqual(server.calls, ['POST /api/me/cart/items crs_a', 'DELETE /api/me/cart/items/crs_a']);
});

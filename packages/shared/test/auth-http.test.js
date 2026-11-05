import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueSessionToken, parseCookies, signJwt, verifyJwt } from '../src/auth.js';
import { HttpError, createHandler, ok } from '../src/http.js';
import { TEST_JWT_SECRET, apiEvent, setupTestEnvironment, testSessionCookie } from '../src/testing.js';

test('JWT round trip, tamper and expiry', () => {
  const token = signJwt({ sub: 'usr_1', exp: 2000 }, 'k');
  assert.equal(verifyJwt(token, 'k', 1000).sub, 'usr_1');
  assert.equal(verifyJwt(token, 'k', 2001), null);
  assert.equal(verifyJwt(token, 'other', 1000), null);
  assert.equal(verifyJwt(`${token}x`, 'k', 1000), null);
  const { sessionId } = issueSessionToken({ userId: 'usr_1', role: 'learner' }, TEST_JWT_SECRET);
  assert.match(sessionId, /^ses_[0-9a-f]{16}$/);
});

test('cookies from the v2 cookies array and the Cookie header', () => {
  assert.deepEqual(parseCookies({ cookies: ['a=1'], headers: { cookie: 'b=2; c=3' } }), { a: '1', b: '2', c: '3' });
});

const routes = [
  { method: 'GET', path: '/api/open', auth: 'public', handler: async () => ok({ open: true }) },
  { method: 'GET', path: '/api/mine', auth: 'user', handler: async (req) => ok({ id: req.user.userId }) },
  { method: 'GET', path: '/api/staff', auth: 'staff', handler: async () => ok({}) },
  { method: 'GET', path: '/api/teapot', auth: 'public', handler: async () => { throw new HttpError(418, 'teapot'); } },
  { method: 'GET', path: '/api/boom', auth: 'public', handler: async () => { throw new Error('boom'); } },
];

test('handler enforces auth and writes exactly one request line per request', async () => {
  const env = setupTestEnvironment();
  const handler = createHandler({ service: 'catalog', routes });
  const cookie = await testSessionCookie({ userId: 'usr_0123456789ab' });
  const results = {
    open: await handler(apiEvent('GET /api/open')),
    anon: await handler(apiEvent('GET /api/mine')),
    mine: await handler(apiEvent('GET /api/mine', { cookie })),
    staff: await handler(apiEvent('GET /api/staff', { cookie })),
    teapot: await handler(apiEvent('GET /api/teapot')),
    boom: await handler(apiEvent('GET /api/boom')),
    missing: await handler(apiEvent('GET /api/nothing')),
  };
  env.logs.restore();
  assert.equal(results.open.statusCode, 200);
  assert.equal(results.anon.statusCode, 401);
  assert.equal(JSON.parse(results.mine.body).id, 'usr_0123456789ab');
  assert.equal(results.staff.statusCode, 403);
  assert.equal(results.teapot.statusCode, 418);
  assert.equal(results.boom.statusCode, 500);
  assert.equal(results.missing.statusCode, 404);
  const requests = env.logs.records.filter((r) => r.kind === 'request');
  assert.equal(requests.length, 7);
  assert.equal(requests[2]['user.id'].startsWith('u_'), true);
  assert.equal(requests[0]['user.id'], undefined);
  assert.equal(requests[6]['http.route'], 'unmatched');
  assert.ok(env.logs.lines.every((l) => !l.includes('usr_0123456789ab')));
});

test('scheduled jobs run with a system context', async () => {
  const env = setupTestEnvironment();
  let ran = false;
  const handler = createHandler({ service: 'billing', routes: [], jobs: { tick: async () => { ran = true; } } });
  assert.deepEqual(await handler({ job: 'tick' }, { awsRequestId: 'abc' }), { ok: true });
  assert.equal(ran, true);
  assert.deepEqual(await handler({ job: 'nope' }), { ok: false });
  env.logs.restore();
});

test('a handler that runs past the Lambda deadline still gets a 504 and a request line', async () => {
  const env = setupTestEnvironment();
  const slow = [{ method: 'GET', path: '/api/slow', auth: 'public', handler: () => new Promise((r) => setTimeout(() => r(ok({})), 5_000)) }];
  const handler = createHandler({ service: 'admin', routes: slow });
  const res = await handler(apiEvent('GET /api/slow'), { getRemainingTimeInMillis: () => 600 });
  env.logs.restore();
  assert.equal(res.statusCode, 504);
  const request = env.logs.records.filter((r) => r.kind === 'request');
  assert.equal(request.length, 1);
  assert.equal(request[0]['http.status_code'], 504);
});

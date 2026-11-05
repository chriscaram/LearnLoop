import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IDS, apiEvent, checkRoutesTable, fixtureData, setupTestEnvironment, TEST_JWT_SECRET, TEST_SALT, testSessionCookie } from '@learnloop/shared/testing';
import { verifyJwt } from '@learnloop/shared/auth';
import { pseudonymiseUser } from '@learnloop/shared/logger';
import { DEMO_PASSWORD, createSession, getCurrentUser, passwordMatches, toPublicUser, verifyCredentials } from '../src/services/auth.js';
import { findUserByEmail, findUserById } from '../src/repositories/users.js';
import { routes } from '../src/routes.js';
import { handler } from '../src/handler.js';

let env;
beforeEach(() => { env = setupTestEnvironment({ data: fixtureData() }); });

test('routes table', () => {
  checkRoutesTable(assert, routes, { service: 'identity', expected: ['POST /api/auth/login', 'POST /api/auth/logout', 'GET /api/me'] });
});

test('passwordMatches only accepts the demo password', () => {
  assert.equal(passwordMatches(DEMO_PASSWORD), true);
  assert.equal(passwordMatches('nope'), false);
  assert.equal(passwordMatches(undefined), false);
});

test('verifyCredentials: case-insensitive email, unknown email and bad password rejected', async () => {
  assert.equal((await verifyCredentials('Lee.Learner@example.com', DEMO_PASSWORD)).id, IDS.learner);
  assert.equal(await verifyCredentials('nobody@example.com', DEMO_PASSWORD), null);
  assert.equal(await verifyCredentials('lee.learner@example.com', 'wrong'), null);
});

test('repositories find users', async () => {
  assert.equal((await findUserByEmail(' lee.learner@example.com ')).id, IDS.learner);
  assert.equal((await findUserById(IDS.staff)).role, 'staff');
  assert.equal(await findUserById('usr_ffffffffffff'), null);
});

test('createSession issues a verifiable token with role and session id', () => {
  const { token, sessionId } = createSession({ id: IDS.learner, role: 'learner' }, TEST_JWT_SECRET, 1000);
  const payload = verifyJwt(token, TEST_JWT_SECRET, 1001);
  assert.equal(payload.sub, IDS.learner);
  assert.equal(payload.sid, sessionId);
});

test('toPublicUser and getCurrentUser expose only public fields', async () => {
  assert.deepEqual(Object.keys(toPublicUser(fixtureData().users[0])), ['id', 'name', 'email', 'role']);
  assert.equal((await getCurrentUser(IDS.learner)).name, 'Lee Learner');
  assert.equal(await getCurrentUser('usr_ffffffffffff'), null);
});

test('login sets an HttpOnly cookie and logs user_signed_in with the pseudonymised id', async () => {
  const res = await handler(apiEvent('POST /api/auth/login', { body: { email: 'lee.learner@example.com', password: DEMO_PASSWORD } }));
  env.logs.restore();
  assert.equal(res.statusCode, 200);
  assert.match(res.cookies[0], /^ll_session=.+HttpOnly/);
  const [event] = env.logs.events('user_signed_in');
  assert.equal(event['user.id'], pseudonymiseUser(TEST_SALT, IDS.learner));
  assert.match(event['session.id'], /^s_[0-9a-f]{16}$/);
  const request = env.logs.records.find((r) => r.kind === 'request');
  assert.equal(request['user.id'], event['user.id']);
  assert.ok(!env.logs.lines.join('').includes('example.com'));
});

test('unknown email returns 401 and logs sign_in_failed', async () => {
  const res = await handler(apiEvent('POST /api/auth/login', { body: { email: 'x@example.com', password: DEMO_PASSWORD } }));
  env.logs.restore();
  assert.equal(res.statusCode, 401);
  const [event] = env.logs.events('sign_in_failed');
  assert.equal(event.outcome, 'failed');
  assert.equal(event['error.type'], 'invalid_credentials');
});

test('GET /api/me and logout', async () => {
  const cookie = await testSessionCookie({ userId: IDS.learner });
  const me = await handler(apiEvent('GET /api/me', { cookie }));
  assert.equal(JSON.parse(me.body).user.email, 'lee.learner@example.com');
  const out = await handler(apiEvent('POST /api/auth/logout', { cookie }));
  env.logs.restore();
  assert.match(out.cookies[0], /Max-Age=0/);
  assert.equal(env.logs.events('user_signed_out').length, 1);
});

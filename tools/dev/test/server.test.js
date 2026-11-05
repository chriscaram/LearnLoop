import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureLogs } from '@learnloop/shared/testing';
import { buildRouteTable, configureLocalEnvironment, createDevServer, matchRoute } from '../src/server.js';

test('route table matches templates and prefers static segments', () => {
  const table = buildRouteTable();
  assert.equal(matchRoute(table, 'GET', '/api/me/notifications/unread-count').route.path, '/api/me/notifications/unread-count');
  const m = matchRoute(table, 'GET', '/api/lessons/les_0123456789ab');
  assert.equal(m.route.path, '/api/lessons/{lessonId}');
  assert.deepEqual(m.pathParameters, { lessonId: 'les_0123456789ab' });
  assert.equal(matchRoute(table, 'DELETE', '/api/me'), null);
  assert.equal(table.length, 22);
});

test('end to end against the seed data: sign in, read progress and notifications', async () => {
  configureLocalEnvironment();
  const logs = captureLogs();
  const server = createDevServer().listen(0);
  const base = `http://localhost:${server.address().port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ana.moreno@example.com', password: 'learnloop-demo' }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const progress = await (await fetch(`${base}/api/me/progress`, { headers: { cookie } })).json();
    assert.ok(Array.isArray(progress.courses));
    const unread = await (await fetch(`${base}/api/me/notifications/unread-count`, { headers: { cookie } })).json();
    assert.equal(typeof unread.unread, 'number');
  } finally {
    server.close();
    logs.restore();
  }
  assert.ok(logs.records.filter((r) => r.kind === 'request').length >= 3);
});

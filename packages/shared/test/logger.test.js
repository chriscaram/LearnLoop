import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT_NAMES, bindUser, buildEventRecord, buildRequestRecord, logEvent, logRequest, logWarn,
  pseudonymiseSession, pseudonymiseUser, runWithLogContext, sanitizeRoute, traceIdFromHeaders,
} from '../src/logger.js';
import { captureLogs } from '../src/testing.js';

const SALT = 'unit-salt';
const ctx = () => ({
  service: 'learning', version: 'a1b2c3d', environment: 'prod',
  traceId: '0123456789abcdef0123456789abcdef', requestId: 'Abc123=', salt: SALT,
  userId: 'usr_3c9e1a7b20f4', sessionId: 'ses_00aa11bb22cc33dd', role: 'learner',
});

test('pseudonymisation is u_/s_ + 16 hex of HMAC-SHA256 and stable', () => {
  const id = pseudonymiseUser(SALT, 'usr_3c9e1a7b20f4');
  assert.match(id, /^u_[0-9a-f]{16}$/);
  assert.equal(id, pseudonymiseUser(SALT, 'usr_3c9e1a7b20f4'));
  assert.notEqual(id, pseudonymiseUser('other', 'usr_3c9e1a7b20f4'));
  assert.match(pseudonymiseSession(SALT, 'ses_1'), /^s_[0-9a-f]{16}$/);
});

test('request line has every contract field, one JSON object per line', () => {
  const logs = captureLogs();
  runWithLogContext(ctx(), () => logRequest({
    method: 'get', route: '/api/lessons/{lessonId}', statusCode: 200, latencyMs: 84.4, userAgent: 'Mozilla/5.0',
  }));
  logs.restore();
  assert.equal(logs.lines.length, 1);
  assert.ok(!logs.lines[0].includes('\n'));
  const r = JSON.parse(logs.lines[0]);
  assert.deepEqual(Object.keys(r), [
    'timestamp', 'level', 'kind', 'service.name', 'service.version', 'deployment.environment',
    'http.method', 'http.route', 'http.status_code', 'latency_ms', 'request_id', 'trace_id',
    'user.id', 'session.id', 'user_agent', 'message',
  ]);
  assert.match(r.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(r.level, 'info');
  assert.equal(r.kind, 'request');
  assert.equal(r['service.name'], 'learning');
  assert.equal(r['http.method'], 'GET');
  assert.equal(r['http.status_code'], 200);
  assert.equal(r.latency_ms, 84);
  assert.equal(r['user.id'], pseudonymiseUser(SALT, 'usr_3c9e1a7b20f4'));
  assert.equal(r.message, 'GET /api/lessons/{lessonId} 200');
});

test('anonymous request has no user.id / session.id; status drives level', () => {
  const r = buildRequestRecord({
    timestamp: 't', service: 'identity', version: 'v', environment: 'prod', method: 'POST',
    route: '/api/auth/login', statusCode: 401, latencyMs: 3, requestId: 'r', traceId: 'x', userAgent: 'ua',
  });
  assert.equal(r['user.id'], undefined);
  assert.equal(r['session.id'], undefined);
  assert.equal(r.level, 'warn');
  assert.equal(buildRequestRecord({ timestamp: 't', method: 'GET', route: '/x', statusCode: 503, traceId: 'x' }).level, 'error');
});

test('event line has contract fields and uses the closed event list', () => {
  const logs = captureLogs();
  runWithLogContext(ctx(), () => logEvent({ event: 'quiz_submitted', entityType: 'lesson', entityId: 'les_7f3a9c2e41b8', value: 80 }));
  logs.restore();
  const r = logs.records[0];
  assert.deepEqual(Object.keys(r), [
    'timestamp', 'level', 'kind', 'service.name', 'service.version', 'deployment.environment',
    'trace_id', 'request_id', 'user.id', 'session.id', 'event', 'entity.type', 'entity.id',
    'outcome', 'actor_type', 'value', 'message',
  ]);
  assert.equal(r.kind, 'event');
  assert.equal(r.actor_type, 'learner');
  assert.equal(r.outcome, 'ok');
  assert.equal(r.value, 80);
  assert.throws(() => buildEventRecord({ event: 'something_else' }), TypeError);
  assert.equal(EVENT_NAMES.length, 19);
});

test('failed events carry error.type and level warn; staff role maps to staff actor', () => {
  const logs = captureLogs();
  runWithLogContext({ ...ctx(), role: 'staff' }, () => {
    logEvent({ event: 'email_sent', entityType: 'email', entityId: 'eml_0123456789ab', outcome: 'failed', errorType: 'MessageRejected', actorType: 'system' });
    logEvent({ event: 'feature_flag_changed', entityType: 'feature_flag', entityId: 'new_catalog_filters' });
  });
  logs.restore();
  const [failed, flag] = logs.records;
  assert.equal(failed.level, 'warn');
  assert.equal(failed['error.type'], 'MessageRejected');
  assert.equal(failed.actor_type, 'system');
  assert.equal(flag.actor_type, 'staff');
});

test('bindUser attaches identity after sign-in', () => {
  const logs = captureLogs();
  const c = { ...ctx(), userId: undefined, sessionId: undefined, role: undefined };
  runWithLogContext(c, () => {
    bindUser({ userId: 'usr_aaaaaaaaaaaa', sessionId: 'ses_1', role: 'learner' });
    logEvent({ event: 'user_signed_in', entityType: 'user_session', entityId: 'session' });
  });
  logs.restore();
  assert.equal(logs.records[0]['user.id'], pseudonymiseUser(SALT, 'usr_aaaaaaaaaaaa'));
});

test('emails, tokens, query strings and IPs never reach the output', () => {
  const email = 'ana.moreno@example.com';
  const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c3IifQ.c2lnbmF0dXJl';
  const query = 'category=Data&token=supersecret';
  const logs = captureLogs();
  runWithLogContext({ ...ctx(), requestId: email }, () => {
    logEvent({
      event: 'catalog_viewed', entityType: 'course', entityId: email,
      email, token, password: 'learnloop-demo', name: 'Ana Moreno', ip: '203.0.113.7',
      'http.route': `/api/courses?${query}`, body: { email }, cookie: `ll_session=${token}`,
    });
    logRequest({
      method: 'GET', route: `/api/courses?${query}`, statusCode: 200, latencyMs: 1,
      userAgent: `Mozilla/5.0 ${token}`, email, token, query, cookie: token,
    });
    logWarn(`failed for ${email} from 203.0.113.7 with ${token}`, { errorType: email });
  });
  logs.restore();
  const output = logs.lines.join('\n');
  for (const secret of [email, token, query, 'supersecret', 'learnloop-demo', 'Ana Moreno', '203.0.113.7', '?', 'll_session']) {
    assert.ok(!output.includes(secret), `output leaked ${secret}`);
  }
  assert.equal(logs.records[1]['http.route'], '/api/courses');
  for (const line of logs.lines) JSON.parse(line);
});

test('sanitizeRoute strips query and fragment', () => {
  assert.equal(sanitizeRoute('/api/x?y=1#z'), '/api/x');
  assert.equal(sanitizeRoute(undefined), 'unmatched');
});

test('trace id from traceparent, X-Amzn-Trace-Id, or generated', () => {
  assert.equal(traceIdFromHeaders({ traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' }), '4bf92f3577b34da6a3ce929d0e0e4736');
  assert.equal(traceIdFromHeaders({ 'x-amzn-trace-id': 'Root=1-5759e988-bd862e3fe1be46a994272793' }), '5759e988bd862e3fe1be46a994272793');
  assert.match(traceIdFromHeaders({}), /^[0-9a-f]{32}$/);
});

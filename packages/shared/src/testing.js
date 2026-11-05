// Test and local-development fakes. No network access.
import { setAwsClients, resetAwsClients } from './aws.js';
import { setLogSink } from './logger.js';
import { clearParameterCache } from './params.js';
import { resetFlagCache } from './flags.js';
import { MemoryStateStore, setStore } from './store.js';

export const TEST_SALT = 'test-salt';
export const TEST_JWT_SECRET = 'test-jwt-secret-with-enough-length-0123456789';

/** Minimal SSM fake: GetParameter / PutParameter on an in-memory map. */
export class FakeSsm {
  constructor(params = {}) {
    this.params = new Map(Object.entries(params));
    this.failReads = false;
    this.calls = [];
  }

  async send(command) {
    const name = command.constructor.name;
    this.calls.push({ name, input: command.input });
    if (name === 'GetParameterCommand') {
      if (this.failReads) throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
      if (!this.params.has(command.input.Name)) {
        throw Object.assign(new Error('not found'), { name: 'ParameterNotFound' });
      }
      return { Parameter: { Name: command.input.Name, Value: this.params.get(command.input.Name) } };
    }
    if (name === 'PutParameterCommand') {
      this.params.set(command.input.Name, command.input.Value);
      return { Version: 1 };
    }
    throw new Error(`FakeSsm: unsupported ${name}`);
  }
}

/** Secrets Manager fake: GetSecretValue on an in-memory map. */
export class FakeSecrets {
  constructor(secrets = {}) {
    this.secrets = new Map(Object.entries(secrets));
  }

  async send(command) {
    const id = command.input.SecretId;
    if (command.constructor.name !== 'GetSecretValueCommand') throw new Error(`FakeSecrets: unsupported ${command.constructor.name}`);
    if (!this.secrets.has(id)) throw Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' });
    return { Name: id, SecretString: this.secrets.get(id) };
  }
}

export function defaultSecrets() {
  return {
    'learnloop/prod/jwt-secret': TEST_JWT_SECRET,
    'learnloop/prod/log-pseudonym-salt': TEST_SALT,
  };
}

/** SES fake that records SendEmail calls. */
export class FakeSes {
  constructor() {
    this.sent = [];
    this.fail = false;
  }

  async send(command) {
    if (this.fail) throw Object.assign(new Error('rejected'), { name: 'MessageRejected' });
    this.sent.push(command.input);
    return { MessageId: `fake-${this.sent.length}` };
  }
}

export function defaultParameters({ flags = {} } = {}) {
  return {
    '/learnloop/prod/feature-flags': JSON.stringify(flags),
  };
}

/** Collects log lines; returns { lines, records, restore }. */
export function captureLogs() {
  const lines = [];
  const previous = setLogSink((line) => lines.push(line));
  return {
    lines,
    get records() {
      return lines.map((line) => JSON.parse(line));
    },
    events(name) {
      return this.records.filter((r) => r.kind === 'event' && (!name || r.event === name));
    },
    clear() {
      lines.length = 0;
    },
    restore() {
      setLogSink(previous);
    },
  };
}

/**
 * Fresh fakes for a test: memory store with the given domain data,
 * fake SSM/Secrets Manager/SES, captured logs.
 */
export function setupTestEnvironment({ data = {}, flags = {} } = {}) {
  const ssm = new FakeSsm(defaultParameters({ flags }));
  const ses = new FakeSes();
  const secrets = new FakeSecrets(defaultSecrets());
  resetAwsClients();
  setAwsClients({ ssm, ses, secrets, s3: { send: async () => { throw new Error('S3 not available in tests'); } } });
  clearParameterCache();
  resetFlagCache();
  const store = new MemoryStateStore({ data });
  setStore(store);
  const logs = captureLogs();
  return { ssm, ses, secrets, store, logs };
}

/** API Gateway HTTP API v2 event for handler tests. */
export function apiEvent(routeKey, { pathParameters, body, cookie, query, headers = {} } = {}) {
  const [method, path] = routeKey.split(' ');
  return {
    version: '2.0',
    routeKey,
    rawPath: path,
    headers: { 'user-agent': 'Mozilla/5.0 (test)', ...headers, ...(cookie ? { cookie } : {}) },
    pathParameters,
    queryStringParameters: query,
    requestContext: { requestId: 'req-test-0001', http: { method, path } },
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
  };
}

/** Cookie header for a signed-in test user. */
export async function testSessionCookie({ userId, role = 'learner' }) {
  const { issueSessionToken, SESSION_COOKIE } = await import('./auth.js');
  const { token } = issueSessionToken({ userId, role }, TEST_JWT_SECRET);
  return `${SESSION_COOKIE}=${token}`;
}

// ---------------------------------------------------------------------------
// Small, hand-written dataset shared by the service tests.

export const IDS = Object.freeze({
  learner: 'usr_0000000000a1',
  learnerNoSub: 'usr_0000000000b2',
  staff: 'usr_0000000000f1',
  cloud: 'crs_0000000000c1',
  data: 'crs_0000000000c2',
  lesson1: 'les_000000000011',
  lesson2: 'les_000000000012',
  lesson3: 'les_000000000013',
  dataLesson: 'les_000000000021',
  sub: 'sub_0000000000d1',
  ntfRead: 'ntf_0000000000e1',
  ntfUnread: 'ntf_0000000000e2',
});

export function fixtureData() {
  const quiz = {
    questions: [
      { id: 'q1', prompt: 'Which one is a region?', options: ['us-east-1', 'eu-west-9z'], answer_index: 0 },
      { id: 'q2', prompt: 'Is S3 object storage?', options: ['Yes', 'No'], answer_index: 0 },
    ],
  };
  return {
    users: [
      { id: IDS.learner, email: 'lee.learner@example.com', name: 'Lee Learner', role: 'learner', created_at: '2026-06-01T09:00:00.000Z' },
      { id: IDS.learnerNoSub, email: 'nia.nosub@example.com', name: 'Nia Nosub', role: 'learner', created_at: '2026-06-01T09:00:00.000Z' },
      { id: IDS.staff, email: 'sam.staff@example.com', name: 'Sam Staff', role: 'staff', created_at: '2026-01-01T09:00:00.000Z' },
    ],
    courses: [
      { id: IDS.cloud, title: 'Cloud Foundations', category: 'Cloud', level: 'Beginner', summary: 's', description: 'd', lesson_ids: [IDS.lesson1, IDS.lesson2, IDS.lesson3], duration_min: 60, published_at: '2026-01-01T00:00:00.000Z' },
      { id: IDS.data, title: 'SQL for Analysts', category: 'Data', level: 'Beginner', summary: 's', description: 'd', lesson_ids: [IDS.dataLesson], duration_min: 15, published_at: '2026-01-01T00:00:00.000Z' },
    ],
    lessons: [
      { id: IDS.lesson1, course_id: IDS.cloud, position: 1, title: 'One', duration_min: 10, body_md: '# One', quiz: null },
      { id: IDS.lesson2, course_id: IDS.cloud, position: 2, title: 'Two', duration_min: 20, body_md: '# Two', quiz: null },
      { id: IDS.lesson3, course_id: IDS.cloud, position: 3, title: 'Three', duration_min: 30, body_md: '# Three', quiz },
      { id: IDS.dataLesson, course_id: IDS.data, position: 1, title: 'Select', duration_min: 15, body_md: '# Select', quiz: null },
    ],
    enrolments: [
      { id: 'enr_0000000000a1', user_id: IDS.learner, course_id: IDS.cloud, enrolled_at: '2026-09-01T10:00:00.000Z' },
    ],
    progress: {
      lessons: [
        { user_id: IDS.learner, course_id: IDS.cloud, lesson_id: IDS.lesson1, status: 'completed', started_at: '2026-10-01T10:00:00.000Z', completed_at: '2026-10-01T10:12:00.000Z' },
        { user_id: IDS.learner, course_id: IDS.cloud, lesson_id: IDS.lesson2, status: 'started', started_at: '2026-10-05T10:00:00.000Z', completed_at: null },
      ],
      courses: [
        { user_id: IDS.learner, course_id: IDS.cloud, last_activity_at: '2026-10-05T10:00:00.000Z' },
      ],
    },
    subscriptions: [
      { id: IDS.sub, user_id: IDS.learner, plan: 'monthly', price_usd: 19, status: 'active', started_at: '2026-06-10T08:00:00.000Z', current_period_start: '2026-10-10T08:00:00.000Z', current_period_end: '2026-11-10T08:00:00.000Z', cancelled_at: null },
    ],
    notifications: [
      { id: IDS.ntfRead, user_id: IDS.learner, type: 'welcome', title: 'Welcome', body: 'b', link: '/courses', created_at: '2026-06-10T08:00:00.000Z', read_at: '2026-06-10T09:00:00.000Z' },
      { id: IDS.ntfUnread, user_id: IDS.learner, type: 'payment_receipt', title: 'Payment received', body: 'b', link: '/subscription', created_at: '2026-10-10T08:00:00.000Z', read_at: null },
    ],
    quiz_results: [],
  };
}

/** Shared assertions for a service's routes table. */
export function checkRoutesTable(assert, routes, { service, expected }) {
  const keys = routes.map((r) => `${r.method} ${r.path}`);
  assert.deepEqual([...keys].sort(), [...expected].sort(), `${service} routes`);
  assert.equal(new Set(keys).size, keys.length, 'no duplicate routes');
  for (const route of routes) {
    assert.equal(typeof route.handler, 'function', `${route.path} has a handler`);
    assert.ok(['GET', 'POST', 'PUT', 'DELETE'].includes(route.method));
    assert.match(route.path, /^\/api(\/([a-z-]+|\{[a-zA-Z]+\}))+$/, `${route.path} is a template`);
    assert.ok(['public', 'user', 'staff'].includes(route.auth));
  }
}

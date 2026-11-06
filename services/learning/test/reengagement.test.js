import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runReengagementNudges,
  eligibleCourses,
  GUARDRAILS,
  FLAG_KEY,
  JOB_NAME,
  jobs,
  startReengagementScheduler
} from '../src/jobs/reengagementNudges.js';
import { composeMessage, factLine } from '../src/agents/reengagementAgent.js';

const NOW = new Date('2026-11-10T09:00:00.000Z');

function calls() {
  const seen = [];
  const fn = async (...args) => {
    seen.push(args);
    return { ok: true };
  };
  fn.calls = seen;
  return fn;
}

/** A mocked model: never a network or AWS call. */
function mockModel(responses) {
  const queue = [...responses];
  const invoked = [];
  return {
    invoked,
    async invoke(prompt) {
      invoked.push(prompt);
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return { content: JSON.stringify(next) };
    }
  };
}

function learner(overrides = {}) {
  return { id: 'u1', firstName: 'Ada', email: 'ada@example.com', ...overrides };
}

function deps(overrides = {}) {
  const createNotification = calls();
  const sendEmail = calls();
  const listEnrolledCourseIds = async () => ['c1'];
  const listProgressOverview = async () => [
    {
      courseId: 'c1',
      courseTitle: 'Intro to Node',
      lessonsCompleted: 3,
      lessonsTotal: 10
    }
  ];
  const completionPercent = async () => 42;
  const daysSinceLastActivity = async () => 12;
  const nextLessonFor = async () => ({ id: 'l7', title: 'Streams in depth' });
  const listNotifications = async () => [];
  const base = {
    listEnrolledCourseIds: Object.assign(calls(), {}),
    listProgressOverview,
    completionPercent,
    daysSinceLastActivity,
    nextLessonFor,
    createNotification,
    sendEmail,
    listNotifications
  };
  // wrap the deterministic readers so the test can assert they were called
  const spy = (impl) => {
    const f = async (...args) => {
      f.calls.push(args);
      return impl(...args);
    };
    f.calls = [];
    return f;
  };
  return {
    ...base,
    listEnrolledCourseIds: spy(listEnrolledCourseIds),
    listProgressOverview: spy(listProgressOverview),
    completionPercent: spy(completionPercent),
    daysSinceLastActivity: spy(daysSinceLastActivity),
    nextLessonFor: spy(nextLessonFor),
    ...overrides
  };
}

test('flag off: the trigger does nothing and nothing is sent', async () => {
  const d = deps();
  const model = mockModel([{ nudge: true, courseId: 'c1' }]);
  const result = await runReengagementNudges({
    now: NOW,
    model,
    deps: d,
    listLearners: async () => [learner()],
    flagClient: { isEnabled: async (key) => (key === FLAG_KEY ? false : false) },
    logger: { info() {}, warn() {}, error() {} }
  });

  assert.equal(result.enabled, false);
  assert.equal(result.sent, 0);
  assert.equal(d.createNotification.calls.length, 0);
  assert.equal(d.sendEmail.calls.length, 0);
  assert.equal(model.invoked.length, 0);
  assert.equal(d.listProgressOverview.calls.length, 0);
});

test('flag on: cited deterministic functions are called and one nudge is sent', async () => {
  const d = deps();
  const model = mockModel([
    { nudge: true, courseId: 'c1', reason: 'close to finishing' },
    { subject: 'Ready for your next lesson?', body: 'You were doing great.' }
  ]);
  const result = await runReengagementNudges({
    now: NOW,
    model,
    deps: d,
    listLearners: async () => [learner()],
    flagClient: { isEnabled: async (key) => key === FLAG_KEY },
    logger: { info() {}, warn() {}, error() {} }
  });

  assert.equal(result.enabled, true);
  assert.equal(result.sent, 1);
  assert.ok(d.listEnrolledCourseIds.calls.length >= 1, 'listEnrolledCourseIds called');
  assert.ok(d.listProgressOverview.calls.length >= 1, 'listProgressOverview called');
  assert.ok(d.completionPercent.calls.length >= 1, 'completionPercent called');
  assert.ok(d.daysSinceLastActivity.calls.length >= 1, 'daysSinceLastActivity called');
  assert.ok(d.nextLessonFor.calls.length >= 1, 'nextLessonFor called');

  assert.equal(d.createNotification.calls.length, 1);
  const notification = d.createNotification.calls[0][0];
  assert.equal(notification.userId, 'u1');
  assert.equal(notification.applied_by_agent, true);
  assert.equal(notification.metadata.applied_by_agent, true);
  assert.equal(notification.metadata.flag_key, FLAG_KEY);
  // the percent and lesson title come from deterministic code, not the model
  assert.match(notification.body, /42% complete/);
  assert.match(notification.body, /Streams in depth/);

  assert.equal(d.sendEmail.calls.length, 1);
  assert.equal(d.sendEmail.calls[0][0].to, 'ada@example.com');
});

test('guardrail: 14-day cooldown blocks a second nudge', async () => {
  const d = deps({
    listNotifications: async () => [
      { metadata: { agent: 'reengagement_nudge' }, createdAt: '2026-11-05T09:00:00.000Z' }
    ]
  });
  const model = mockModel([{ nudge: true, courseId: 'c1' }]);
  const result = await runReengagementNudges({
    now: NOW,
    model,
    deps: d,
    listLearners: async () => [learner()],
    flagClient: { isEnabled: async () => true },
    logger: { info() {}, warn() {}, error() {} }
  });

  assert.equal(result.sent, 0);
  assert.equal(result.skipped, 1);
  assert.equal(d.createNotification.calls.length, 0);
});

test('guardrail: finished, zero-progress and fresh-activity courses are never eligible', async () => {
  const finished = deps({ completionPercent: async () => 100 });
  assert.equal((await eligibleCourses({ learner: learner(), deps: finished, now: NOW })).length, 0);

  const noProgress = deps({
    listProgressOverview: async () => [
      { courseId: 'c1', courseTitle: 'Intro to Node', lessonsCompleted: 0, lessonsTotal: 10 }
    ]
  });
  assert.equal((await eligibleCourses({ learner: learner(), deps: noProgress, now: NOW })).length, 0);

  const active = deps({ daysSinceLastActivity: async () => 1 });
  assert.equal((await eligibleCourses({ learner: learner(), deps: active, now: NOW })).length, 0);
});

test('guardrail: global send cap bounds volume and only one course per message', async () => {
  const d = deps();
  const many = Array.from({ length: GUARDRAILS.maxSendsPerRun + 5 }, (_, i) => learner({ id: `u${i}` }));
  const model = mockModel([
    { nudge: true, courseId: 'c1' },
    { subject: 's', body: 'b' }
  ]);
  const result = await runReengagementNudges({
    now: NOW,
    model,
    deps: d,
    listLearners: async () => many,
    flagClient: { isEnabled: async () => true },
    logger: { info() {}, warn() {}, error() {} }
  });

  assert.ok(result.sent <= GUARDRAILS.maxSendsPerRun);
  for (const [payload] of d.createNotification.calls) {
    assert.equal(typeof payload.metadata.course_id, 'string');
  }
});

test('model cannot invent a course: an unknown id falls back to the deterministic choice', async () => {
  const d = deps();
  const model = mockModel([
    { nudge: true, courseId: 'not-a-real-course' },
    { subject: 's', body: 'b' }
  ]);
  await runReengagementNudges({
    now: NOW,
    model,
    deps: d,
    listLearners: async () => [learner()],
    flagClient: { isEnabled: async () => true },
    logger: { info() {}, warn() {}, error() {} }
  });

  assert.equal(d.createNotification.calls[0][0].metadata.course_id, 'c1');
});

test('fact line and job registration', () => {
  const course = {
    courseTitle: 'Intro to Node',
    percentComplete: 42,
    nextLessonTitle: 'Streams in depth',
    nextLessonUrl: '/lessons/l7'
  };
  assert.match(factLine(course), /Intro to Node: 42% complete\. Next lesson: Streams in depth\./);
  const composed = composeMessage({ drafted: { subject: 'Hi', body: 'Keep going.' }, course });
  assert.match(composed.body, /\/lessons\/l7/);

  assert.equal(typeof jobs[JOB_NAME], 'function');
  const scheduler = startReengagementScheduler({ intervalMs: 60000 });
  assert.equal(typeof scheduler.stop, 'function');
  scheduler.stop();
});
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runReengagementNudges, GUARDRAILS } = require('../src/jobs/reengagement');

function fakeModel() {
  const calls = [];
  return {
    calls,
    async invoke(messages) {
      calls.push(messages);
      const content =
        calls.length === 1
          ? JSON.stringify({ action: 'nudge', course_id: 'course-1', reason: 'stalled mid-course' })
          : JSON.stringify({
              subject: 'Ready to pick up where you left off?',
              body: 'You made a strong start. Your next lesson is short and waiting for you.'
            });
      return { content };
    }
  };
}

function fakeDeps(overrides = {}) {
  const calls = {
    listEnrolledCourseIds: [],
    listProgressOverview: [],
    completionPercent: [],
    nextLessonFor: [],
    daysSinceLastActivity: [],
    createNotification: [],
    sendEmail: [],
    listNotifications: []
  };

  const deps = {
    isEnabled: async () => true,
    listEnrolledCourseIds: async (userId) => {
      calls.listEnrolledCourseIds.push(userId);
      return ['course-1'];
    },
    listProgressOverview: async (userId) => {
      calls.listProgressOverview.push(userId);
      return [{ courseId: 'course-1', courseTitle: 'Intro to Statistics', completedLessons: 3, totalLessons: 10 }];
    },
    completionPercent: async (userId, courseId) => {
      calls.completionPercent.push([userId, courseId]);
      return 42;
    },
    nextLessonFor: async (userId, courseId) => {
      calls.nextLessonFor.push([userId, courseId]);
      return { id: 'lesson-7', title: 'Sampling distributions' };
    },
    daysSinceLastActivity: async (userId, courseId) => {
      calls.daysSinceLastActivity.push([userId, courseId]);
      return 11;
    },
    listNotifications: async (userId) => {
      calls.listNotifications.push(userId);
      return [];
    },
    createNotification: async (payload) => {
      calls.createNotification.push(payload);
      return payload;
    },
    sendEmail: async (payload) => {
      calls.sendEmail.push(payload);
      return { ok: true };
    }
  };

  return { deps: Object.assign(deps, overrides), calls };
}

const silentLogger = { info() {}, warn() {}, error() {} };
const learners = [{ id: 'user-1', email: 'learner@example.com' }];

test('does nothing while the ga-find_a431764685ac flag is off', async () => {
  const { deps, calls } = fakeDeps({ isEnabled: async () => false });
  const model = fakeModel();

  const result = await runReengagementNudges({ deps, learners, model, logger: silentLogger });

  assert.equal(result.enabled, false);
  assert.equal(result.skipped, 'flag_off');
  assert.equal(result.sent, 0);
  assert.equal(model.calls.length, 0);
  assert.equal(calls.listProgressOverview.length, 0);
  assert.equal(calls.createNotification.length, 0);
  assert.equal(calls.sendEmail.length, 0);
});

test('uses the deterministic progress functions and sends one agent-marked nudge', async () => {
  const { deps, calls } = fakeDeps();
  const model = fakeModel();

  const result = await runReengagementNudges({ deps, learners, model, logger: silentLogger });

  assert.equal(result.sent, 1);
  assert.deepEqual(calls.listEnrolledCourseIds, ['user-1']);
  assert.deepEqual(calls.listProgressOverview, ['user-1']);
  assert.equal(calls.completionPercent.length, 1);
  assert.equal(calls.nextLessonFor.length, 1);
  assert.equal(calls.daysSinceLastActivity.length, 1);

  const notification = calls.createNotification[0];
  assert.equal(notification.userId, 'user-1');
  assert.equal(notification.applied_by_agent, true);
  // deterministic facts, not model output
  assert.match(notification.body, /42% complete/);
  assert.match(notification.body, /Sampling distributions/);
  assert.equal(notification.link, '/lessons/lesson-7');
  assert.equal(calls.sendEmail.length, 1);
  assert.equal(result.samples.length, 1);
});

test('rate limit: skips a learner nudged inside the 14 day cooldown', async () => {
  const recent = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const { deps, calls } = fakeDeps({
    listNotifications: async () => [{ applied_by_agent: true, createdAt: recent }]
  });
  const model = fakeModel();

  const result = await runReengagementNudges({ deps, learners, model, logger: silentLogger });

  assert.equal(result.sent, 0);
  assert.equal(result.skipped, 1);
  assert.equal(calls.createNotification.length, 0);
  assert.equal(model.calls.length, 0);
  assert.equal(GUARDRAILS.nudgeCooldownDays, 14);
});

test('skips learners with no progress or a finished course', async () => {
  const { deps, calls } = fakeDeps({ completionPercent: async () => 100 });
  const model = fakeModel();

  const result = await runReengagementNudges({ deps, learners, model, logger: silentLogger });

  assert.equal(result.sent, 0);
  assert.equal(calls.createNotification.length, 0);
});
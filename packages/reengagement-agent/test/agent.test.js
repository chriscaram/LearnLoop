import test from 'node:test';
import assert from 'node:assert/strict';

import { runReengagementAgent, FLAG_KEY, sanitiseDraft } from '../src/agent.js';
import { runReengagementNudgeJob, startReengagementScheduler } from '../src/job.js';

const NOW = '2026-11-20T09:00:00.000Z';

function calls() {
  const log = [];
  return {
    log,
    record(name) {
      return (...args) => {
        log.push({ name, args });
      };
    },
    names() {
      return this.log.map((c) => c.name);
    }
  };
}

/** The model is always mocked: no network, no AWS call. */
function fakeLlm(overrides = {}) {
  return {
    decide: overrides.decide || (async (facts) => ({ action: 'nudge', course_id: facts.candidates[0].course_id, reason: 'stalled' })),
    draft: overrides.draft || (async () => ({ subject: 'Pick up where you left off', body: 'You were doing well. Ready to carry on?' }))
  };
}

function baseDeps(overrides = {}) {
  const tracker = overrides.tracker || calls();
  const created = overrides.created || [];
  const emails = overrides.emails || [];
  const deps = {
    isFlagEnabled: async (key) => {
      tracker.log.push({ name: 'isFlagEnabled', args: [key] });
      return overrides.flag !== false;
    },
    listLearnerIds: async () => {
      tracker.log.push({ name: 'listLearnerIds', args: [] });
      return overrides.learners || [{ id: 'u1', email: 'learner@example.com', name: 'Lee' }];
    },
    listEnrolledCourseIds: async (userId) => {
      tracker.log.push({ name: 'listEnrolledCourseIds', args: [userId] });
      return overrides.enrolled || ['c1'];
    },
    listProgressOverview: async (userId) => {
      tracker.log.push({ name: 'listProgressOverview', args: [userId] });
      return (
        overrides.overview || [
          {
            course_id: 'c1',
            course_title: 'Intro to Pottery',
            lessons_completed: 3,
            lessons_total: 8,
            last_activity_at: '2026-11-01T10:00:00.000Z'
          }
        ]
      );
    },
    daysSinceLastActivity: async (...args) => {
      tracker.log.push({ name: 'daysSinceLastActivity', args });
      return overrides.days === undefined ? 19 : overrides.days;
    },
    completionPercent: async (...args) => {
      tracker.log.push({ name: 'completionPercent', args });
      return overrides.percent === undefined ? 37 : overrides.percent;
    },
    nextLessonFor: async (...args) => {
      tracker.log.push({ name: 'nextLessonFor', args });
      return overrides.nextLesson === undefined ? { id: 'l4', title: 'Centering the clay' } : overrides.nextLesson;
    },
    listNotifications: async (userId) => {
      tracker.log.push({ name: 'listNotifications', args: [userId] });
      return overrides.notifications || [];
    },
    createNotification: async (payload) => {
      tracker.log.push({ name: 'createNotification', args: [payload] });
      created.push(payload);
      return { id: 'n1', ...payload };
    },
    sendEmail: async (payload) => {
      tracker.log.push({ name: 'sendEmail', args: [payload] });
      emails.push(payload);
      return { ok: true };
    }
  };
  return { deps, tracker, created, emails };
}

test('does nothing at all while the flag is off', async () => {
  const { deps, tracker, created, emails } = baseDeps({ flag: false });
  const result = await runReengagementAgent({ deps, llm: fakeLlm(), now: NOW });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'flag_off');
  assert.equal(result.sent, 0);
  assert.deepEqual(created, []);
  assert.deepEqual(emails, []);
  assert.deepEqual(tracker.names(), ['isFlagEnabled']);
  assert.deepEqual(tracker.log[0].args, [FLAG_KEY]);
});

test('the scheduled job trigger is inert while the flag is off', async () => {
  const { deps, created } = baseDeps({ flag: false });
  const out = await runReengagementNudgeJob({ deps, llm: fakeLlm(), now: NOW }, {});
  assert.equal(out.reason, 'flag_off');
  assert.equal(out.flag, 'ga-find_a431764685ac');
  assert.deepEqual(created, []);
});

test('the in-process scheduler does nothing off the scheduled hour', async () => {
  const { deps, created } = baseDeps({});
  const stop = startReengagementScheduler({
    deps,
    llm: fakeLlm(),
    intervalMs: 1,
    now: '2026-11-20T03:00:00.000Z'
  });
  await new Promise((r) => setTimeout(r, 10));
  stop();
  assert.deepEqual(created, []);
});

test('calls the cited deterministic functions and sends one marked nudge', async () => {
  const { deps, tracker, created, emails } = baseDeps({});
  const result = await runReengagementAgent({ deps, llm: fakeLlm(), now: NOW });

  const names = tracker.names();
  for (const required of [
    'listEnrolledCourseIds',
    'listProgressOverview',
    'daysSinceLastActivity',
    'completionPercent',
    'nextLessonFor',
    'listNotifications',
    'createNotification',
    'sendEmail'
  ]) {
    assert.ok(names.includes(required), `expected ${required} to be called`);
  }

  assert.equal(result.sent, 1);
  assert.equal(created.length, 1);
  assert.equal(emails.length, 1);
  assert.equal(created[0].applied_by_agent, true);
  // numbers and the lesson name come from the deterministic code, verbatim
  assert.match(created[0].body, /37% through "Intro to Pottery"/);
  assert.match(created[0].body, /Centering the clay/);
  assert.match(created[0].link, /\/lessons\/l4$/);
  assert.equal(result.samples[0].percent_complete, 37);
});

test('skips a learner nudged inside the 14 day cooldown', async () => {
  const { deps, created } = baseDeps({
    notifications: [
      { type: 'reminder', applied_by_agent: true, created_at: '2026-11-15T09:00:00.000Z' }
    ]
  });
  const result = await runReengagementAgent({ deps, llm: fakeLlm(), now: NOW });
  assert.equal(result.sent, 0);
  assert.deepEqual(created, []);
});

test('skips finished and never-started courses, and learners not stalled yet', async () => {
  for (const overrides of [{ percent: 100 }, { percent: 0 }, { days: 2 }]) {
    const { deps, created } = baseDeps(overrides);
    const result = await runReengagementAgent({ deps, llm: fakeLlm(), now: NOW });
    assert.equal(result.sent, 0, JSON.stringify(overrides));
    assert.deepEqual(created, []);
  }
});

test('respects the global daily send cap', async () => {
  const { deps, created } = baseDeps({
    learners: [
      { id: 'u1', email: 'a@example.com' },
      { id: 'u2', email: 'b@example.com' },
      { id: 'u3', email: 'c@example.com' }
    ]
  });
  const result = await runReengagementAgent({ deps, llm: fakeLlm(), now: NOW, dailyCap: 2 });
  assert.equal(result.sent, 2);
  assert.equal(created.length, 2);
});

test('a model choice outside the candidate set never sends', async () => {
  const { deps, created } = baseDeps({});
  const llm = fakeLlm({ decide: async () => ({ action: 'nudge', course_id: 'not-a-candidate' }) });
  const result = await runReengagementAgent({ deps, llm, now: NOW });
  assert.equal(result.sent, 0);
  assert.deepEqual(created, []);
});

test('model skip decisions are honoured', async () => {
  const { deps, created } = baseDeps({});
  const llm = fakeLlm({ decide: async () => ({ action: 'skip', course_id: null }) });
  const result = await runReengagementAgent({ deps, llm, now: NOW });
  assert.equal(result.sent, 0);
  assert.deepEqual(created, []);
});

test('model copy with invented numbers or links falls back to the deterministic template', () => {
  const facts = {
    course_title: 'Intro to Pottery',
    percent_complete: 37,
    days_since_last_activity: 19,
    lessons_completed: 3,
    lessons_total: 8,
    next_lesson_title: 'Centering the clay'
  };
  assert.equal(sanitiseDraft({ subject: 'Hi', body: 'You are 92% done!' }, facts).fallback, true);
  assert.equal(
    sanitiseDraft({ subject: 'Hi', body: 'Resume at https://evil.example' }, facts).fallback,
    true
  );
  assert.equal(sanitiseDraft({ subject: 'Hi', body: 'Ready to carry on?' }, facts).fallback, false);
});
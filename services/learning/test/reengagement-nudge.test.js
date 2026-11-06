import test from "node:test";
import assert from "node:assert/strict";

import {
  runReengagementNudgeJob,
  nudgedRecently,
  FLAG_KEY,
  NUDGE_COOLDOWN_DAYS
} from "../src/jobs/reengagementNudge.js";
import { jobs, JOB_NAME } from "../src/jobs/reengagementScheduler.js";

const NOW = new Date("2026-11-20T09:00:00.000Z");

function overviewEntry() {
  return {
    courseId: "c1",
    courseTitle: "Intro to Bookkeeping",
    completedLessons: 4,
    totalLessons: 10,
    percentComplete: 41,
    lastActivityAt: "2026-11-01T10:00:00.000Z",
    nextLesson: { id: "l5", title: "Reconciling the bank feed" }
  };
}

function buildDeps(over = {}) {
  const calls = {
    listEnrolledCourseIds: [],
    listProgressOverview: [],
    completionPercent: [],
    nextLessonFor: [],
    daysSinceLastActivity: [],
    createNotification: [],
    sendEmail: [],
    decide: [],
    draft: []
  };

  const deps = {
    now: () => NOW,
    logger: { info() {}, warn() {}, error() {} },
    learners: [{ id: "u1", email: "learner@example.com" }],
    flagEnabled: async (key) => {
      assert.equal(key, FLAG_KEY);
      return true;
    },
    listEnrolledCourseIds: async (userId) => {
      calls.listEnrolledCourseIds.push(userId);
      return ["c1"];
    },
    listProgressOverview: async (userId) => {
      calls.listProgressOverview.push(userId);
      return [overviewEntry()];
    },
    completionPercent: (entry) => {
      calls.completionPercent.push(entry.courseId);
      return 41;
    },
    nextLessonFor: (entry) => {
      calls.nextLessonFor.push(entry.courseId);
      return { id: "l5", title: "Reconciling the bank feed" };
    },
    daysSinceLastActivity: (entry) => {
      calls.daysSinceLastActivity.push(entry.courseId);
      return 19;
    },
    listNotifications: async () => [],
    createNotification: async (payload) => {
      calls.createNotification.push(payload);
      return { id: "n1", ...payload };
    },
    sendEmail: async (payload) => {
      calls.sendEmail.push(payload);
      return { ok: true };
    },
    // model MOCKED: no network, no AWS call
    agent: {
      async decide(facts) {
        calls.decide.push(facts);
        return { action: "nudge", courseId: "c1", reason: "stalled 19 days mid-course" };
      },
      async draft(facts) {
        calls.draft.push(facts);
        return {
          subject: "Ready to finish {course}?",
          body: "You are {percent} through {course} — 99% of learners restart here at http://spam.example. Next up is {lesson}."
        };
      }
    },
    ...over
  };

  return { deps, calls };
}

test("does nothing while the ga-find_a431764685ac flag is off", async () => {
  let asked = null;
  const { deps, calls } = buildDeps({
    flagEnabled: async (key) => {
      asked = key;
      return false;
    }
  });

  const result = await runReengagementNudgeJob(deps);

  assert.equal(asked, "ga-find_a431764685ac");
  assert.equal(result.enabled, false);
  assert.equal(result.sent, 0);
  assert.deepEqual(calls.listProgressOverview, []);
  assert.deepEqual(calls.createNotification, []);
  assert.deepEqual(calls.sendEmail, []);
  assert.deepEqual(calls.decide, []);
});

test("scheduler job entry is flag gated too", async () => {
  const { deps, calls } = buildDeps({ flagEnabled: async () => false });
  const result = await jobs[JOB_NAME]({ deps });

  assert.equal(result.enabled, false);
  assert.deepEqual(calls.sendEmail, []);
});

test("calls the cited deterministic functions and sends one agent-marked nudge", async () => {
  const { deps, calls } = buildDeps();

  const result = await runReengagementNudgeJob(deps);

  // deterministic code is the source of eligibility, percent and lesson title
  assert.deepEqual(calls.listEnrolledCourseIds, ["u1"]);
  assert.deepEqual(calls.listProgressOverview, ["u1"]);
  assert.deepEqual(calls.completionPercent, ["c1"]);
  assert.deepEqual(calls.nextLessonFor, ["c1"]);
  assert.deepEqual(calls.daysSinceLastActivity, ["c1"]);

  assert.equal(result.sent, 1);
  assert.equal(calls.createNotification.length, 1);
  assert.equal(calls.sendEmail.length, 1);

  const notification = calls.createNotification[0];
  assert.equal(notification.userId, "u1");
  assert.equal(notification.applied_by_agent, true);
  assert.equal(notification.courseId, "c1");
  assert.match(notification.title, /Intro to Bookkeeping/);
  // deterministic percent and lesson title injected, model's digits and URL stripped
  assert.match(notification.body, /41%/);
  assert.match(notification.body, /Reconciling the bank feed/);
  assert.ok(!notification.body.includes("99%"));
  assert.ok(!notification.body.includes("spam.example"));
  assert.match(notification.body, /\/lessons\/l5/);

  const email = calls.sendEmail[0];
  assert.equal(email.applied_by_agent, true);
  assert.equal(email.userId, "u1");
  assert.equal(email.subject, notification.title);
});

test("stays silent for unfinished-but-fresh, zero-progress and completed courses", async () => {
  const fresh = buildDeps({ daysSinceLastActivity: () => 2 });
  assert.equal((await runReengagementNudgeJob(fresh.deps)).sent, 0);
  assert.deepEqual(fresh.calls.decide, []);

  const zero = buildDeps({ completionPercent: () => 0 });
  assert.equal((await runReengagementNudgeJob(zero.deps)).sent, 0);

  const done = buildDeps({ completionPercent: () => 100 });
  assert.equal((await runReengagementNudgeJob(done.deps)).sent, 0);

  const notEnrolled = buildDeps({ listEnrolledCourseIds: async () => [] });
  assert.equal((await runReengagementNudgeJob(notEnrolled.deps)).sent, 0);
});

test("14 day cooldown guardrail blocks a repeat nudge before the model is asked", async () => {
  const { deps, calls } = buildDeps({
    listNotifications: async () => [
      { type: "reengagement", createdAt: "2026-11-15T09:00:00.000Z", applied_by_agent: true }
    ]
  });

  const result = await runReengagementNudgeJob(deps);

  assert.equal(result.sent, 0);
  assert.deepEqual(calls.decide, []);
  assert.deepEqual(calls.createNotification, []);
  assert.deepEqual(calls.sendEmail, []);

  assert.equal(
    nudgedRecently(
      [{ type: "reengagement", createdAt: "2026-10-01T09:00:00.000Z" }],
      NOW,
      NUDGE_COOLDOWN_DAYS
    ),
    false
  );
});

test("global daily send cap bounds total volume", async () => {
  const learners = [
    { id: "u1", email: "a@example.com" },
    { id: "u2", email: "b@example.com" },
    { id: "u3", email: "c@example.com" }
  ];
  const { deps, calls } = buildDeps({ learners, dailyCap: 2 });

  const result = await runReengagementNudgeJob(deps);

  assert.equal(result.sent, 2);
  assert.equal(calls.createNotification.length, 2);
  assert.equal(calls.sendEmail.length, 2);
});

test("a model skip decision sends nothing", async () => {
  const { deps, calls } = buildDeps({
    agent: {
      decide: async () => ({ action: "skip", courseId: null, reason: "resumed" }),
      draft: async () => {
        throw new Error("draft must not be called after a skip");
      }
    }
  });

  const result = await runReengagementNudgeJob(deps);

  assert.equal(result.sent, 0);
  assert.deepEqual(calls.createNotification, []);
  assert.deepEqual(calls.sendEmail, []);
});
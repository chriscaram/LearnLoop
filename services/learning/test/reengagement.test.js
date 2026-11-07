import test from "node:test";
import assert from "node:assert/strict";

import {
  runReengagementNudges,
  resetAgentState,
  FLAG_KEY,
} from "../src/jobs/reengagementNudges.js";
import {
  startReengagementScheduler,
  stopReengagementScheduler,
  jobs,
} from "../src/jobs/scheduler.js";

function makeCalls() {
  return {
    flags: [],
    overview: [],
    enrolments: [],
    percent: [],
    days: [],
    next: [],
    notifications: [],
    emails: [],
    model: [],
  };
}

function makeDeps(calls, overrides = {}) {
  return {
    isFlagEnabled: async (key) => {
      calls.flags.push(key);
      return true;
    },
    listLearners: async () => [{ id: "u1", email: "learner@example.com" }],
    listEnrolledCourseIds: async (userId) => {
      calls.enrolments.push(userId);
      return ["c1"];
    },
    listProgressOverview: async (userId) => {
      calls.overview.push(userId);
      return [
        {
          courseId: "c1",
          courseTitle: "Intro to Bread",
          lastActivityAt: "2026-10-01T00:00:00.000Z",
          completedLessons: 2,
          totalLessons: 5,
        },
      ];
    },
    completionPercent: (...args) => {
      calls.percent.push(args);
      return 40;
    },
    daysSinceLastActivity: (...args) => {
      calls.days.push(args);
      return 11;
    },
    nextLessonFor: (...args) => {
      calls.next.push(args);
      return { id: "l3", title: "Shaping the dough" };
    },
    listNotifications: async () => [],
    createNotification: async (input) => {
      calls.notifications.push(input);
      return { id: "n1" };
    },
    sendEmail: async (input) => {
      calls.emails.push(input);
      return { ok: true };
    },
    decideNudge: async (facts) => {
      calls.model.push(facts);
      return {
        action: "nudge",
        courseId: "c1",
        subject: "Pick up where you left off",
        body: "You were off to a strong start. A short session is enough to keep going.",
      };
    },
    ...overrides,
  };
}

test("flag off: the scheduled trigger does nothing and changes no existing behaviour", async () => {
  resetAgentState();
  const calls = makeCalls();
  const deps = makeDeps(calls, {
    isFlagEnabled: async (key) => {
      calls.flags.push(key);
      return false;
    },
  });

  const direct = await runReengagementNudges({ deps });
  assert.equal(direct.enabled, false);
  assert.equal(direct.nudged, 0);

  startReengagementScheduler({ deps, intervalMs: 60_000 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  stopReengagementScheduler();

  assert.deepEqual(calls.flags, [FLAG_KEY, FLAG_KEY]);
  assert.equal(calls.overview.length, 0);
  assert.equal(calls.notifications.length, 0);
  assert.equal(calls.emails.length, 0);
});

test("flag on: calls the deterministic progress code and sends exactly one nudge", async () => {
  resetAgentState();
  const calls = makeCalls();
  const deps = makeDeps(calls);

  const result = await runReengagementNudges({ deps });

  assert.equal(result.enabled, true);
  assert.equal(result.nudged, 1);
  assert.deepEqual(calls.overview, ["u1"]);
  assert.deepEqual(calls.enrolments, ["u1"]);
  assert.equal(calls.percent.length >= 1, true);
  assert.equal(calls.days.length >= 1, true);
  assert.equal(calls.next.length >= 1, true);
  assert.equal(calls.model.length, 1);
  assert.equal(calls.model[0].candidates.length, 1);

  assert.equal(calls.notifications.length, 1);
  const notification = calls.notifications[0];
  assert.equal(notification.applied_by_agent, true);
  assert.equal(notification.userId, "u1");
  assert.match(notification.body, /40%/);
  assert.match(notification.body, /Shaping the dough/);
  assert.match(notification.body, /Intro to Bread/);

  assert.equal(calls.emails.length, 1);
  assert.equal(calls.emails[0].to, "learner@example.com");
  assert.equal(calls.emails[0].applied_by_agent, true);
});

test("guardrail: at most one nudge per learner per 14 days", async () => {
  resetAgentState();
  const calls = makeCalls();
  const deps = makeDeps(calls);

  const first = await runReengagementNudges({ deps });
  const second = await runReengagementNudges({ deps });

  assert.equal(first.nudged, 1);
  assert.equal(second.nudged, 0);
  assert.equal(calls.notifications.length, 1);
  assert.deepEqual(second.skipped, [{ learnerId: "u1", reason: "nudged_recently" }]);
});

test("guardrails: daily cap, stall threshold and finished courses block sending", async () => {
  resetAgentState();
  const capped = makeCalls();
  const cappedResult = await runReengagementNudges({
    deps: makeDeps(capped),
    config: { dailySendCap: 0 },
  });
  assert.equal(cappedResult.nudged, 0);
  assert.equal(capped.notifications.length, 0);

  resetAgentState();
  const fresh = makeCalls();
  const freshResult = await runReengagementNudges({
    deps: makeDeps(fresh, { daysSinceLastActivity: () => 1 }),
  });
  assert.equal(freshResult.nudged, 0);
  assert.equal(fresh.notifications.length, 0);

  resetAgentState();
  const done = makeCalls();
  const doneResult = await runReengagementNudges({
    deps: makeDeps(done, { completionPercent: () => 100 }),
  });
  assert.equal(doneResult.nudged, 0);
  assert.equal(done.notifications.length, 0);
});

test("the model cannot supply numbers, links or an ineligible course", async () => {
  resetAgentState();
  const calls = makeCalls();
  const deps = makeDeps(calls, {
    decideNudge: async () => ({
      action: "nudge",
      courseId: "c1",
      subject: "You are 99% done!",
      body: "Only 2 lessons left, see http://evil.example.com/claim",
    }),
  });

  const result = await runReengagementNudges({ deps });
  assert.equal(result.nudged, 1);
  const body = calls.notifications[0].body;
  assert.equal(body.includes("99%"), false);
  assert.equal(body.includes("evil.example.com"), false);
  assert.match(body, /40%/);
  assert.match(body, /\/lessons\/l3/);
  assert.equal(calls.notifications[0].title.includes("99"), false);

  resetAgentState();
  const other = makeCalls();
  const otherResult = await runReengagementNudges({
    deps: makeDeps(other, {
      decideNudge: async () => ({ action: "nudge", courseId: "c-not-enrolled", subject: "x", body: "y" }),
    }),
  });
  assert.equal(otherResult.nudged, 0);
  assert.equal(other.notifications.length, 0);
});

test("the scheduled job entry is registered under its job name", async () => {
  resetAgentState();
  const calls = makeCalls();
  const result = await jobs["reengagement-nudges"]({ payload: { deps: makeDeps(calls) } });
  assert.equal(result.flag, FLAG_KEY);
  assert.equal(result.nudged, 1);
});
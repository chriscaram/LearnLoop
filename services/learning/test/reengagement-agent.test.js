import test from "node:test";
import assert from "node:assert/strict";

import {
  runStalledLearnerNudgeAgent,
  resetAgentRuntimeState
} from "../src/agents/reengagementAgent.js";
import {
  stalledLearnerNudgeJob,
  maybeRunScheduledNudges,
  resetSchedulerState
} from "../src/agents/trigger.js";

const NOW = "2026-11-10T09:05:00.000Z";

function makeModel() {
  const calls = [];
  let turn = 0;
  return {
    calls,
    invoke: async (messages) => {
      calls.push(messages);
      turn += 1;
      if (turn % 2 === 1) {
        return { content: JSON.stringify({ action: "nudge", courseId: "c1", reason: "stalled" }) };
      }
      return {
        content: JSON.stringify({
          subject: "Pick up where you left off",
          body: "Your course is waiting. The next lesson is short and picks up right where you stopped."
        })
      };
    }
  };
}

function makeDeps(overrides = {}) {
  const calls = {
    listEnrolledCourseIds: [],
    listProgressOverview: [],
    completionPercent: [],
    daysSinceLastActivity: [],
    nextLessonFor: [],
    createNotification: [],
    sendEmail: []
  };
  const deps = {
    listLearners: async () => [{ id: "u1", name: "Lee", email: "lee@example.com" }],
    listEnrolledCourseIds: async (userId) => {
      calls.listEnrolledCourseIds.push(userId);
      return ["c1"];
    },
    listProgressOverview: async (userId) => {
      calls.listProgressOverview.push(userId);
      return [
        {
          courseId: "c1",
          courseTitle: "Intro to Bread",
          lastActivityAt: "2026-10-28T10:00:00.000Z",
          lessons: [{ id: "l4" }, { id: "l5" }],
          completedLessonIds: ["l4"]
        }
      ];
    },
    completionPercent: (...args) => {
      calls.completionPercent.push(args);
      return 40;
    },
    daysSinceLastActivity: (...args) => {
      calls.daysSinceLastActivity.push(args);
      return 13;
    },
    nextLessonFor: (...args) => {
      calls.nextLessonFor.push(args);
      return { id: "l5", title: "Shaping the dough" };
    },
    listNotifications: async () => [],
    createNotification: async (record) => {
      calls.createNotification.push(record);
      return { id: "n1", ...record };
    },
    sendEmail: async (payload) => {
      calls.sendEmail.push(payload);
      return { ok: true };
    },
    ...overrides
  };
  return { deps, calls };
}

test("trigger does nothing while the feature flag is off", async () => {
  resetAgentRuntimeState();
  const { deps, calls } = makeDeps();
  const model = makeModel();

  const result = await stalledLearnerNudgeJob({
    flagEnabled: false,
    now: NOW,
    deps,
    model,
    log: () => {}
  });

  assert.equal(result.enabled, false);
  assert.equal(result.sent, 0);
  assert.equal(calls.listProgressOverview.length, 0);
  assert.equal(calls.createNotification.length, 0);
  assert.equal(calls.sendEmail.length, 0);
  assert.equal(model.calls.length, 0);
});

test("an absent flag value is treated as off", async () => {
  resetAgentRuntimeState();
  const { deps, calls } = makeDeps();

  const result = await runStalledLearnerNudgeAgent({
    isFlagEnabled: async () => undefined,
    now: NOW,
    deps,
    model: makeModel(),
    log: () => {}
  });

  assert.equal(result.enabled, false);
  assert.equal(calls.createNotification.length, 0);
});

test("with the flag on it uses the deterministic functions and sends one marked nudge", async () => {
  resetAgentRuntimeState();
  const { deps, calls } = makeDeps();
  const model = makeModel();

  const result = await runStalledLearnerNudgeAgent({
    flagEnabled: true,
    now: NOW,
    deps,
    model,
    log: () => {}
  });

  assert.equal(result.enabled, true);
  assert.equal(result.sent, 1);
  assert.equal(calls.listEnrolledCourseIds.length, 1);
  assert.equal(calls.listProgressOverview.length, 1);
  assert.ok(calls.completionPercent.length >= 1);
  assert.ok(calls.daysSinceLastActivity.length >= 1);
  assert.ok(calls.nextLessonFor.length >= 1);

  assert.equal(calls.createNotification.length, 1);
  const notification = calls.createNotification[0];
  assert.equal(notification.applied_by_agent, true);
  assert.equal(notification.userId, "u1");
  // percent and lesson title come from the deterministic code, never the model
  assert.match(notification.body, /40% complete/);
  assert.match(notification.body, /Shaping the dough/);
  assert.match(notification.link, /\/lessons\/l5$/);

  assert.equal(calls.sendEmail.length, 1);
  assert.equal(calls.sendEmail[0].to, "lee@example.com");
});

test("skips learners who are not stalled, finished or have no progress", async () => {
  resetAgentRuntimeState();
  const { deps, calls } = makeDeps({
    daysSinceLastActivity: () => 2
  });

  const result = await runStalledLearnerNudgeAgent({
    flagEnabled: true,
    now: NOW,
    deps,
    model: makeModel(),
    log: () => {}
  });

  assert.equal(result.sent, 0);
  assert.equal(calls.createNotification.length, 0);
});

test("respects the 14 day per-learner cooldown guardrail", async () => {
  resetAgentRuntimeState();
  const { deps, calls } = makeDeps({
    listNotifications: async () => [
      { applied_by_agent: true, createdAt: "2026-11-08T09:00:00.000Z" }
    ]
  });

  const result = await runStalledLearnerNudgeAgent({
    flagEnabled: true,
    now: NOW,
    deps,
    model: makeModel(),
    log: () => {}
  });

  assert.equal(result.sent, 0);
  assert.equal(result.skipped, 1);
  assert.equal(calls.createNotification.length, 0);
});

test("respects the global daily send cap", async () => {
  resetAgentRuntimeState();
  const { deps, calls } = makeDeps({
    listLearners: async () => [
      { id: "u1", email: "a@example.com" },
      { id: "u2", email: "b@example.com" }
    ]
  });

  const result = await runStalledLearnerNudgeAgent({
    flagEnabled: true,
    now: NOW,
    deps,
    model: makeModel(),
    dailyCap: 1,
    log: () => {}
  });

  assert.equal(result.sent, 1);
  assert.equal(result.capped, 1);
  assert.equal(calls.createNotification.length, 1);
});

test("the daily scheduler runs once in the 09:00 UTC window", async () => {
  resetSchedulerState();
  let runs = 0;
  const run = async () => {
    runs += 1;
    return { sent: 0 };
  };

  const outside = await maybeRunScheduledNudges({ now: "2026-11-10T03:00:00.000Z", run });
  assert.equal(outside.ran, false);
  assert.equal(runs, 0);

  const first = await maybeRunScheduledNudges({ now: NOW, run });
  assert.equal(first.ran, true);
  const second = await maybeRunScheduledNudges({ now: "2026-11-10T09:40:00.000Z", run });
  assert.equal(second.ran, false);
  assert.equal(runs, 1);
});
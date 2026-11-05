import test from "node:test";
import assert from "node:assert/strict";

import { runReengagementNudges, FLAG_KEY } from "../src/agents/reengagement.js";
import { reengagementJobs, startReengagementScheduler } from "../src/agents/trigger.js";

function fakeModel(responses) {
  const calls = [];
  return {
    calls,
    invoke: async (messages) => {
      calls.push(messages);
      const next = responses.shift() ?? {};
      return { content: JSON.stringify(next) };
    }
  };
}

function makeDeps(overrides = {}) {
  const calls = {
    listEnrolledCourseIds: 0,
    listProgressOverview: 0,
    completionPercent: 0,
    daysSinceLastActivity: 0,
    nextLessonFor: 0,
    notifications: [],
    emails: []
  };
  const deps = {
    readFlag: async () => true,
    listLearners: async () => [{ id: "u1", email: "learner@example.com", firstName: "Ada" }],
    listEnrolledCourseIds: async () => {
      calls.listEnrolledCourseIds += 1;
      return ["c1"];
    },
    listProgressOverview: async () => {
      calls.listProgressOverview += 1;
      return [
        {
          courseId: "c1",
          courseTitle: "Intro to Bread",
          lastActivityAt: "2026-10-01T00:00:00.000Z",
          percent: 40
        }
      ];
    },
    completionPercent: async () => {
      calls.completionPercent += 1;
      return 42;
    },
    daysSinceLastActivity: async () => {
      calls.daysSinceLastActivity += 1;
      return 21;
    },
    nextLessonFor: async () => {
      calls.nextLessonFor += 1;
      return { id: "l7", title: "Shaping the dough" };
    },
    listNotifications: async () => [],
    createNotification: async (payload) => {
      calls.notifications.push(payload);
      return payload;
    },
    sendEmail: async (payload) => {
      calls.emails.push(payload);
      return { ok: true };
    },
    ...overrides
  };
  return { deps, calls };
}

test("does nothing while the ga-find_a431764685ac flag is off", async () => {
  const { deps, calls } = makeDeps({ readFlag: async () => false });
  const model = fakeModel([]);

  const result = await runReengagementNudges({ deps, model });

  assert.equal(FLAG_KEY, "ga-find_a431764685ac");
  assert.equal(result.enabled, false);
  assert.equal(result.sent, 0);
  assert.equal(model.calls.length, 0);
  assert.equal(calls.listProgressOverview, 0);
  assert.equal(calls.notifications.length, 0);
  assert.equal(calls.emails.length, 0);
});

test("scheduler tick is a no-op while the flag is off", async () => {
  const { deps, calls } = makeDeps({ readFlag: async () => false });
  const scheduler = startReengagementScheduler({
    deps,
    model: fakeModel([]),
    now: () => new Date("2026-11-10T09:05:00.000Z")
  });
  await scheduler.tick();
  scheduler.stop();
  assert.equal(calls.notifications.length, 0);
});

test("calls the deterministic progress functions and sends one nudge", async () => {
  const { deps, calls } = makeDeps();
  const model = fakeModel([
    { action: "nudge", courseId: "c1", reason: "stalled near the end" },
    { subject: "Ready for the next step?", body: "You were doing great - keep the streak going!" }
  ]);

  const result = await runReengagementNudges({ deps, model, now: "2026-11-10T09:00:00.000Z" });

  assert.equal(result.enabled, true);
  assert.equal(result.sent, 1);
  assert.equal(calls.listEnrolledCourseIds, 1);
  assert.equal(calls.listProgressOverview, 1);
  assert.equal(calls.completionPercent, 1);
  assert.equal(calls.daysSinceLastActivity, 1);
  assert.equal(calls.nextLessonFor, 1);
  assert.equal(calls.notifications.length, 1);
  assert.equal(calls.emails.length, 1);

  const notification = calls.notifications[0];
  assert.equal(notification.applied_by_agent, true);
  assert.equal(notification.metadata.applied_by_agent, true);
  assert.equal(notification.metadata.courseId, "c1");
  // deterministic percent + lesson title + link, never model-authored
  assert.match(notification.body, /42% through "Intro to Bread"/);
  assert.match(notification.body, /Next up: "Shaping the dough"/);
  assert.match(notification.body, /\/courses\/c1\/lessons\/l7/);
});

test("strips numbers and links the model tries to author", async () => {
  const { deps, calls } = makeDeps();
  const model = fakeModel([
    { action: "nudge", courseId: "c1" },
    { subject: "You are 99% done!", body: "Go to https://evil.example/now - only 3 lessons left" }
  ]);

  await runReengagementNudges({ deps, model });

  const notification = calls.notifications[0];
  assert.equal(notification.subject.includes("99"), false);
  assert.equal(notification.body.includes("https://evil.example/now"), false);
  assert.match(notification.body, /42% through/);
});

test("respects the 14 day per-learner cooldown guardrail", async () => {
  const { deps, calls } = makeDeps({
    listNotifications: async () => [
      { applied_by_agent: true, createdAt: "2026-11-05T09:00:00.000Z", metadata: { agent: "reengagement-nudges" } }
    ]
  });
  const model = fakeModel([]);

  const result = await runReengagementNudges({ deps, model, now: "2026-11-10T09:00:00.000Z" });

  assert.equal(result.sent, 0);
  assert.equal(result.skipped, 1);
  assert.equal(model.calls.length, 0);
  assert.equal(calls.notifications.length, 0);
});

test("skips finished and zero-progress courses", async () => {
  const { deps, calls } = makeDeps({ completionPercent: async () => 100 });
  const model = fakeModel([]);

  const result = await runReengagementNudges({ deps, model });

  assert.equal(result.sent, 0);
  assert.equal(calls.notifications.length, 0);
});

test("honours the global daily send cap", async () => {
  const { deps, calls } = makeDeps({
    listLearners: async () => [{ id: "u1" }, { id: "u2" }, { id: "u3" }]
  });
  const model = {
    invoke: async (messages) => {
      const isDecision = JSON.stringify(messages).includes("nudge\\\"|\\\"skip");
      return {
        content: isDecision
          ? JSON.stringify({ action: "nudge", courseId: "c1" })
          : JSON.stringify({ subject: "Keep going", body: "Nice work so far." })
      };
    }
  };

  const result = await runReengagementNudges({ deps, model, dailyCap: 1 });

  assert.equal(result.sent, 1);
  assert.equal(calls.notifications.length, 1);
});

test("jobs map entry is wired for the handler jobs pattern", async () => {
  assert.equal(typeof reengagementJobs["reengagement-nudges"], "function");
});

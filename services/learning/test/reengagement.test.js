import test from "node:test";
import assert from "node:assert/strict";

import { sendReengagementNudges } from "../src/jobs/reengagement.js";
import {
  FLAG_KEY,
  runReengagementAgent,
  nudgedRecently,
  isEligibleCourse,
  sanitizeCopy,
  factLine
} from "../src/agents/reengagementAgent.js";

const NOW = new Date("2026-11-20T09:00:00.000Z");

function fakeModel(decision = { action: "nudge", course_id: "c1", reason: "stalled" }) {
  const calls = [];
  return {
    calls,
    async invoke(messages) {
      calls.push(messages);
      const body = calls.length === 1 ? decision : { subject: "Keep going", body: "Nice start." };
      return { content: JSON.stringify(body) };
    }
  };
}

function deterministicStub(recorder, overrides = {}) {
  return {
    listEnrolledCourseIds: async (userId) => {
      recorder.push(["listEnrolledCourseIds", userId]);
      return ["c1"];
    },
    listProgressOverview: async (userId) => {
      recorder.push(["listProgressOverview", userId]);
      return [
        {
          courseId: "c1",
          courseTitle: "Intro to Node",
          completedLessons: 3,
          totalLessons: 10,
          lastActivityAt: "2026-11-01T09:00:00.000Z"
        }
      ];
    },
    completionPercent: async () => {
      recorder.push(["completionPercent"]);
      return 42;
    },
    daysSinceLastActivity: async () => {
      recorder.push(["daysSinceLastActivity"]);
      return 19;
    },
    nextLessonFor: async () => {
      recorder.push(["nextLessonFor"]);
      return { id: "l7", title: "Streams in depth" };
    },
    ...overrides
  };
}

test("job does nothing while the ga-find_a431764685ac flag is off", async () => {
  let created = 0;
  const result = await sendReengagementNudges({
    flagEnabled: async (key) => {
      assert.equal(key, FLAG_KEY);
      return false;
    },
    learners: [{ userId: "u1", email: "a@example.com" }],
    createNotification: async () => {
      created += 1;
    },
    sendEmail: async () => {
      created += 1;
    }
  });

  assert.equal(result.enabled, false);
  assert.equal(result.sent, 0);
  assert.equal(created, 0);
});

test("agent calls the cited deterministic functions and sends one nudge", async () => {
  const recorder = [];
  const notifications = [];
  const emails = [];
  const model = fakeModel();

  const result = await runReengagementAgent({
    learners: [{ userId: "u1", email: "learner@example.com" }],
    now: NOW,
    flagEnabled: async () => true,
    deterministic: deterministicStub(recorder),
    listRecentNotifications: async () => [],
    createNotification: async (payload) => notifications.push(payload),
    sendEmail: async (payload) => emails.push(payload),
    modelFactory: async () => model,
    baseUrl: "https://app.example.com"
  });

  const called = recorder.map((entry) => entry[0]);
  assert.ok(called.includes("listEnrolledCourseIds"));
  assert.ok(called.includes("listProgressOverview"));
  assert.ok(called.includes("completionPercent"));
  assert.ok(called.includes("daysSinceLastActivity"));
  assert.ok(called.includes("nextLessonFor"));

  assert.equal(result.sent, 1);
  assert.equal(notifications.length, 1);
  assert.equal(emails.length, 1);
  assert.equal(notifications[0].applied_by_agent, true);
  assert.equal(emails[0].applied_by_agent, true);
  // numbers, lesson title and link come from deterministic code only
  assert.match(notifications[0].body, /42% through "Intro to Node"/);
  assert.match(notifications[0].body, /"Streams in depth"/);
  assert.match(notifications[0].body, /https:\/\/app\.example\.com\/lessons\/l7/);
  assert.equal(result.samples.length, 1);
});

test("guardrail: no second nudge inside 14 days", async () => {
  const notifications = [];
  const result = await runReengagementAgent({
    learners: [{ userId: "u1", email: "learner@example.com" }],
    now: NOW,
    flagEnabled: async () => true,
    deterministic: deterministicStub([]),
    listRecentNotifications: async () => [
      {
        type: "reengagement",
        applied_by_agent: true,
        created_at: "2026-11-14T09:00:00.000Z"
      }
    ],
    createNotification: async (p) => notifications.push(p),
    sendEmail: async () => {},
    modelFactory: async () => fakeModel()
  });

  assert.equal(result.sent, 0);
  assert.equal(result.skipped, 1);
  assert.equal(notifications.length, 0);
  assert.equal(nudgedRecently([{ type: "reengagement", created_at: "2026-10-01T00:00:00.000Z" }], NOW), false);
});

test("guardrail: global daily send cap bounds volume", async () => {
  const sent = [];
  const result = await runReengagementAgent({
    learners: [
      { userId: "u1", email: "a@example.com" },
      { userId: "u2", email: "b@example.com" },
      { userId: "u3", email: "c@example.com" }
    ],
    now: NOW,
    dailyCap: 2,
    flagEnabled: async () => true,
    deterministic: deterministicStub([]),
    listRecentNotifications: async () => [],
    createNotification: async (p) => sent.push(p),
    sendEmail: async () => {},
    modelFactory: async () => fakeModel()
  });

  assert.equal(result.sent, 2);
  assert.equal(sent.length, 2);
});

test("guardrail: zero progress and finished courses are never eligible", () => {
  const base = {
    courseId: "c1",
    percentComplete: 40,
    completedLessons: 2,
    nextLessonTitle: "Next",
    daysSinceLastActivity: 10
  };
  assert.equal(isEligibleCourse(base), true);
  assert.equal(isEligibleCourse({ ...base, percentComplete: 0, completedLessons: 0 }), false);
  assert.equal(isEligibleCourse({ ...base, percentComplete: 100 }), false);
  assert.equal(isEligibleCourse({ ...base, nextLessonTitle: null }), false);
});

test("model copy containing numbers or links falls back to the safe template", () => {
  assert.equal(sanitizeCopy("You are 73% done, see https://x.test", "SAFE", 100), "SAFE");
  assert.equal(sanitizeCopy("  Lovely to see you back.  ", "SAFE", 100), "Lovely to see you back.");
  assert.match(
    factLine(
      {
        percentComplete: 42,
        courseTitle: "Intro",
        nextLessonTitle: "Lesson A",
        nextLessonId: "l1"
      },
      "https://app.example.com/"
    ),
    /42% through "Intro".*"Lesson A".*\/lessons\/l1/
  );
});
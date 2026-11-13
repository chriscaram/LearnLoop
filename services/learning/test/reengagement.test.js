import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IDS, fixtureData, setupTestEnvironment } from '@learnloop/shared/testing';
import {
  DAILY_SEND_CAP, MIN_STALL_DAYS, REENGAGEMENT_FLAG, REENGAGEMENT_JOB,
  eligibleCourses, recentlyNudged, runReengagementNudges,
} from '../src/jobs/reengagement.js';
import { FALLBACK_BODY, parseJsonObject, sanitiseDraft, textOf } from '../src/agents/reengagement.js';
import { handler } from '../src/handler.js';

const NOW = new Date('2026-11-03T12:00:00Z'); // 29 days after the fixture's last activity

/** Stand-in for the Bedrock model: no network, no AWS call. */
function fakeAgent({ nudge = true, courseId = IDS.cloud, subject = 'Your next lesson is waiting', body = 'You are 92% through the course — see https://spam.test for more.' } = {}) {
  const calls = { decide: [], draft: [] };
  return {
    calls,
    async decide(facts) {
      calls.decide.push(facts);
      return { nudge, courseId };
    },
    async draft(facts) {
      calls.draft.push(facts);
      return sanitiseDraft({ subject, body });
    },
  };
}

const agentNotifications = async (env) => (await env.store.read('notifications')).filter((n) => n.applied_by_agent === true);

let env;
beforeEach(() => { env = setupTestEnvironment({ data: fixtureData(), flags: { [REENGAGEMENT_FLAG]: { enabled: true } } }); });

test('the job is registered on the learning handler', async () => {
  const listed = await handler({ listJobs: true });
  env.logs.restore();
  assert.ok(listed.jobs.includes(REENGAGEMENT_JOB));
  assert.equal(REENGAGEMENT_FLAG, 'ga-find_a431764685ac');
});

test('flag off: the trigger does nothing and existing behaviour is unchanged', async () => {
  env = setupTestEnvironment({ data: fixtureData() }); // no flags at all
  const result = await runReengagementNudges(NOW, { agent: fakeAgent() });
  const viaHandler = await handler({ job: REENGAGEMENT_JOB });
  env.logs.restore();
  assert.deepEqual(result, { enabled: false, considered: 0, sent: 0 });
  assert.deepEqual(viaHandler, { ok: true });
  assert.equal((await env.store.read('notifications')).length, 2);
  assert.equal(env.ses.sent.length, 0);
});

test('flag on: nudges the stalled learner with deterministic facts only', async () => {
  const agent = fakeAgent();
  const result = await runReengagementNudges(NOW, { agent });
  env.logs.restore();

  assert.equal(result.sent, 1);

  // The decision saw only facts the existing deterministic code computed:
  // daysSinceLastActivity, listProgressOverview (completionPercent) and nextLessonFor.
  assert.equal(agent.calls.decide.length, 1);
  assert.equal(agent.calls.decide[0].daysSinceLastActivity, 29);
  assert.deepEqual(agent.calls.decide[0].courses.map((c) => c.courseId), [IDS.cloud]);
  assert.equal(agent.calls.decide[0].courses[0].percent, 17);
  assert.equal(agent.calls.decide[0].courses[0].nextLessonTitle, 'Two');

  const [nudge] = await agentNotifications(env);
  assert.ok(nudge, 'a notification was created');
  assert.equal(nudge.user_id, IDS.learner);
  assert.equal(nudge.type, 'staff_message');
  assert.equal(nudge.link, `/lessons/${IDS.lesson2}`);
  assert.match(nudge.body, /17% through "Cloud Foundations"/);
  assert.match(nudge.body, /next lesson is "Two"/);
  // The model may not supply a number or a link.
  assert.ok(!nudge.body.includes('92'));
  assert.ok(!nudge.body.includes('spam.test'));

  // Email went out through the existing SES path, same subject as the inbox item.
  assert.equal(env.ses.sent.length, 1);
  assert.equal(env.ses.sent[0].Message.Subject.Data, nudge.title);
  assert.deepEqual(env.ses.sent[0].Destination.ToAddresses, ['lee.learner@example.com']);

  // Learners without an enrolment or progress are never contacted.
  assert.equal((await env.store.read('notifications')).filter((n) => n.user_id === IDS.learnerNoSub).length, 0);
});

test('guardrail: one message per learner per 14 days', async () => {
  await runReengagementNudges(NOW, { agent: fakeAgent() });
  const again = await runReengagementNudges(new Date('2026-11-10T09:00:00Z'), { agent: fakeAgent() });
  env.logs.restore();
  assert.equal(again.sent, 0);
  assert.equal((await agentNotifications(env)).length, 1);
  assert.equal(env.ses.sent.length, 1);
});

test('guardrail: learners who are not stalled yet are left alone', async () => {
  const result = await runReengagementNudges(new Date('2026-10-07T09:00:00Z'), { agent: fakeAgent() });
  env.logs.restore();
  assert.equal(result.sent, 0);
  assert.equal(env.ses.sent.length, 0);
  assert.equal(MIN_STALL_DAYS, 7);
});

test('guardrail: the agent deciding to stay silent, and the daily cap', async () => {
  const silent = await runReengagementNudges(NOW, { agent: fakeAgent({ nudge: false }) });
  const unknownCourse = await runReengagementNudges(NOW, { agent: fakeAgent({ courseId: 'crs_ffffffffffff' }) });
  const capped = await runReengagementNudges(NOW, { agent: fakeAgent(), cap: 0 });
  env.logs.restore();
  assert.equal(silent.sent, 0);
  assert.equal(unknownCourse.sent, 0, 'a course the deterministic code did not offer is rejected');
  assert.equal(capped.sent, 0);
  assert.equal(env.ses.sent.length, 0);
  assert.equal(DAILY_SEND_CAP, 50);
});

test('eligibleCourses and recentlyNudged', () => {
  const overview = [
    { courseId: 'a', percent: 40, completedLessons: 2, totalLessons: 5, nextLesson: { id: 'l', title: 'L' } },
    { courseId: 'b', percent: 100, completedLessons: 5, totalLessons: 5, nextLesson: null },
    { courseId: 'c', percent: 0, completedLessons: 0, totalLessons: 4, nextLesson: { id: 'l', title: 'L' } },
    { courseId: 'd', percent: 50, completedLessons: 1, totalLessons: 2, nextLesson: { id: 'l', title: 'L' } },
  ];
  assert.deepEqual(eligibleCourses(overview, ['a', 'b', 'c']).map((c) => c.courseId), ['a']);
  assert.equal(recentlyNudged([{ applied_by_agent: true, created_at: '2026-11-01T00:00:00.000Z' }], NOW), true);
  assert.equal(recentlyNudged([{ applied_by_agent: true, created_at: '2026-10-01T00:00:00.000Z' }], NOW), false);
  assert.equal(recentlyNudged([{ created_at: '2026-11-01T00:00:00.000Z' }], NOW), false);
});

test('model output is sanitised and parsed defensively', () => {
  const clean = sanitiseDraft({ subject: 'You are 3 lessons from the end!', body: 'Only 15% left — open https://x.test/go now.' });
  assert.ok(!/\d/.test(clean.subject));
  assert.ok(!/\d/.test(clean.body));
  assert.ok(!clean.body.includes('x.test'));
  assert.equal(sanitiseDraft({ subject: '', body: '12%' }).body, FALLBACK_BODY);
  assert.deepEqual(parseJsonObject('noise {"nudge": true} tail'), { nudge: true });
  assert.equal(parseJsonObject('not json'), null);
  assert.equal(textOf({ content: [{ text: 'a' }, { text: 'b' }] }), 'ab');
});
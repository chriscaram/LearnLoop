import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IDS, fixtureData, setupTestEnvironment } from '@learnloop/shared/testing';
import { resetFlagCache } from '@learnloop/shared/flags';
import { listNotifications } from '@learnloop/notifications/services/inbox';
import {
  AGENT_FLAG_KEY, DAILY_SEND_CAP, MIN_STALL_DAYS, REENGAGEMENT_NUDGE_JOB,
  composeMessage, courseFact, eligibleCourses, runReengagementNudges, sanitizeModelText,
} from '../src/jobs/reengagement.js';
import { listProgressOverview } from '../src/services/progress.js';
import { handler } from '../src/handler.js';

let env;
beforeEach(() => { env = setupTestEnvironment({ data: fixtureData(), flags: { [AGENT_FLAG_KEY]: { enabled: true } } }); });

const NOW = new Date('2026-11-03T12:00:00Z');

function setFlagEnabled(enabled) {
  env.ssm.params.set('/learnloop/prod/feature-flags', JSON.stringify(enabled ? { [AGENT_FLAG_KEY]: { enabled: true } } : {}));
  resetFlagCache();
}

/** The model is never called: a fake planner records the facts it was given. */
function fakeAgent(reply) {
  return {
    seen: [],
    async planNudge(facts) {
      this.seen.push(facts);
      return typeof reply === 'function' ? reply(facts) : reply;
    },
  };
}

const nudgeReply = (facts) => ({
  action: 'nudge',
  courseId: facts.courses[0].courseId,
  subject: 'Ready for lesson 99%?',
  body: 'Nice work so far - you are 95% done, see http://spam.example/promo for more.',
});

test('the job does nothing while the flag is off', async () => {
  setFlagEnabled(false);
  const agent = fakeAgent(nudgeReply);
  const result = await runReengagementNudges(NOW, { agent });
  env.logs.restore();
  assert.deepEqual(result, { sent: 0, considered: 0, reason: 'flag_off' });
  assert.equal(agent.seen.length, 0, 'the model is never consulted');
  assert.equal((await listNotifications(IDS.learner)).length, 2, 'no notification created');
  assert.equal(env.ses.sent.length, 0, 'no email sent');
});

test('the scheduled job entry point is wired and inert while the flag is off', async () => {
  setFlagEnabled(false);
  const out = await handler({ job: REENGAGEMENT_NUDGE_JOB }, { awsRequestId: 'req-job-0001' });
  env.logs.restore();
  assert.deepEqual(out, { ok: true });
  assert.equal((await listNotifications(IDS.learner)).length, 2);
});

test('with the flag on, the nudge is built from the deterministic progress functions', async () => {
  const agent = fakeAgent(nudgeReply);
  const result = await runReengagementNudges(NOW, { agent });

  // Facts handed to the model come from listProgressOverview / completionPercent /
  // nextLessonFor / daysSinceLastActivity - the model computes nothing.
  assert.equal(agent.seen.length, 1, 'only the stalled, enrolled learner is considered');
  const facts = agent.seen[0];
  assert.equal(facts.daysSinceLastActivity, 29);
  assert.deepEqual(facts.courses.map((c) => c.courseId), [IDS.cloud]);
  assert.equal(facts.courses[0].percent, 17);
  assert.equal(facts.courses[0].completedLessons, 1);
  assert.equal(facts.courses[0].totalLessons, 3);
  assert.equal(facts.courses[0].nextLessonTitle, 'Two');

  const overview = await listProgressOverview(IDS.learner);
  assert.equal(facts.courses[0].percent, overview[0].percent, 'percent comes from completionPercent');

  assert.deepEqual(result, { sent: 1, considered: 1 });
  const items = await listNotifications(IDS.learner);
  const nudge = items.find((n) => n.applied_by_agent);
  assert.ok(nudge, 'the notification is marked applied_by_agent');
  assert.equal(nudge.type, 'staff_message');
  assert.equal(nudge.link, `/lessons/${IDS.lesson2}`);
  assert.match(nudge.body, /17% through Cloud Foundations \(1 of 3 lessons\)\. Next up: Two\./);
  assert.ok(!nudge.body.includes('95'), 'model numbers are stripped');
  assert.ok(!nudge.body.includes('http'), 'model links are stripped');
  assert.ok(!nudge.title.includes('99'));

  assert.equal(env.ses.sent.length, 1, 'one email through the existing sendEmail path');
  env.logs.restore();
  assert.equal(env.logs.events('staff_message_sent').length, 1);
  assert.equal((await listNotifications(IDS.learnerNoSub)).length, 0, 'learners without an enrolment are never nudged');
});

test('guardrail: at most one agent message per learner per 14 days', async () => {
  const agent = fakeAgent(nudgeReply);
  assert.deepEqual(await runReengagementNudges(NOW, { agent }), { sent: 1, considered: 1 });
  const soon = new Date('2026-11-06T12:00:00Z');
  assert.deepEqual(await runReengagementNudges(soon, { agent }), { sent: 0, considered: 0 });
  const later = new Date('2026-11-19T12:00:00Z');
  assert.deepEqual(await runReengagementNudges(later, { agent }), { sent: 1, considered: 1 });
  env.logs.restore();
  assert.equal((await listNotifications(IDS.learner)).filter((n) => n.applied_by_agent).length, 2);
});

test('guardrail: a skip decision and an unknown course id send nothing', async () => {
  assert.deepEqual(await runReengagementNudges(NOW, { agent: fakeAgent({ action: 'skip' }) }), { sent: 0, considered: 1 });
  assert.deepEqual(
    await runReengagementNudges(NOW, { agent: fakeAgent({ action: 'nudge', courseId: 'crs_ffffffffffff', subject: 'x', body: 'y' }) }),
    { sent: 0, considered: 1 },
  );
  assert.deepEqual(
    await runReengagementNudges(NOW, { agent: { async planNudge() { throw Object.assign(new Error('boom'), { name: 'ThrottlingException' }); } } }),
    { sent: 0, considered: 1 },
  );
  env.logs.restore();
  assert.equal((await listNotifications(IDS.learner)).filter((n) => n.applied_by_agent).length, 0);
  assert.equal(env.ses.sent.length, 0);
});

test('eligibility, sanitising and composition are deterministic', async () => {
  const overview = await listProgressOverview(IDS.learner);
  env.logs.restore();
  assert.equal(eligibleCourses(overview).length, 1);
  assert.equal(eligibleCourses([{ ...overview[0], lastLesson: null }]).length, 0, 'zero progress is never nudged');
  assert.equal(eligibleCourses([{ ...overview[0], nextLesson: null }]).length, 0, 'finished courses are never nudged');
  assert.equal(sanitizeModelText('Only 42% left at https://x.test now', 200), 'Only left at now');
  const fact = courseFact(overview[0]);
  assert.equal(fact.lessonsRemaining, 2);
  const message = composeMessage(overview[0], { subject: '  ', body: '' });
  assert.equal(message.title, 'Pick up Cloud Foundations where you left off');
  assert.match(message.body, /^You are 17% through/);
  assert.ok(MIN_STALL_DAYS === 7 && DAILY_SEND_CAP === 50);
});
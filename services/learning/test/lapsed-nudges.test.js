import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IDS, fixtureData, setupTestEnvironment } from '@learnloop/shared/testing';
import { createNotification, listNotifications } from '@learnloop/notifications/services/inbox';
import { sendEmail } from '@learnloop/notifications/services/email';
import { daysSinceLastActivity, listProgressOverview } from '../src/services/progress.js';
import { listEnrolledCourseIds } from '../src/repositories/enrolments.js';
import { listLearnerUsers, markNotificationAppliedByAgent } from '../src/repositories/nudges.js';
import { collectCandidates, LAPSED_NUDGE_JOB, runLapsedLearnerNudges } from '../src/jobs/lapsedNudges.js';
import { normaliseDecisions, parseDecisions } from '../src/agents/lapsedNudge.js';
import { handler } from '../src/handler.js';

const NOW = new Date('2026-11-03T12:00:00Z');
const FLAG = { 'ga-find_137394cd3691': { enabled: true } };

/** Fixture plus a second lapsed learner (19 days stalled, less at risk than Lee's 29). */
function nudgeData() {
  const data = fixtureData();
  data.enrolments.push({ id: 'enr_0000000000b2', user_id: IDS.learnerNoSub, course_id: IDS.data, enrolled_at: '2026-10-01T10:00:00.000Z' });
  data.progress.lessons.push({ user_id: IDS.learnerNoSub, course_id: IDS.data, lesson_id: IDS.dataLesson, status: 'started', started_at: '2026-10-15T10:00:00.000Z', completed_at: null });
  data.progress.courses.push({ user_id: IDS.learnerNoSub, course_id: IDS.data, last_activity_at: '2026-10-15T10:00:00.000Z' });
  return data;
}

function tracked() {
  const calls = {};
  const wrap = (name, fn) => (...args) => {
    calls[name] = (calls[name] ?? 0) + 1;
    return fn(...args);
  };
  const deps = {
    listLearnerUsers: wrap('listLearnerUsers', listLearnerUsers),
    listEnrolledCourseIds: wrap('listEnrolledCourseIds', listEnrolledCourseIds),
    daysSinceLastActivity: wrap('daysSinceLastActivity', daysSinceLastActivity),
    listProgressOverview: wrap('listProgressOverview', listProgressOverview),
    listNotifications: wrap('listNotifications', listNotifications),
    createNotification: wrap('createNotification', createNotification),
    markNotificationAppliedByAgent: wrap('markNotificationAppliedByAgent', markNotificationAppliedByAgent),
    sendEmail: wrap('sendEmail', sendEmail),
  };
  return { deps, calls };
}

/** Mocked model: no network, no AWS. Records what it was asked. */
function fakeModel(decisions) {
  const prompts = [];
  return {
    prompts,
    async invoke(messages) {
      prompts.push(JSON.stringify(messages));
      return { content: `\`\`\`json\n${JSON.stringify(decisions)}\n\`\`\`` };
    },
  };
}

const bothSelected = [
  { userId: IDS.learner, courseId: IDS.cloud, send: true, subject: 'Pick up Cloud Foundations', body: 'Lesson Two is waiting for you.' },
  { userId: IDS.learnerNoSub, courseId: IDS.data, send: true, subject: 'Back to SQL for Analysts', body: 'Select is your next lesson.' },
];

let env;
beforeEach(() => { env = setupTestEnvironment({ data: nudgeData(), flags: FLAG }); });

test('the job is registered on the learning handler', async () => {
  const listed = await handler({ listJobs: true });
  assert.ok(listed.jobs.includes(LAPSED_NUDGE_JOB));
});

test('flag off: the trigger does nothing and never calls the model', async () => {
  env = setupTestEnvironment({ data: nudgeData(), flags: {} });
  const model = fakeModel(bothSelected);
  const { deps, calls } = tracked();
  const result = await runLapsedLearnerNudges(NOW, { model, deps });
  assert.deepEqual(result, { sent: 0, candidates: 0, reason: 'flag_off' });
  assert.equal(model.prompts.length, 0);
  assert.equal(calls.listLearnerUsers, undefined);
  assert.equal((await env.store.read('notifications')).length, 2);
  assert.equal(env.ses.sent.length, 0);
  // Through the real trigger path (EventBridge-style invocation) nothing happens either.
  assert.deepEqual(await handler({ job: LAPSED_NUDGE_JOB }), { ok: true });
  assert.equal((await env.store.read('notifications')).length, 2);
});

test('candidates come from the deterministic progress code, most stalled first', async () => {
  const { deps, calls } = tracked();
  const { candidates, sentToday } = await collectCandidates(NOW, deps);
  assert.deepEqual(candidates.map((c) => c.userId), [IDS.learner, IDS.learnerNoSub]);
  assert.equal(candidates[0].daysInactive, await daysSinceLastActivity(IDS.learner, NOW));
  assert.equal(candidates[0].courses[0].nextLessonId, IDS.lesson2);
  assert.equal(candidates[0].courses[0].percent, 17);
  assert.equal(sentToday, 0);
  assert.ok(calls.daysSinceLastActivity >= 2);
  assert.ok(calls.listProgressOverview >= 2);
  assert.ok(calls.listEnrolledCourseIds >= 2);
  assert.ok(calls.listNotifications >= 2);
});

test('flag on: nudges are delivered through the inbox and email services and marked applied_by_agent', async () => {
  const model = fakeModel(bothSelected);
  const { deps, calls } = tracked();
  const result = await runLapsedLearnerNudges(NOW, { model, deps });
  assert.equal(result.sent, 2);
  assert.equal(model.prompts.length, 1, 'one batched model call for all candidates');
  const prompt = model.prompts[0];
  assert.ok(prompt.indexOf(IDS.learner) < prompt.indexOf(IDS.learnerNoSub), 'most stalled learner first');
  assert.ok(!prompt.includes('lee.learner@example.com'), 'no learner email reaches the model');
  assert.equal(calls.createNotification, 2);
  assert.equal(calls.sendEmail, 2);
  assert.equal(calls.markNotificationAppliedByAgent, 2);

  const created = (await env.store.read('notifications')).filter((n) => n.applied_by_agent === true);
  assert.equal(created.length, 2);
  const lee = created.find((n) => n.user_id === IDS.learner);
  assert.equal(lee.title, 'Pick up Cloud Foundations');
  assert.equal(lee.link, `/lessons/${IDS.lesson2}`);
  assert.equal(env.ses.sent.length, 2);
  env.logs.restore();
  assert.equal(env.logs.events('staff_message_sent').length, 2);
});

test('the daily cap keeps the most at-risk learner, not the first one found', async () => {
  const model = fakeModel(bothSelected);
  const { deps } = tracked();
  const result = await runLapsedLearnerNudges(NOW, { model, deps, dailyCap: 1 });
  assert.equal(result.sent, 1);
  const created = (await env.store.read('notifications')).filter((n) => n.applied_by_agent === true);
  assert.deepEqual(created.map((n) => n.user_id), [IDS.learner]);
});

test('cooldown: a second run inside 14 days sends nothing', async () => {
  const { deps } = tracked();
  await runLapsedLearnerNudges(NOW, { model: fakeModel(bothSelected), deps });
  const second = fakeModel(bothSelected);
  const result = await runLapsedLearnerNudges(new Date('2026-11-10T07:30:00Z'), { model: second, deps });
  assert.equal(result.sent, 0);
  assert.equal(second.prompts.length, 0, 'no candidates left, so no model call');
  assert.equal((await env.store.read('notifications')).filter((n) => n.applied_by_agent === true).length, 2);
});

test('learners inside the inactivity threshold are not candidates', async () => {
  const model = fakeModel(bothSelected);
  const { deps } = tracked();
  const result = await runLapsedLearnerNudges(new Date('2026-10-10T07:30:00Z'), { model, deps });
  assert.deepEqual(result, { sent: 0, candidates: 0, reason: 'no_candidates' });
  assert.equal(model.prompts.length, 0);
  assert.equal(env.ses.sent.length, 0);
});

test('the model cannot pick recipients or courses outside the candidate list', () => {
  const candidates = [{ userId: IDS.learner, courses: [{ courseId: IDS.cloud }] }];
  const kept = normaliseDecisions(parseDecisions(JSON.stringify([
    { userId: 'usr_ffffffffffff', courseId: IDS.cloud, subject: 's', body: 'b' },
    { userId: IDS.learner, courseId: IDS.data, subject: 's', body: 'b' },
    { userId: IDS.learner, courseId: IDS.cloud, send: false, subject: 's', body: 'b' },
    { userId: IDS.learner, courseId: IDS.cloud, subject: 'Keep going', body: 'Lesson Two next.' },
  ])), candidates);
  assert.deepEqual(kept, [{ userId: IDS.learner, courseId: IDS.cloud, subject: 'Keep going', body: 'Lesson Two next.' }]);
  assert.deepEqual(parseDecisions('not json at all'), []);
});
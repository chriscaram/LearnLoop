import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IDS, apiEvent, checkRoutesTable, fixtureData, setupTestEnvironment, testSessionCookie } from '@learnloop/shared/testing';
import { latestSubscriptionByUser, listLearners, planLabel } from '../src/services/learners.js';
import { sendStaffMessage, validateMessage } from '../src/services/messages.js';
import { getFlags, updateFlag } from '../src/services/flags.js';
import { listSupportQueue, replyToLearner } from '../src/services/support.js';
import { getLearnerTraining, trainingState, TRAINING_STATUSES } from '../src/services/training.js';
import { findOrganizationById, listOrganizations } from '../src/repositories/organizations.js';
import { listAssignmentsForOrganization, listAssignmentsForUser } from '../src/repositories/trainingAssignments.js';
import { routes } from '../src/routes.js';
import { handler } from '../src/handler.js';

let env;
beforeEach(() => { env = setupTestEnvironment({ data: fixtureData(), flags: { new_catalog_filters: { enabled: false } } }); });
const NOW = new Date('2026-11-03T12:00:00Z');

test('routes table (all staff-only)', () => {
  checkRoutesTable(assert, routes, { service: 'admin', expected: [
    'GET /api/admin/learners', 'GET /api/admin/learners/{userId}/training', 'POST /api/admin/learners/{userId}/message', 'GET /api/admin/flags', 'PUT /api/admin/flags/{flagKey}',
    'GET /api/admin/support-requests', 'POST /api/admin/support-requests/{requestId}/reply', 'GET /api/admin/agent-nudges',
  ] });
  assert.ok(routes.every((r) => r.auth === 'staff'));
});

test('latestSubscriptionByUser and planLabel', () => {
  const subs = [
    { user_id: 'a', started_at: '2026-01-01', status: 'cancelled' },
    { user_id: 'a', started_at: '2026-05-01', status: 'active' },
  ];
  assert.equal(latestSubscriptionByUser(subs).get('a').status, 'active');
  assert.equal(planLabel(null), 'No plan');
  assert.equal(planLabel({ status: 'cancelled' }), 'Monthly (cancelled)');
});

test('listLearners uses learning progress for last activity', async () => {
  const rows = await listLearners(NOW);
  assert.deepEqual(rows.map((r) => r.name), ['Lee Learner', 'Nia Nosub']);
  assert.equal(rows[0].daysSinceLastActivity, 29);
  assert.deepEqual(rows[0].enrolledCourses, ['Cloud Foundations']);
  assert.equal(rows[1].plan, 'No plan');
  assert.deepEqual([rows[0].organization, rows[0].department, rows[0].managerName], [{ id: IDS.org, name: 'Acme Freight' }, 'Finance', 'Nia Nosub']);
  assert.equal(rows[1].managerName, null);
});

test('listLearners keeps one organization\'s employees; an unknown organization is refused', async () => {
  await env.store.update('users', (users) => { users.push({ id: 'usr_0000000000c3', email: 'cy.solo@example.com', name: 'Cy Solo', role: 'learner', created_at: '2026-06-01T09:00:00.000Z' }); });
  assert.equal((await listLearners(NOW)).length, 3);
  const acme = await listLearners(NOW, { organizationId: IDS.org });
  assert.deepEqual(acme.map((r) => r.name), ['Lee Learner', 'Nia Nosub']);
  assert.equal((await listLearners(NOW)).find((r) => r.name === 'Cy Solo').organization, null);
  await assert.rejects(listLearners(NOW, { organizationId: 'org_ffffffffffff' }), (e) => e.status === 400);
});

test('organization and training assignment repositories', async () => {
  assert.deepEqual((await listOrganizations()).map((o) => o.name), ['Acme Freight']);
  assert.equal((await findOrganizationById(IDS.org)).name, 'Acme Freight');
  assert.equal(await findOrganizationById('org_ffffffffffff'), null);
  assert.deepEqual((await listAssignmentsForUser(IDS.learner)).map((a) => a.id).sort(), [IDS.assignmentCloud, IDS.assignmentData]);
  assert.equal((await listAssignmentsForOrganization(IDS.org)).length, 3);
  assert.deepEqual(await listAssignmentsForOrganization('org_ffffffffffff'), []);
});

test('trainingState: completed needs every lesson and a passing score on every quiz; otherwise overdue, in progress or assigned', () => {
  const assignment = { due_at: '2026-11-20T23:59:59.000Z', required_pass_score: 80 };
  const lessons = [{ id: 'l1', duration_min: 10, hasQuiz: false }, { id: 'l2', duration_min: 30, hasQuiz: true }];
  const done = (id, at) => ({ lesson_id: id, status: 'completed', completed_at: at });
  const quiz = (score, at) => ({ id: `q${at}`, lesson_id: 'l2', score, submitted_at: at });
  const before = new Date('2026-11-03T12:00:00Z');
  const after = new Date('2026-11-25T12:00:00Z');
  assert.equal(trainingState(assignment, { lessons, progress: [], quizResults: [] }, before).status, 'assigned');
  assert.equal(trainingState(assignment, { lessons, progress: [], quizResults: [] }, after).status, 'overdue');
  const partial = trainingState(assignment, { lessons, progress: [done('l1', '2026-11-01T10:00:00.000Z')], quizResults: [] }, before);
  assert.deepEqual([partial.status, partial.percent, partial.completedLessons, partial.totalLessons], ['in_progress', 25, 1, 2]);
  // all lessons done but the quiz never passed: not completed, and overdue after the due date
  const progress = [done('l1', '2026-11-01T10:00:00.000Z'), done('l2', '2026-11-02T10:00:00.000Z')];
  const failing = { lessons, progress, quizResults: [quiz(67, '2026-11-02T10:05:00.000Z'), quiz(33, '2026-11-02T10:09:00.000Z')] };
  const f = trainingState(assignment, failing, after);
  assert.deepEqual([f.status, f.percent, f.quizAttempts, f.failedQuizAttempts, f.bestQuizScore, f.completedAt], ['overdue', 100, 2, 2, 67, null]);
  // a third attempt passes: completed at that attempt, on time
  const passed = trainingState(assignment, { ...failing, quizResults: [...failing.quizResults, quiz(100, '2026-11-04T08:00:00.000Z')] }, after);
  assert.deepEqual([passed.status, passed.completedAt, passed.completedOnTime, passed.failedQuizAttempts], ['completed', '2026-11-04T08:00:00.000Z', true, 2]);
  const late = trainingState({ ...assignment, due_at: '2026-11-03T00:00:00.000Z' }, { ...failing, quizResults: [quiz(100, '2026-11-04T08:00:00.000Z')] }, after);
  assert.deepEqual([late.status, late.completedOnTime], ['completed', false]);
  assert.equal(trainingState(assignment, { lessons: [], progress: [], quizResults: [] }, before).status, 'assigned', 'a course without lessons is never completed');
  assert.deepEqual([...TRAINING_STATUSES], ['assigned', 'in_progress', 'completed', 'overdue']);
});

test('getLearnerTraining: an employee\'s required courses, soonest due first, with the organization, team and manager', async () => {
  const { learner, assignments } = await getLearnerTraining(IDS.learner, NOW);
  assert.deepEqual(learner, {
    userId: IDS.learner, name: 'Lee Learner', email: 'lee.learner@example.com',
    organization: { id: IDS.org, name: 'Acme Freight' }, department: 'Finance', manager: { userId: IDS.learnerNoSub, name: 'Nia Nosub' },
  });
  assert.deepEqual(assignments.map((a) => [a.id, a.courseTitle, a.status, a.percent]), [
    [IDS.assignmentData, 'SQL for Analysts', 'overdue', 0],
    [IDS.assignmentCloud, 'Cloud Foundations', 'in_progress', 17],
  ]);
  assert.equal(assignments[1].lastActivityAt, '2026-10-05T10:00:00.000Z');
  assert.equal(assignments[1].requiredPassScore, 80);
  // a quiz attempt on the course counts towards it, a failing one is counted as failed
  await env.store.update('quiz_results', (all) => { all.push({ id: 'qzr_0000000000a1', user_id: IDS.learner, lesson_id: IDS.lesson3, score: 33, correct: 1, total: 3, submitted_at: '2026-11-02T10:00:00.000Z' }); });
  const again = (await getLearnerTraining(IDS.learner, NOW)).assignments[1];
  assert.deepEqual([again.quizAttempts, again.failedQuizAttempts, again.bestQuizScore], [1, 1, 33]);
  const manager = await getLearnerTraining(IDS.learnerNoSub, NOW);
  assert.deepEqual([manager.learner.manager, manager.assignments[0].status], [null, 'assigned']);
  await assert.rejects(getLearnerTraining(IDS.staff, NOW), (e) => e.status === 404);
  await assert.rejects(getLearnerTraining('usr_ffffffffffff', NOW), (e) => e.status === 404);
});

test('getLearnerTraining: a learner who is not an employee has no organization and no assignments', async () => {
  await env.store.update('users', (users) => { users.push({ id: 'usr_0000000000c3', email: 'cy.solo@example.com', name: 'Cy Solo', role: 'learner', created_at: '2026-06-01T09:00:00.000Z' }); });
  const { learner, assignments } = await getLearnerTraining('usr_0000000000c3', NOW);
  assert.deepEqual([learner.organization, learner.department, learner.manager, assignments], [null, null, null, []]);
});

test('validateMessage', () => {
  assert.deepEqual(validateMessage({ title: ' Hi ', body: ' There ' }), { title: 'Hi', body: 'There' });
  assert.throws(() => validateMessage({ title: '', body: 'x' }), (e) => e.status === 400);
});

test('sendStaffMessage creates a staff_message notification and sends the email', async () => {
  const result = await sendStaffMessage(IDS.staff, IDS.learner, { title: 'Course update', body: 'New exercises are available.' }, NOW);
  assert.equal(result.email, 'sent');
  assert.equal(env.ses.sent[0].Message.Subject.Data, 'Course update');
  await assert.rejects(sendStaffMessage(IDS.staff, IDS.staff, { title: 'a', body: 'b' }), (e) => e.status === 404);
  env.logs.restore();
  const names = env.logs.events().map((e) => [e.event, e.actor_type]);
  assert.deepEqual(names, [['notification_created', 'system'], ['staff_message_sent', 'staff'], ['email_sent', 'system']]);
  assert.ok(!env.logs.lines.join('').includes('New exercises'), 'free text is never logged');
});

test('getFlags and updateFlag', async () => {
  assert.equal((await getFlags())[0].enabled, false);
  await updateFlag('new_catalog_filters', true);
  assert.equal((await getFlags())[0].enabled, true);
  await assert.rejects(updateFlag('new_catalog_filters', 'yes'), (e) => e.status === 400);
  env.logs.restore();
  const [event] = env.logs.events('feature_flag_changed');
  assert.equal(event['entity.id'], 'new_catalog_filters');
  assert.equal(event.actor_type, 'staff');
});

test('HTTP: learners need staff role; message and flag toggle work', async () => {
  const learner = await testSessionCookie({ userId: IDS.learner });
  assert.equal((await handler(apiEvent('GET /api/admin/learners', { cookie: learner }))).statusCode, 403);
  const staff = await testSessionCookie({ userId: IDS.staff, role: 'staff' });
  const list = JSON.parse((await handler(apiEvent('GET /api/admin/learners', { cookie: staff }))).body);
  assert.equal(list.learners.length, 2);
  assert.deepEqual(list.organizations, [{ id: IDS.org, name: 'Acme Freight' }]);
  const filtered = await handler(apiEvent('GET /api/admin/learners', { cookie: staff, query: { organization: IDS.org } }));
  assert.equal(JSON.parse(filtered.body).learners.length, 2);
  assert.equal((await handler(apiEvent('GET /api/admin/learners', { cookie: staff, query: { organization: 'org_ffffffffffff' } }))).statusCode, 400);
  const msg = await handler(apiEvent('POST /api/admin/learners/{userId}/message', { cookie: staff, pathParameters: { userId: IDS.learner }, body: { title: 'Hello', body: 'Thanks for your question about the course.' } }));
  assert.equal(msg.statusCode, 200);
  const flag = await handler(apiEvent('PUT /api/admin/flags/{flagKey}', { cookie: staff, pathParameters: { flagKey: 'new_catalog_filters' }, body: { enabled: true } }));
  env.logs.restore();
  assert.equal(JSON.parse(flag.body).flag.enabled, true);
});

test('listSupportQueue: open questions oldest first with the learner and whether the reply is overdue', async () => {
  const open = await listSupportQueue('open', NOW);
  assert.deepEqual(open.map((r) => [r.id, r.learner.name, r.overdue]), [[IDS.supportOpen, 'Lee Learner', true]]);
  assert.equal(open[0].learner.email, 'lee.learner@example.com');
  const early = await listSupportQueue('open', new Date('2026-10-31T09:00:00Z'));
  assert.equal(early[0].overdue, false);
  const answered = await listSupportQueue('answered', NOW);
  assert.deepEqual(answered.map((r) => [r.id, r.overdue, r.replies[0].staffName]), [[IDS.supportAnswered, false, 'Sam']]);
});

test('replyToLearner answers the question and names the staff member', async () => {
  const { supportRequest } = await replyToLearner(IDS.staff, IDS.supportOpen, { body: 'Yes, from next month.' }, NOW);
  env.logs.restore();
  assert.equal(supportRequest.status, 'answered');
  assert.equal(supportRequest.replies[0].staffName, 'Sam');
  assert.deepEqual((await listSupportQueue('open', NOW)), []);
  assert.equal(env.logs.events('support_reply_sent')[0].actor_type, 'staff');
});

test('HTTP: support queue and reply are staff-only', async () => {
  const learner = await testSessionCookie({ userId: IDS.learner });
  assert.equal((await handler(apiEvent('GET /api/admin/support-requests', { cookie: learner }))).statusCode, 403);
  const staff = await testSessionCookie({ userId: IDS.staff, role: 'staff' });
  const open = JSON.parse((await handler(apiEvent('GET /api/admin/support-requests', { cookie: staff }))).body);
  assert.equal(open.supportRequests.length, 1);
  const bad = await handler(apiEvent('GET /api/admin/support-requests', { cookie: staff, query: { status: 'closed' } }));
  assert.equal(bad.statusCode, 400);
  const reply = await handler(apiEvent('POST /api/admin/support-requests/{requestId}/reply', { cookie: staff, pathParameters: { requestId: IDS.supportOpen }, body: { body: 'Done.' } }));
  const missing = await handler(apiEvent('POST /api/admin/support-requests/{requestId}/reply', { cookie: staff, pathParameters: { requestId: 'sup_ffffffffffff' }, body: { body: 'Done.' } }));
  const answered = JSON.parse((await handler(apiEvent('GET /api/admin/support-requests', { cookie: staff, query: { status: 'answered' } }))).body);
  env.logs.restore();
  assert.equal(reply.statusCode, 200);
  assert.equal(missing.statusCode, 404);
  assert.equal(answered.supportRequests.length, 2);
});

test('HTTP: an employee\'s training is staff-only and writes one request line with the route template', async () => {
  const learner = await testSessionCookie({ userId: IDS.learner });
  assert.equal((await handler(apiEvent('GET /api/admin/learners/{userId}/training', { cookie: learner, pathParameters: { userId: IDS.learner } }))).statusCode, 403);
  const staff = await testSessionCookie({ userId: IDS.staff, role: 'staff' });
  env.logs.clear();
  const res = await handler(apiEvent('GET /api/admin/learners/{userId}/training', { cookie: staff, pathParameters: { userId: IDS.learner } }));
  const missing = await handler(apiEvent('GET /api/admin/learners/{userId}/training', { cookie: staff, pathParameters: { userId: 'usr_ffffffffffff' } }));
  env.logs.restore();
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.learner.organization.name, 'Acme Freight');
  assert.equal(body.assignments.length, 2);
  assert.equal(missing.statusCode, 404);
  const [line] = env.logs.records.filter((r) => r.kind === 'request');
  assert.deepEqual([line['service.name'], line['http.method'], line['http.route'], line['http.status_code']], ['admin', 'GET', '/api/admin/learners/{userId}/training', 200]);
  assert.deepEqual(env.logs.events(), [], 'reading an employee\'s training writes no business event');
});
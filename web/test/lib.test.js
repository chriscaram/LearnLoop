import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToHtml } from '../src/lib/markdown.js';
import { formatDuration, relativeDays, subscriptionLabel } from '../src/lib/format.js';

test('markdown: headings, lists, emphasis, escaping', () => {
  const html = markdownToHtml('## Title\n\nSome **bold** and *em* text.\n\n- one\n- two\n\n<script>x</script>');
  assert.match(html, /<h3>Title<\/h3>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.ok(!html.includes('<script>'));
});

test('format helpers', () => {
  const now = new Date('2026-11-03T12:00:00Z');
  assert.equal(relativeDays('2026-11-03T08:00:00Z', now), 'Today');
  assert.equal(relativeDays('2026-11-02T08:00:00Z', now), 'Yesterday');
  assert.equal(relativeDays('2026-10-01T08:00:00Z', now), '33 days ago');
  assert.equal(relativeDays(null, now), 'No activity yet');
  assert.equal(formatDuration(140), '2 h 20 min');
  assert.equal(subscriptionLabel({ status: 'active' }), 'Active');
  assert.equal(subscriptionLabel({ status: 'none' }), 'No subscription');
});

test('support helpers: topic labels, status and waiting time', async () => {
  const { SUPPORT_TOPICS, supportStatusLabel, topicLabel, waitingFor } = await import('../src/lib/support.js');
  assert.deepEqual(SUPPORT_TOPICS.map(([k]) => k), ['billing', 'certificate', 'account', 'course_content', 'other']);
  assert.equal(topicLabel('certificate'), 'Certificates');
  assert.equal(topicLabel('unknown'), 'Something else');
  assert.equal(supportStatusLabel({ status: 'open' }), 'Waiting for a reply');
  const now = new Date('2026-11-03T12:00:00Z');
  assert.equal(waitingFor('2026-11-03T11:30:00Z', now), 'less than an hour');
  assert.equal(waitingFor('2026-11-02T12:00:00Z', now), '24 hours');
  assert.equal(waitingFor('2026-10-30T12:00:00Z', now), '4 days');
});

test('training helpers: status words, employer line and quiz attempts', async () => {
  const { employerLine, quizAttemptsLabel, trainingStatusLabel } = await import('../src/lib/training.js');
  assert.equal(trainingStatusLabel({ status: 'overdue' }), 'Overdue');
  assert.equal(trainingStatusLabel({ status: 'assigned' }), 'Not started');
  assert.equal(trainingStatusLabel({ status: 'completed', completedOnTime: true }), 'Completed');
  assert.equal(trainingStatusLabel({ status: 'completed', completedOnTime: false }), 'Completed late');
  assert.equal(employerLine({ organization: { name: 'Acme Freight' }, department: 'Finance' }), 'Acme Freight · Finance');
  assert.equal(employerLine({ organization: null }), '');
  assert.equal(quizAttemptsLabel({ quizAttempts: 0 }), 'No attempts yet');
  assert.equal(quizAttemptsLabel({ quizAttempts: 3, failedQuizAttempts: 2, requiredPassScore: 80 }), '2 of 3 attempts below 80%');
  assert.equal(quizAttemptsLabel({ quizAttempts: 1, failedQuizAttempts: 1, requiredPassScore: 80 }), '1 of 1 attempt below 80%');
});

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

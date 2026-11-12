import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newNotifications } from '../src/new-notifications.js';

const users = [{ id: 'usr_a', email: 'a@example.com', name: 'A' }, { id: 'usr_b', email: 'b@example.com', name: 'B' }];
const notifications = [
  { user_id: 'usr_a', type: 'billing', title: 'Old', created_at: '2026-11-01T00:00:00.000Z' },
  { user_id: 'usr_b', type: 'staff_message', title: 'Second', created_at: '2026-11-12T00:00:02.000Z', applied_by_agent: true },
  { user_id: 'usr_a', type: 'staff_message', title: 'First', created_at: '2026-11-12T00:00:01.000Z' },
  { user_id: 'usr_gone', type: 'welcome', title: 'Orphan', created_at: '2026-11-12T00:00:03.000Z' },
];

test('newNotifications keeps only notifications since the given time, oldest first, with recipients', () => {
  assert.deepEqual(newNotifications(notifications, users, '2026-11-12T00:00:00.000Z'), [
    { email: 'a@example.com', name: 'A', type: 'staff_message', title: 'First', appliedByAgent: false, createdAt: '2026-11-12T00:00:01.000Z' },
    { email: 'b@example.com', name: 'B', type: 'staff_message', title: 'Second', appliedByAgent: true, createdAt: '2026-11-12T00:00:02.000Z' },
    { email: null, name: null, type: 'welcome', title: 'Orphan', appliedByAgent: false, createdAt: '2026-11-12T00:00:03.000Z' },
  ]);
  assert.throws(() => newNotifications(notifications, users, 'yesterday'), TypeError);
});

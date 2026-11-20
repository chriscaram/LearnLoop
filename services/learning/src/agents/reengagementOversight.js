// Read-only oversight read for the AI re-engagement agent (staff screen
// /admin/agent-outreach). Every status is worked out on read from records that
// already exist: notifications the agent created (applied_by_agent: true), their
// read_at, and the learner's last lesson activity. No new table or store.
import { listUsersByRole } from '@learnloop/admin/repositories/learners';
import { listNotifications } from '@learnloop/notifications/services/inbox';
import { getLastActivityAt } from '../services/progress.js';

export const GA_OVERSIGHT = 'ga-oversight';
export const OUTREACH_STATUSES = Object.freeze(['sent', 'opened', 'came_back', 'no_response']);
/** A message younger than this with no reaction is still "Sent", not "No response yet". */
export const RESPONSE_WINDOW_DAYS = 3;
const DAY_MS = 86_400_000;

/**
 * people: [{ userId, name, email, lastActivityAt, notifications }]
 * A message "came back" when the learner has lesson activity after it was sent.
 */
export function deriveOutreach(people, now = new Date()) {
  const totals = { sent: 0, opened: 0, cameBack: 0, cameBackOfOpened: 0 };
  const rows = [];
  for (const p of people) {
    const own = p.notifications
      .filter((n) => n.applied_by_agent === true)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (own.length === 0) continue;
    const messages = own.map((n) => {
      const cameBack = Boolean(p.lastActivityAt && p.lastActivityAt > n.created_at);
      return {
        id: n.id, title: n.title, body: n.body, link: n.link, createdAt: n.created_at, readAt: n.read_at ?? null,
        opened: Boolean(n.read_at), cameBack, cameBackAt: cameBack ? p.lastActivityAt : null, appliedByAgent: true,
      };
    });
    for (const m of messages) {
      totals.sent += 1;
      if (m.opened) totals.opened += 1;
      if (m.cameBack) totals.cameBack += 1;
      if (m.opened && m.cameBack) totals.cameBackOfOpened += 1;
    }
    const last = messages.at(-1);
    let status = 'no_response';
    if (messages.some((m) => m.cameBack)) status = 'came_back';
    else if (messages.some((m) => m.opened)) status = 'opened';
    else if (now - new Date(last.createdAt) < RESPONSE_WINDOW_DAYS * DAY_MS) status = 'sent';
    rows.push({ userId: p.userId, name: p.name, email: p.email, status, lastSentAt: last.createdAt, lastActivityAt: p.lastActivityAt, messages });
  }
  rows.sort((a, b) => b.lastSentAt.localeCompare(a.lastSentAt) || a.name.localeCompare(b.name));
  return { people: rows, totals };
}

export async function listAgentOutreach(now = new Date()) {
  const learners = await listUsersByRole('learner');
  const people = await Promise.all(learners.map(async (u) => ({
    userId: u.id,
    name: u.name,
    email: u.email,
    lastActivityAt: await getLastActivityAt(u.id),
    notifications: await listNotifications(u.id),
  })));
  return { generatedAt: now.toISOString(), ...deriveOutreach(people, now) };
}
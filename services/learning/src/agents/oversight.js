// Read-only staff oversight of the re-engagement agent (ga-find_42f472c7e4c8).
// Reads only existing records: the notifications the agent created
// (applied_by_agent: true) and each learner's last lesson activity. Every status is
// derived on read; nothing is stored.
import { AGENT_NOTIFICATION_TYPES, listNotifications } from '@learnloop/notifications/services/inbox';
import { getLastActivityAt } from '../services/progress.js';

export const GA_OVERSIGHT = 'ga-oversight';
export const NO_RESPONSE_AFTER_DAYS = 3;
const DAY_MS = 86_400_000;

/** The agent's messages to one learner, oldest first, with opened / came back. */
export function toOversightMessages(notifications, lastActivityAt) {
  return notifications
    .filter((n) => n.applied_by_agent === true && AGENT_NOTIFICATION_TYPES.includes(n.type))
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    .map((n) => ({
      id: n.id,
      title: n.title,
      body: n.body,
      link: n.link,
      createdAt: n.created_at,
      readAt: n.read_at ?? null,
      opened: Boolean(n.read_at),
      cameBack: Boolean(lastActivityAt && lastActivityAt > n.created_at),
    }));
}

/** came_back > opened > sent (recent) > no_response. */
export function personStatus(messages, now = new Date()) {
  if (messages.some((m) => m.cameBack)) return 'came_back';
  if (messages.some((m) => m.opened)) return 'opened';
  const newest = messages.at(-1);
  return now - new Date(newest.createdAt) < NO_RESPONSE_AFTER_DAYS * DAY_MS ? 'sent' : 'no_response';
}

export function oversightTotals(people) {
  const all = people.flatMap((p) => p.messages);
  return {
    sent: all.length,
    opened: all.filter((m) => m.opened).length,
    cameBack: all.filter((m) => m.opened && m.cameBack).length,
  };
}

/** learners: rows with { userId, name, email, organization }. Most recently contacted first. */
export async function listAgentOversight(learners, now = new Date()) {
  const people = (await Promise.all(learners.map(async (l) => {
    const lastActivityAt = await getLastActivityAt(l.userId);
    const messages = toOversightMessages(await listNotifications(l.userId), lastActivityAt);
    if (messages.length === 0) return null;
    return {
      userId: l.userId,
      name: l.name,
      email: l.email,
      account: l.organization?.name ?? null,
      lastActivityAt,
      status: personStatus(messages, now),
      messages,
    };
  }))).filter(Boolean);
  people.sort((a, b) => b.messages.at(-1).createdAt.localeCompare(a.messages.at(-1).createdAt));
  return { people, totals: oversightTotals(people) };
}
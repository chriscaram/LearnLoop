// Staff oversight of the lesson_reminders AI agent. Read-only: it reads the
// notifications the agent created (applied_by_agent: true) and the learners'
// lesson progress records, and derives every status on read. No new store.
import { listUsersByRole } from '@learnloop/admin/repositories/learners';
import { listNotifications } from '@learnloop/notifications/services/inbox';
import { listLessonProgress } from '../repositories/progress.js';

/** Marker for the oversight screen (web/src/pages/AgentOversight.jsx renders data-ga-oversight). */
export const GA_OVERSIGHT = 'ga-oversight';
export const NO_RESPONSE_AFTER_DAYS = 3;
export const REMINDER_STATUSES = Object.freeze(['sent', 'opened', 'came_back', 'no_response']);

const DAY_MS = 86_400_000;

/** Every lesson start or completion time, oldest first. */
export function activityTimes(records) {
  return records.flatMap((r) => [r.started_at, r.completed_at]).filter(Boolean).sort();
}

/**
 * The agent's messages oldest first. A message "came back" when the learner
 * started or completed a lesson after it and before the agent's next message.
 */
export function deriveMessages(notifications, times) {
  const mine = notifications.filter((n) => n.applied_by_agent === true)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  return mine.map((n, i) => {
    const until = mine[i + 1]?.created_at ?? null;
    const back = times.find((t) => t > n.created_at && (until === null || t <= until)) ?? null;
    return {
      id: n.id,
      title: n.title,
      body: n.body,
      link: n.link,
      createdAt: n.created_at,
      readAt: n.read_at ?? null,
      opened: Boolean(n.read_at),
      cameBackAt: back,
      appliedByAgent: true,
    };
  });
}

export function personStatus(messages, now = new Date()) {
  if (messages.some((m) => m.cameBackAt)) return 'came_back';
  if (messages.some((m) => m.opened)) return 'opened';
  const last = messages.at(-1);
  if (last && now - new Date(last.createdAt) >= NO_RESPONSE_AFTER_DAYS * DAY_MS) return 'no_response';
  return 'sent';
}

export function oversightStats(people) {
  const messages = people.flatMap((p) => p.messages);
  const opened = messages.filter((m) => m.opened);
  return { sent: messages.length, opened: opened.length, cameBack: opened.filter((m) => m.cameBackAt).length };
}

/** People the agent contacted, most recently contacted first, with their messages and stats. */
export async function listReminderOversight(now = new Date()) {
  const learners = await listUsersByRole('learner');
  const rows = await Promise.all(learners.map(async (u) => {
    const notifications = (await listNotifications(u.id)).filter((n) => n.applied_by_agent === true);
    if (notifications.length === 0) return null;
    const messages = deriveMessages(notifications, activityTimes(await listLessonProgress(u.id)));
    return {
      userId: u.id,
      name: u.name,
      email: u.email,
      status: personStatus(messages, now),
      lastMessageAt: messages.at(-1).createdAt,
      messages,
    };
  }));
  const people = rows.filter(Boolean).sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
  return { people, stats: oversightStats(people) };
}
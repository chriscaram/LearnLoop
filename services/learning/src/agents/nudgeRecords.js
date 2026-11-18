// Records of the inactivity nudge agent, and the read behind the staff
// oversight screen (/admin/agent-nudges). The agent's messages are ordinary
// inbox notifications marked applied_by_agent: true; no table of its own.
// Every status below is derived on read from records that already exist:
// the notification (created_at, read_at) and the learner's later lesson
// activity on the course the message was about (progress.courses).
import { getStore } from '@learnloop/shared/store';

/** Marker for the staff oversight screen of finding find_99c029aac886. */
export const GA_OVERSIGHT = 'ga-find_99c029aac886';
export const NUDGE_AGENT = 'inactivity_nudge';
/** A message neither opened nor acted on after this many days is "No response yet". */
export const NO_RESPONSE_AFTER_DAYS = 3;
export const PERSON_STATUSES = Object.freeze(['sent', 'opened', 'came_back', 'no_response']);

const DAY_MS = 86_400_000;

export async function listLearnerUsers() {
  return (await getStore().read('users')).filter((u) => u.role === 'learner');
}

/** Every notification the agent created. */
export async function listAgentNudges() {
  return (await getStore().read('notifications')).filter((n) => n.applied_by_agent === true && n.agent === NUDGE_AGENT);
}

/** Marks a notification as created by the agent and stores what it was about. */
export async function markAppliedByAgent(notificationId, fields = {}) {
  return getStore().update('notifications', (all) => {
    const found = all.find((n) => n.id === notificationId);
    if (!found) return null;
    Object.assign(found, fields, { applied_by_agent: true, agent: NUDGE_AGENT });
    return { ...found };
  });
}

/** When the learner came back to the nudged course after the message, or null. */
export function cameBackAt(nudge, activity) {
  const a = activity.find((c) => c.user_id === nudge.user_id && c.course_id === nudge.course_id);
  return a?.last_activity_at && a.last_activity_at > nudge.created_at ? a.last_activity_at : null;
}

export function personStatus(messages, now = new Date()) {
  if (messages.some((m) => m.cameBackAt)) return 'came_back';
  if (messages.some((m) => m.opened)) return 'opened';
  const last = messages.at(-1);
  return now - new Date(last.createdAt) < NO_RESPONSE_AFTER_DAYS * DAY_MS ? 'sent' : 'no_response';
}

/** Pure: people contacted (with messages oldest first), totals and a daily series. */
export function deriveOversight({ nudges, users, activity }, now = new Date()) {
  const byId = new Map(users.map((u) => [u.id, u]));
  const messages = nudges.map((n) => ({
    id: n.id,
    userId: n.user_id,
    title: n.title,
    body: n.body,
    link: n.link,
    courseId: n.course_id ?? null,
    createdAt: n.created_at,
    readAt: n.read_at ?? null,
    opened: Boolean(n.read_at),
    cameBackAt: cameBackAt(n, activity),
    emailStatus: n.email_status ?? null,
    appliedByAgent: true,
  })).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

  const grouped = new Map();
  for (const m of messages) {
    if (!grouped.has(m.userId)) grouped.set(m.userId, []);
    grouped.get(m.userId).push(m);
  }
  const people = [...grouped.entries()].map(([userId, list]) => ({
    userId,
    name: byId.get(userId)?.name ?? 'Unknown learner',
    email: byId.get(userId)?.email ?? '',
    status: personStatus(list, now),
    lastSentAt: list.at(-1).createdAt,
    messages: list,
  })).sort((a, b) => b.lastSentAt.localeCompare(a.lastSentAt));

  const days = new Map();
  const bump = (iso, key) => {
    if (!iso) return;
    const day = iso.slice(0, 10);
    if (!days.has(day)) days.set(day, { date: day, sent: 0, opened: 0, cameBack: 0 });
    days.get(day)[key] += 1;
  };
  for (const m of messages) {
    bump(m.createdAt, 'sent');
    bump(m.readAt, 'opened');
    bump(m.cameBackAt, 'cameBack');
  }

  return {
    people,
    totals: {
      sent: messages.length,
      opened: messages.filter((m) => m.opened).length,
      cameBack: messages.filter((m) => m.cameBackAt).length,
      cameBackOfOpened: messages.filter((m) => m.opened && m.cameBackAt).length,
    },
    daily: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

export async function getNudgeOversight(now = new Date()) {
  const [nudges, users, progress] = await Promise.all([
    listAgentNudges(), getStore().read('users'), getStore().read('progress'),
  ]);
  return deriveOversight({ nudges, users, activity: progress.courses ?? [] }, now);
}
// Read-only oversight of what the nudge agent sent. Every status is derived on
// read from records that already exist: agent notifications (applied_by_agent),
// their read_at, the users store and later lesson activity. No new store.
import { getStore } from '@learnloop/shared/store';

export const GA_OVERSIGHT = 'ga-find_02688b9ceef7';
/** A message younger than this with no reaction is "sent", older is "no response yet". */
export const RESPONSE_WINDOW_DAYS = 3;
const DAY_MS = 86_400_000;

export function deriveNudgeOversight({ notifications = [], users = [], lessonProgress = [] }, now = new Date()) {
  const byId = new Map(users.map((u) => [u.id, u]));
  const activity = new Map();
  for (const p of lessonProgress) {
    const times = activity.get(p.user_id) ?? [];
    for (const t of [p.started_at, p.completed_at]) if (t) times.push(t);
    activity.set(p.user_id, times);
  }
  const nudges = notifications
    .filter((n) => n.applied_by_agent === true)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const people = new Map();
  for (const n of nudges) {
    const cameBackAt = (activity.get(n.user_id) ?? []).filter((t) => t > n.created_at).sort()[0] ?? null;
    const message = {
      id: n.id, title: n.title, body: n.body, link: n.link, createdAt: n.created_at,
      openedAt: n.read_at ?? null, cameBackAt, appliedByAgent: true,
    };
    const user = byId.get(n.user_id);
    const person = people.get(n.user_id) ?? { userId: n.user_id, name: user?.name ?? 'Unknown', email: user?.email ?? '', messages: [] };
    person.messages.push(message);
    people.set(n.user_id, person);
  }
  const windowStart = new Date(now.getTime() - RESPONSE_WINDOW_DAYS * DAY_MS).toISOString();
  const list = [...people.values()].map((p) => {
    const last = p.messages.at(-1);
    let status = 'no_response';
    if (p.messages.some((m) => m.cameBackAt)) status = 'came_back';
    else if (p.messages.some((m) => m.openedAt)) status = 'opened';
    else if (last.createdAt > windowStart) status = 'sent';
    return { ...p, status, lastSentAt: last.createdAt };
  }).sort((a, b) => b.lastSentAt.localeCompare(a.lastSentAt));
  const messages = list.flatMap((p) => p.messages);
  return {
    people: list,
    stats: {
      sent: messages.length,
      opened: messages.filter((m) => m.openedAt).length,
      cameBackOfOpened: messages.filter((m) => m.openedAt && m.cameBackAt).length,
    },
  };
}

export async function readNudgeOversight(now = new Date()) {
  const store = getStore();
  const [notifications, users, progress] = await Promise.all([store.read('notifications'), store.read('users'), store.read('progress')]);
  return deriveNudgeOversight({ notifications, users, lessonProgress: progress?.lessons ?? [] }, now);
}
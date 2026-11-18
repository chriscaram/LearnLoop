// Staff oversight of the re-engagement AI agent (flag ga-find_95e2c1e5a8e6).
// Read-only: every status is derived on read from records that already exist —
// inbox notifications the agent marked applied_by_agent: true, their read_at,
// and the learner's later lesson activity or enrolment ("Came back").
import { badRequest } from '@learnloop/shared/http';
import { getStore } from '@learnloop/shared/store';

export const GA_OVERSIGHT = 'ga-find_95e2c1e5a8e6';
export const PERSON_STATUSES = Object.freeze(['Sent', 'Opened', 'Came back', 'No response yet']);
export const OVERSIGHT_PAGE_SIZE = 20;
const AWAITING_MS = 3 * 86_400_000;
const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 366;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** One row per agent message, oldest first, with when it was opened and when the learner came back. */
export function deriveMessages({ notifications, activity, enrolments }) {
  const laterTimes = new Map();
  const add = (userId, at) => { if (at) laterTimes.set(userId, [...(laterTimes.get(userId) ?? []), at]); };
  for (const a of activity) add(a.user_id, a.last_activity_at);
  for (const e of enrolments) add(e.user_id, e.enrolled_at);
  return notifications
    .filter((n) => n.applied_by_agent === true)
    .map((n) => ({
      id: n.id,
      userId: n.user_id,
      title: n.title,
      body: n.body,
      link: n.link,
      reason: n.agent_reason ?? null,
      appliedByAgent: true,
      createdAt: n.created_at,
      openedAt: n.read_at ?? null,
      cameBackAt: (laterTimes.get(n.user_id) ?? []).filter((t) => t > n.created_at).sort()[0] ?? null,
    }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function personStatus(messages, now) {
  if (messages.some((m) => m.cameBackAt)) return 'Came back';
  if (messages.some((m) => m.openedAt)) return 'Opened';
  const last = messages.at(-1);
  return last && now - new Date(last.createdAt) < AWAITING_MS ? 'Sent' : 'No response yet';
}

function resolveRange({ from, to }, now) {
  const end = to ?? now.toISOString().slice(0, 10);
  const start = from ?? new Date(new Date(`${end}T00:00:00Z`).getTime() - 13 * DAY_MS).toISOString().slice(0, 10);
  if (!DATE_RE.test(start) || !DATE_RE.test(end) || start > end) throw badRequest('invalid_range');
  if ((new Date(`${end}T00:00:00Z`) - new Date(`${start}T00:00:00Z`)) / DAY_MS > MAX_RANGE_DAYS) throw badRequest('invalid_range');
  return { from: start, to: end };
}

/** Pure: the whole screen's data from the records. */
export function buildOversight({ users, notifications, activity, enrolments }, now, query = {}) {
  if (query.status && !PERSON_STATUSES.includes(query.status)) throw badRequest('invalid_status');
  const range = resolveRange(query, now);
  const messages = deriveMessages({ notifications, activity, enrolments });
  const byUser = new Map();
  for (const m of messages) byUser.set(m.userId, [...(byUser.get(m.userId) ?? []), m]);
  const userById = new Map(users.map((u) => [u.id, u]));
  const q = String(query.q ?? '').trim().toLowerCase();
  const everyone = [...byUser.entries()].map(([userId, list]) => ({
    userId,
    name: userById.get(userId)?.name ?? 'Unknown learner',
    email: userById.get(userId)?.email ?? '',
    status: personStatus(list, now),
    sent: list.length,
    lastSentAt: list.at(-1).createdAt,
  })).sort((a, b) => b.lastSentAt.localeCompare(a.lastSentAt) || a.userId.localeCompare(b.userId));
  const filtered = everyone
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q))
    .filter((p) => !query.status || p.status === query.status);
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const opened = messages.filter((m) => m.openedAt);
  const daily = [];
  for (let t = new Date(`${range.from}T00:00:00Z`).getTime(); t <= new Date(`${range.to}T00:00:00Z`).getTime(); t += DAY_MS) {
    const date = new Date(t).toISOString().slice(0, 10);
    daily.push({
      date,
      sent: messages.filter((m) => m.createdAt.startsWith(date)).length,
      opened: messages.filter((m) => m.openedAt?.startsWith(date)).length,
      cameBack: messages.filter((m) => m.cameBackAt?.startsWith(date)).length,
    });
  }
  return {
    people: filtered.slice((page - 1) * OVERSIGHT_PAGE_SIZE, page * OVERSIGHT_PAGE_SIZE),
    total: filtered.length,
    page,
    pageSize: OVERSIGHT_PAGE_SIZE,
    stats: { sent: messages.length, opened: opened.length, cameBack: opened.filter((m) => m.cameBackAt).length },
    range,
    daily,
    messages: query.userId ? byUser.get(query.userId) ?? [] : [],
  };
}

export async function loadOversight(now = new Date(), query = {}) {
  const store = getStore();
  const [users, notifications, progress, enrolments] = await Promise.all([
    store.read('users'), store.read('notifications'), store.read('progress'), store.read('enrolments'),
  ]);
  return buildOversight({ users, notifications, activity: progress?.courses ?? [], enrolments }, now, query);
}
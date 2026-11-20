// Staff oversight for the cart follow-up AI agent: what it sent, to whom, and
// whether it worked. Read-only: statuses are derived on read from records that
// already exist (cart_reminder notifications marked applied_by_agent: true,
// their read_at, and later enrolments in the reminded courses). No new store.
import { badRequest, ok } from '@learnloop/shared/http';
import { isEnabled } from '@learnloop/shared/flags';
import { getStore } from '@learnloop/shared/store';

export const GA_OVERSIGHT = 'ga-oversight';
export const OVERSIGHT_STATUSES = Object.freeze(['sent', 'opened', 'came_back', 'no_response']);
/** An unopened reminder younger than this is "Sent"; older it is "No response yet". */
export const RESPONSE_WINDOW_DAYS = 2;
const MAX_RANGE_DAYS = 366;
const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const day = (iso) => iso.slice(0, 10);

/** Earliest enrolment by the same user in a reminded course at or after the reminder, or null. */
function cameBackAt(notification, enrolments) {
  const courses = new Set(notification.course_ids ?? []);
  const hits = enrolments
    .filter((e) => e.user_id === notification.user_id && courses.has(e.course_id) && e.enrolled_at >= notification.created_at)
    .map((e) => e.enrolled_at)
    .sort();
  return hits[0] ?? null;
}

export function deriveOversight({ notifications, enrolments, users }, now = new Date()) {
  const usersById = new Map(users.map((u) => [u.id, u]));
  const byUser = new Map();
  const agentMessages = notifications
    .filter((n) => n.applied_by_agent === true && n.type === 'cart_reminder')
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const n of agentMessages) {
    if (!byUser.has(n.user_id)) byUser.set(n.user_id, []);
    byUser.get(n.user_id).push({
      id: n.id, title: n.title, body: n.body, link: n.link, createdAt: n.created_at,
      readAt: n.read_at, opened: Boolean(n.read_at), cameBackAt: cameBackAt(n, enrolments), appliedByAgent: true,
    });
  }
  const people = [...byUser].map(([userId, messages]) => {
    const user = usersById.get(userId);
    const last = messages[messages.length - 1];
    let status;
    if (messages.some((m) => m.cameBackAt)) status = 'came_back';
    else if (messages.some((m) => m.opened)) status = 'opened';
    else status = now - new Date(last.createdAt) < RESPONSE_WINDOW_DAYS * DAY_MS ? 'sent' : 'no_response';
    return { userId, name: user?.name ?? 'Unknown learner', email: user?.email ?? '', status, lastSentAt: last.createdAt, messages };
  }).sort((a, b) => b.lastSentAt.localeCompare(a.lastSentAt));
  const all = people.flatMap((p) => p.messages);
  const opened = all.filter((m) => m.opened);
  return { people, stats: { sent: all.length, opened: opened.length, cameBack: opened.filter((m) => m.cameBackAt).length } };
}

/** One row per UTC day from `from` to `to` (YYYY-MM-DD, inclusive). */
export function dailySeries(messages, from, to) {
  const rows = new Map();
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY_MS) {
    const d = new Date(t).toISOString().slice(0, 10);
    rows.set(d, { date: d, sent: 0, opened: 0, cameBack: 0 });
  }
  for (const m of messages) {
    if (rows.has(day(m.createdAt))) rows.get(day(m.createdAt)).sent += 1;
    if (m.readAt && rows.has(day(m.readAt))) rows.get(day(m.readAt)).opened += 1;
    if (m.cameBackAt && rows.has(day(m.cameBackAt))) rows.get(day(m.cameBackAt)).cameBack += 1;
  }
  return [...rows.values()];
}

export async function cartFollowUpOversight({ query, now }) {
  const to = query.to ?? day(now.toISOString());
  const from = query.from ?? day(new Date(Date.parse(`${to}T00:00:00Z`) - 29 * DAY_MS).toISOString());
  if (!DAY_RE.test(from) || !DAY_RE.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) throw badRequest('invalid_range');
  const span = (Date.parse(to) - Date.parse(from)) / DAY_MS;
  if (span < 0 || span > MAX_RANGE_DAYS) throw badRequest('invalid_range');
  const store = getStore();
  const [notifications, enrolments, users, agentOn] = await Promise.all([
    store.read('notifications'), store.read('enrolments'), store.read('users'), isEnabled('ga-find_4219d5566568'),
  ]);
  const { people, stats } = deriveOversight({ notifications, enrolments, users }, now);
  return ok({ agentEnabled: agentOn, people, stats, range: { from, to }, daily: dailySeries(people.flatMap((p) => p.messages), from, to) });
}
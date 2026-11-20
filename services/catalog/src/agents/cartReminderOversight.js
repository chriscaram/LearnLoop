// Read-only oversight of the nudge_stalled_carts AI agent for the staff screen
// (web/src/pages/CartReminderOversight.jsx, root marked data-ga-oversight).
// Reads only existing records: the cart_reminder notifications the agent marked
// applied_by_agent: true (created_at, read_at) and later enrolments. Every status
// is worked out on read; nothing is stored.
import { isEnabled } from '@learnloop/shared/flags';
import { getStore } from '@learnloop/shared/store';

export const GA_OVERSIGHT = 'ga-oversight:find_d8539d6d1401';
const FLAG_KEY = 'ga-find_d8539d6d1401';
const DAY_MS = 86_400_000;
/** An enrolment within this many days after a reminder counts as "came back". */
export const CAME_BACK_WINDOW_DAYS = 14;
/** An unopened reminder older than this is "no response yet". */
export const NO_RESPONSE_AFTER_DAYS = 3;
export const OVERSIGHT_STATUSES = Object.freeze(['sent', 'opened', 'came_back', 'no_response']);

const day = (iso) => iso.slice(0, 10);

export function deriveOversight({ notifications, enrolments, users }, now = new Date()) {
  const messages = notifications
    .filter((n) => n.type === 'cart_reminder' && n.applied_by_agent === true)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const userById = new Map(users.map((u) => [u.id, u]));
  const people = new Map();
  const daily = new Map();
  const bump = (iso, key) => {
    if (!iso) return;
    const row = daily.get(day(iso)) ?? { date: day(iso), sent: 0, opened: 0, cameBack: 0 };
    row[key] += 1;
    daily.set(row.date, row);
  };
  const totals = { sent: 0, opened: 0, cameBack: 0 };
  for (const n of messages) {
    const back = enrolments
      .filter((e) => e.user_id === n.user_id && e.enrolled_at >= n.created_at && new Date(e.enrolled_at) - new Date(n.created_at) <= CAME_BACK_WINDOW_DAYS * DAY_MS)
      .sort((a, b) => a.enrolled_at.localeCompare(b.enrolled_at))[0];
    const message = { id: n.id, title: n.title, body: n.body, link: n.link, createdAt: n.created_at, readAt: n.read_at ?? null, cameBackAt: back?.enrolled_at ?? null, appliedByAgent: true };
    totals.sent += 1;
    bump(message.createdAt, 'sent');
    if (message.readAt) {
      totals.opened += 1;
      bump(message.readAt, 'opened');
      if (message.cameBackAt) totals.cameBack += 1;
    }
    if (message.cameBackAt) bump(message.cameBackAt, 'cameBack');
    const user = userById.get(n.user_id);
    const person = people.get(n.user_id) ?? { userId: n.user_id, name: user?.name ?? 'Unknown learner', email: user?.email ?? '', messages: [] };
    person.messages.push(message);
    people.set(n.user_id, person);
  }
  const list = [...people.values()].map((p) => {
    const last = p.messages[p.messages.length - 1];
    let status = 'sent';
    if (p.messages.some((m) => m.cameBackAt)) status = 'came_back';
    else if (p.messages.some((m) => m.readAt)) status = 'opened';
    else if (now - new Date(last.createdAt) >= NO_RESPONSE_AFTER_DAYS * DAY_MS) status = 'no_response';
    return { ...p, status, sentCount: p.messages.length, lastSentAt: last.createdAt };
  }).sort((a, b) => b.lastSentAt.localeCompare(a.lastSentAt));
  return { people: list, totals, daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

export async function getCartReminderOversight(now = new Date()) {
  const enabled = await isEnabled(FLAG_KEY);
  if (!enabled) return { enabled, people: [], totals: { sent: 0, opened: 0, cameBack: 0 }, daily: [] };
  const store = getStore();
  const [notifications, enrolments, users] = await Promise.all([store.read('notifications'), store.read('enrolments'), store.read('users')]);
  return { enabled, ...deriveOversight({ notifications, enrolments, users }, now) };
}
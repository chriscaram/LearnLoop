// Read-only oversight of the training follow-up AI agent. Every status is derived
// on read from records that already exist: the agent's drafts (applied_by_agent:
// true), the notification each one became (read_at), and the learner's lesson
// activity afterwards. Nothing is written here.
import { ok } from '@learnloop/shared/http';
import { listNotifications } from '@learnloop/notifications/services/inbox';
import { getLastActivityAt } from '../clients/learning.js';
import { findUserById } from '../repositories/learners.js';
import { DUE_SOON_DAYS, collectTraining, listAgentDrafts, requireAgentFlag } from './trainingFollowUp.js';

export const GA_OVERSIGHT = 'ga-oversight';
/** A sent message nobody opened is "No response yet" after this many days. */
export const RESPONSE_WINDOW_DAYS = 3;
const DAY_MS = 86_400_000;

/**
 * drafts: agent_drafts rows; notifications: the recipients' notifications;
 * lastActivityByLearner: Map userId -> ISO of last lesson activity; names: Map userId -> name.
 */
export function deriveOversight({ drafts, notifications, lastActivityByLearner, names, now = new Date() }) {
  const readAt = new Map(notifications.map((n) => [n.id, n.read_at ?? null]));
  const sent = drafts.filter((d) => d.applied_by_agent === true && d.status === 'sent' && d.sent_at)
    .sort((a, b) => a.sent_at.localeCompare(b.sent_at) || a.id.localeCompare(b.id));
  const people = new Map();
  const totals = { sent: 0, opened: 0, cameBack: 0, cameBackOfOpened: 0 };
  for (const d of sent) {
    const openedAt = readAt.get(d.notification_id) ?? null;
    const last = lastActivityByLearner.get(d.learner_id) ?? null;
    const cameBackAt = last && last > d.sent_at ? last : null;
    totals.sent += 1;
    if (openedAt) totals.opened += 1;
    if (cameBackAt) totals.cameBack += 1;
    if (openedAt && cameBackAt) totals.cameBackOfOpened += 1;
    const person = people.get(d.recipient_id) ?? { userId: d.recipient_id, name: names.get(d.recipient_id) ?? 'Unknown', messages: [] };
    person.messages.push({
      id: d.id,
      kind: d.kind,
      learnerName: names.get(d.learner_id) ?? 'Unknown',
      courseTitle: d.course_title,
      title: d.title,
      sentAt: d.sent_at,
      openedAt,
      cameBackAt,
      appliedByAgent: true,
    });
    people.set(d.recipient_id, person);
  }
  const list = [...people.values()].map((p) => {
    const lastSentAt = p.messages.at(-1).sentAt;
    let status = 'no_response';
    if (p.messages.some((m) => m.cameBackAt)) status = 'came_back';
    else if (p.messages.some((m) => m.openedAt)) status = 'opened';
    else if (now.getTime() - Date.parse(lastSentAt) < RESPONSE_WINDOW_DAYS * DAY_MS) status = 'sent';
    return { ...p, status, lastSentAt };
  }).sort((a, b) => b.lastSentAt.localeCompare(a.lastSentAt) || a.userId.localeCompare(b.userId));
  return { people: list, totals };
}

export function classifyAssignment(a, now = new Date()) {
  if (a.status === 'completed') return a.completedOnTime ? 'on_time' : 'late';
  if (a.status === 'overdue') return 'overdue';
  return Date.parse(a.dueAt) - now.getTime() <= DUE_SOON_DAYS * DAY_MS ? 'at_risk' : 'on_track';
}

/** On time / late / overdue / at risk / on track, by organization, by manager and per deadline. */
export function deriveDeadlines(trainings, now = new Date()) {
  const blank = () => ({ on_time: 0, late: 0, overdue: 0, at_risk: 0, on_track: 0, total: 0 });
  const byOrg = new Map();
  const byManager = new Map();
  const byDue = new Map();
  for (const t of trainings) {
    for (const a of t.assignments) {
      const key = classifyAssignment(a, now);
      const groups = [
        [byOrg, t.learner.organization?.name ?? 'No organization'],
        [byManager, t.learner.manager?.name ?? 'No manager'],
        [byDue, a.dueAt.slice(0, 10)],
      ];
      for (const [map, group] of groups) {
        const row = map.get(group) ?? blank();
        row[key] += 1;
        row.total += 1;
        map.set(group, row);
      }
    }
  }
  const rows = (map) => [...map].map(([group, counts]) => ({ group, ...counts })).sort((x, y) => x.group.localeCompare(y.group));
  return { organization: rows(byOrg), manager: rows(byManager), byDeadline: rows(byDue) };
}

async function agentOversight({ now }) {
  await requireAgentFlag();
  const drafts = (await listAgentDrafts()).filter((d) => d.applied_by_agent === true && d.status === 'sent');
  const recipients = [...new Set(drafts.map((d) => d.recipient_id))];
  const learners = [...new Set(drafts.map((d) => d.learner_id))];
  const [notifications, activity, names, trainings] = await Promise.all([
    Promise.all(recipients.map((id) => listNotifications(id))).then((lists) => lists.flat()),
    Promise.all(learners.map(async (id) => [id, await getLastActivityAt(id)])),
    Promise.all([...new Set([...recipients, ...learners])].map(async (id) => [id, (await findUserById(id))?.name ?? 'Unknown'])),
    collectTraining(now),
  ]);
  const view = deriveOversight({ drafts, notifications, lastActivityByLearner: new Map(activity), names: new Map(names), now });
  return ok({ ...view, deadlines: deriveDeadlines(trainings, now) });
}

export const oversightRoutes = [
  { method: 'GET', path: '/api/admin/agent-oversight', auth: 'staff', handler: agentOversight },
];
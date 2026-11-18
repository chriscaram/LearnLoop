// Read-only staff oversight of the training follow-up agent. Everything is derived
// on read from records that already exist: the notifications the agent marked
// applied_by_agent, their read_at, the learner's later course activity, and the
// training state from getLearnerTraining. No new table or store.
import { isEnabled } from '@learnloop/shared/flags';
import { ok } from '@learnloop/shared/http';
import { getStore } from '@learnloop/shared/store';
import { getCourseRecord } from '../clients/learning.js';
import { listOrganizations } from '../repositories/organizations.js';
import { listAssignmentsForOrganization } from '../repositories/trainingAssignments.js';
import { getLearnerTraining } from '../services/training.js';
import { DUE_SOON_DAYS, FLAG_KEY } from './trainingFollowUp.js';

export const GA_OVERSIGHT = 'ga-find_a52857d8153f';
const DAY_MS = 86_400_000;
export const NO_RESPONSE_AFTER_MS = 2 * DAY_MS;
const RANK = { came_back: 3, opened: 2, sent: 1, no_response: 0 };

/** came_back: course activity after the nudge; opened: read; sent: under 2 days old; else no_response. */
export function messageStatus(notification, lastActivityAt, now = new Date()) {
  if (lastActivityAt && lastActivityAt > notification.created_at) return 'came_back';
  if (notification.read_at) return 'opened';
  return now.getTime() - Date.parse(notification.created_at) > NO_RESPONSE_AFTER_MS ? 'no_response' : 'sent';
}

export function personStatus(statuses) {
  return statuses.reduce((best, s) => (RANK[s] > RANK[best] ? s : best), 'no_response');
}

/** on_time: completed by the due date or not due soon; at_risk: due within 14 days, not done; overdue otherwise. */
export function deadlineBucket(a, now = new Date()) {
  if (a.status === 'completed') return a.completedOnTime ? 'on_time' : 'overdue';
  if (a.status === 'overdue') return 'overdue';
  return Date.parse(a.dueAt) - now.getTime() <= DUE_SOON_DAYS * DAY_MS ? 'at_risk' : 'on_time';
}

export async function readFollowUpOversight(now = new Date()) {
  const store = getStore();
  const [notifications, users, organizations] = await Promise.all([store.read('notifications'), store.read('users'), listOrganizations()]);
  const userById = new Map(users.map((u) => [u.id, u]));
  const orgs = new Map(organizations.map((o) => [o.id, o.name]));
  const activity = new Map();
  const lastActivity = (userId, courseId) => {
    const key = `${userId}:${courseId}`;
    if (!activity.has(key)) activity.set(key, getCourseRecord(userId, courseId).then((r) => r?.lastActivityAt ?? null).catch(() => null));
    return activity.get(key);
  };

  const people = new Map();
  const nudges = notifications.filter((n) => n.applied_by_agent && n.agent_kind === 'nudge').sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const n of nudges) {
    const at = await lastActivity(n.user_id, n.course_id);
    const status = messageStatus(n, at, now);
    if (!people.has(n.user_id)) {
      const u = userById.get(n.user_id);
      people.set(n.user_id, { userId: n.user_id, name: u?.name ?? n.user_id, organization: orgs.get(u?.organization_id) ?? null, department: u?.department ?? null, messages: [] });
    }
    people.get(n.user_id).messages.push({
      id: n.id, title: n.title, body: n.body, courseId: n.course_id ?? null, createdAt: n.created_at, readAt: n.read_at ?? null,
      opened: Boolean(n.read_at), cameBackAt: status === 'came_back' ? at : null, status, appliedByAgent: true,
    });
  }
  const list = [...people.values()]
    .map((p) => ({ ...p, status: personStatus(p.messages.map((m) => m.status)), lastSentAt: p.messages.at(-1).createdAt }))
    .sort((a, b) => b.lastSentAt.localeCompare(a.lastSentAt));
  const all = list.flatMap((p) => p.messages);
  const stats = { sent: all.length, opened: all.filter((m) => m.opened).length, cameBack: all.filter((m) => m.opened && m.status === 'came_back').length };

  const seen = new Set();
  const escalations = notifications
    .filter((n) => n.applied_by_agent && n.agent_kind === 'escalation' && !seen.has(n.created_at) && seen.add(n.created_at))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((n) => ({ id: n.id, createdAt: n.created_at, title: n.title, body: n.body, appliedByAgent: true }));

  const deadlines = [];
  for (const [orgId, orgName] of orgs) {
    const userIds = [...new Set((await listAssignmentsForOrganization(orgId)).map((a) => a.user_id))];
    for (const userId of userIds) {
      const training = await getLearnerTraining(userId, now).catch(() => null);
      if (!training) continue;
      for (const a of training.assignments) {
        deadlines.push({
          organization: orgName,
          department: training.learner.department ?? 'No team',
          manager: training.learner.manager?.name ?? 'No manager',
          dueDate: a.dueAt.slice(0, 10),
          bucket: deadlineBucket(a, now),
        });
      }
    }
  }
  return { now: now.toISOString(), people: list, stats, escalations, deadlines };
}

async function followUps({ now }) {
  if (!(await isEnabled(FLAG_KEY))) return ok({ enabled: false, now: now.toISOString(), people: [], stats: { sent: 0, opened: 0, cameBack: 0 }, escalations: [], deadlines: [] });
  return ok({ enabled: true, ...(await readFollowUpOversight(now)) });
}

export const oversightRoutes = [
  { method: 'GET', path: '/api/admin/agent-follow-ups', auth: 'staff', handler: followUps },
];
import { daysSinceLastActivity, getLastActivityAt } from '../clients/learning.js';
import { badRequest } from '@learnloop/shared/http';
import { listCourses, listEnrolments, listSubscriptions, listUsersByRole } from '../repositories/learners.js';
import { listOrganizations } from '../repositories/organizations.js';

/** Most recent subscription per user. */
export function latestSubscriptionByUser(subscriptions) {
  const byUser = new Map();
  for (const s of subscriptions) {
    const current = byUser.get(s.user_id);
    if (!current || s.started_at > current.started_at) byUser.set(s.user_id, s);
  }
  return byUser;
}

export function planLabel(subscription) {
  if (!subscription) return 'No plan';
  return subscription.status === 'active' ? 'Monthly' : 'Monthly (cancelled)';
}

/**
 * Learner table for staff: name, plan, enrolled courses, last activity, and for an
 * employee of an enterprise account its organization, team and manager. Sorted by
 * name. `organizationId` keeps only that organization's employees.
 */
export async function listLearners(now = new Date(), { organizationId } = {}) {
  const [learners, subscriptions, enrolments, courses, organizations] = await Promise.all([
    listUsersByRole('learner'), listSubscriptions(), listEnrolments(), listCourses(), listOrganizations(),
  ]);
  const orgs = new Map(organizations.map((o) => [o.id, o]));
  if (organizationId !== undefined && !orgs.has(organizationId)) throw badRequest('unknown_organization');
  const names = new Map(learners.map((u) => [u.id, u.name]));
  const subs = latestSubscriptionByUser(subscriptions);
  const titles = new Map(courses.map((c) => [c.id, c.title]));
  const coursesByUser = new Map();
  for (const e of enrolments) {
    if (!coursesByUser.has(e.user_id)) coursesByUser.set(e.user_id, []);
    coursesByUser.get(e.user_id).push(titles.get(e.course_id) ?? e.course_id);
  }
  const shown = organizationId === undefined ? learners : learners.filter((u) => u.organization_id === organizationId);
  const rows = await Promise.all(shown.map(async (u) => ({
    userId: u.id,
    name: u.name,
    email: u.email,
    plan: planLabel(subs.get(u.id)),
    subscriptionStatus: subs.get(u.id)?.status ?? 'none',
    enrolledCourses: coursesByUser.get(u.id) ?? [],
    lastActivityAt: await getLastActivityAt(u.id),
    daysSinceLastActivity: await daysSinceLastActivity(u.id, now),
    organization: orgs.has(u.organization_id) ? { id: u.organization_id, name: orgs.get(u.organization_id).name } : null,
    department: u.department ?? null,
    managerName: u.manager_id ? names.get(u.manager_id) ?? null : null,
  })));
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** Enterprise accounts, by name. */
export async function listOrganizationNames() {
  return (await listOrganizations()).map((o) => ({ id: o.id, name: o.name })).sort((a, b) => a.name.localeCompare(b.name));
}

import { daysSinceLastActivity, getLastActivityAt } from '../clients/learning.js';
import { listCourses, listEnrolments, listSubscriptions, listUsersByRole } from '../repositories/learners.js';

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

/** Learner table for staff: name, plan, enrolled courses, last activity. Sorted by name. */
export async function listLearners(now = new Date()) {
  const [learners, subscriptions, enrolments, courses] = await Promise.all([
    listUsersByRole('learner'), listSubscriptions(), listEnrolments(), listCourses(),
  ]);
  const subs = latestSubscriptionByUser(subscriptions);
  const titles = new Map(courses.map((c) => [c.id, c.title]));
  const coursesByUser = new Map();
  for (const e of enrolments) {
    if (!coursesByUser.has(e.user_id)) coursesByUser.set(e.user_id, []);
    coursesByUser.get(e.user_id).push(titles.get(e.course_id) ?? e.course_id);
  }
  const rows = await Promise.all(learners.map(async (u) => ({
    userId: u.id,
    name: u.name,
    email: u.email,
    plan: planLabel(subs.get(u.id)),
    subscriptionStatus: subs.get(u.id)?.status ?? 'none',
    enrolledCourses: coursesByUser.get(u.id) ?? [],
    lastActivityAt: await getLastActivityAt(u.id),
    daysSinceLastActivity: await daysSinceLastActivity(u.id, now),
  })));
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

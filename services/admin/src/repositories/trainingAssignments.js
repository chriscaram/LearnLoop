import { getStore } from '@learnloop/shared/store';

// training_assignments.json: [{ id, organization_id, user_id, course_id, assigned_at,
// due_at, required_pass_score }] - the courses an enterprise account requires its
// employees to complete by a date. Whether one is completed, in progress or overdue is
// worked out from progress and quiz results when it is read, so it never goes stale.

export async function listAssignmentsForUser(userId) {
  return (await getStore().read('training_assignments')).filter((a) => a.user_id === userId);
}

export async function listAssignmentsForOrganization(organizationId) {
  return (await getStore().read('training_assignments')).filter((a) => a.organization_id === organizationId);
}

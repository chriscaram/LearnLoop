import { getStore } from '@learnloop/shared/store';

export async function listEnrolledCourseIds(userId) {
  return (await getStore().read('enrolments'))
    .filter((e) => e.user_id === userId)
    .sort((a, b) => a.enrolled_at.localeCompare(b.enrolled_at))
    .map((e) => e.course_id);
}

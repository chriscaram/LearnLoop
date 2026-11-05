import { getStore } from '@learnloop/shared/store';

export async function listEnrolmentsForUser(userId) {
  return (await getStore().read('enrolments')).filter((e) => e.user_id === userId);
}

/** Inserts unless the user is already enrolled; returns { enrolment, created }. */
export async function insertEnrolmentOnce(enrolment) {
  return getStore().update('enrolments', (all) => {
    const existing = all.find((e) => e.user_id === enrolment.user_id && e.course_id === enrolment.course_id);
    if (existing) return { enrolment: { ...existing }, created: false };
    all.push(enrolment);
    return { enrolment, created: true };
  });
}

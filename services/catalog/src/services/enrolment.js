import { randomBytes } from 'node:crypto';
import { HttpError, notFound } from '@learnloop/shared/http';
import { logEvent } from '@learnloop/shared/logger';
import { getSubscription, isActive } from '@learnloop/billing/services/subscription';
import { findCourseById } from '../repositories/courses.js';
import { insertEnrolmentOnce, listEnrolmentsForUser } from '../repositories/enrolments.js';

export async function listUserEnrolments(userId) {
  return (await listEnrolmentsForUser(userId)).sort((a, b) => a.enrolled_at.localeCompare(b.enrolled_at));
}

export async function isEnrolled(userId, courseId) {
  return (await listEnrolmentsForUser(userId)).some((e) => e.course_id === courseId);
}

/** Enrols the user; requires an active subscription. Idempotent. */
export async function enrol(userId, courseId, now = new Date()) {
  const course = await findCourseById(courseId);
  if (!course) throw notFound('course_not_found');
  if (!isActive(await getSubscription(userId), now)) throw new HttpError(402, 'subscription_required');
  const { enrolment, created } = await insertEnrolmentOnce({
    id: `enr_${randomBytes(6).toString('hex')}`,
    user_id: userId,
    course_id: courseId,
    enrolled_at: now.toISOString(),
  });
  if (created) logEvent({ event: 'course_enrolled', entityType: 'course', entityId: courseId });
  return enrolment;
}

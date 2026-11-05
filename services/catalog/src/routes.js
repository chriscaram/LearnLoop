import { isEnabled } from '@learnloop/shared/flags';
import { notFound, ok } from '@learnloop/shared/http';
import { logEvent } from '@learnloop/shared/logger';
import { CATEGORIES, getCourseDetail, listCatalog } from './services/catalog.js';
import { enrol, isEnrolled, listUserEnrolments } from './services/enrolment.js';

async function courses({ query, user }) {
  const filtersEnabled = await isEnabled('new_catalog_filters', { userId: user?.userId });
  const category = filtersEnabled ? query.category : undefined;
  const list = await listCatalog({ category });
  logEvent({ event: 'catalog_viewed' });
  return ok({ courses: list, categories: filtersEnabled ? CATEGORIES : null });
}

async function course({ params, user }) {
  const detail = await getCourseDetail(params.courseId);
  if (!detail) throw notFound('course_not_found');
  logEvent({ event: 'course_opened', entityType: 'course', entityId: detail.id });
  return ok({ course: { ...detail, enrolled: user ? await isEnrolled(user.userId, detail.id) : false } });
}

async function enrolInCourse({ params, user, now }) {
  const enrolment = await enrol(user.userId, params.courseId, now);
  return ok({ enrolment: { courseId: enrolment.course_id, enrolledAt: enrolment.enrolled_at } });
}

async function myEnrolments({ user }) {
  const list = await listUserEnrolments(user.userId);
  return ok({ enrolments: list.map((e) => ({ courseId: e.course_id, enrolledAt: e.enrolled_at })) });
}

export const routes = [
  { method: 'GET', path: '/api/courses', auth: 'public', handler: courses },
  { method: 'GET', path: '/api/courses/{courseId}', auth: 'public', handler: course },
  { method: 'POST', path: '/api/courses/{courseId}/enrol', auth: 'user', handler: enrolInCourse },
  { method: 'GET', path: '/api/me/enrolments', auth: 'user', handler: myEnrolments },
];

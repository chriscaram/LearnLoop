import { badRequest, conflict, notFound } from '@learnloop/shared/http';
import { logEvent } from '@learnloop/shared/logger';
import { findCourseById, listCourses } from '../repositories/courses.js';
import { listCartItems, updateCartItems } from '../repositories/carts.js';
import { listEnrolmentsForUser } from '../repositories/enrolments.js';
import { toCourseSummary } from './catalog.js';

const COURSE_ID_RE = /^crs_[0-9a-f]{12}$/;

export function validateCourseId(courseId) {
  if (typeof courseId !== 'string' || !COURSE_ID_RE.test(courseId)) throw badRequest('invalid_course_id');
  return courseId;
}

/** The cart as the web app shows it: one entry per course, with its summary. */
export async function getCart(userId) {
  const [items, courses] = await Promise.all([listCartItems(userId), listCourses()]);
  const byId = new Map(courses.map((c) => [c.id, c]));
  const entries = items
    .filter((i) => byId.has(i.course_id))
    .map((i) => ({ courseId: i.course_id, addedAt: i.added_at, course: toCourseSummary(byId.get(i.course_id)) }));
  return { items: entries, count: entries.length };
}

/** Adds a course the user is not enrolled in. Adding a course that is already in the cart changes nothing. */
export async function addToCart(userId, courseId, now = new Date()) {
  validateCourseId(courseId);
  if (!(await findCourseById(courseId))) throw notFound('course_not_found');
  if ((await listEnrolmentsForUser(userId)).some((e) => e.course_id === courseId)) throw conflict('already_enrolled');
  const added = await updateCartItems(userId, (items) => {
    if (items.some((i) => i.course_id === courseId)) return false;
    items.push({ course_id: courseId, added_at: now.toISOString() });
    return true;
  });
  if (added) logEvent({ event: 'cart_item_added', entityType: 'course', entityId: courseId });
  return getCart(userId);
}

/** Removes a course from the cart. Removing a course that is not in it changes nothing. */
export async function removeFromCart(userId, courseId) {
  validateCourseId(courseId);
  const removed = await takeOutOfCart(userId, courseId);
  if (removed) logEvent({ event: 'cart_item_removed', entityType: 'course', entityId: courseId });
  return getCart(userId);
}

/** A course the user has just enrolled in leaves the cart (part of the purchase, not a removal). */
export async function clearPurchasedCourse(userId, courseId) {
  return takeOutOfCart(userId, courseId);
}

async function takeOutOfCart(userId, courseId) {
  if (!(await listCartItems(userId)).some((i) => i.course_id === courseId)) return false;
  return updateCartItems(userId, (items) => {
    const index = items.findIndex((i) => i.course_id === courseId);
    if (index < 0) return false;
    items.splice(index, 1);
    return true;
  });
}

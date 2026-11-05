import { logEvent } from '@learnloop/shared/logger';
import { HttpError, notFound } from '@learnloop/shared/http';
import { listEnrolledCourseIds } from '../repositories/enrolments.js';
import { findCourseById, findLessonById, listLessonsForCourse } from '../repositories/lessons.js';
import { listCourseActivity, listLessonProgress, saveLessonProgress } from '../repositories/progress.js';

const DAY_MS = 86_400_000;

/**
 * Share of the course's total lesson time that is completed, 0-100.
 * progress: lesson progress records; course: { lessons: [{ id, duration_min }] }
 */
export function completionPercent(progress, course) {
  const lessons = course?.lessons ?? [];
  const total = lessons.reduce((sum, l) => sum + l.duration_min, 0);
  if (total === 0) return 0;
  const completed = new Set(progress.filter((p) => p.status === 'completed').map((p) => p.lesson_id));
  const done = lessons.filter((l) => completed.has(l.id)).reduce((sum, l) => sum + l.duration_min, 0);
  return Math.round((100 * done) / total);
}

function lastTouched(record) {
  return [record.started_at, record.completed_at].filter(Boolean).sort().at(-1);
}

/** The lesson the learner most recently started or completed in the course, or null. */
export async function getLastLessonViewed(userId, courseId) {
  const records = await listLessonProgress(userId, courseId);
  if (records.length === 0) return null;
  const latest = records.reduce((a, b) => (lastTouched(b) > lastTouched(a) ? b : a));
  return findLessonById(latest.lesson_id);
}

/** First lesson in course order that is not completed; null when the course is done. */
export async function nextLessonFor(userId, courseId) {
  const lessons = await listLessonsForCourse(courseId);
  const completed = new Set((await listLessonProgress(userId, courseId))
    .filter((p) => p.status === 'completed').map((p) => p.lesson_id));
  return lessons.find((l) => !completed.has(l.id)) ?? null;
}

export async function getCourseProgress(userId, courseId) {
  const [course, lessons, records, activity] = await Promise.all([
    findCourseById(courseId),
    listLessonsForCourse(courseId),
    listLessonProgress(userId, courseId),
    listCourseActivity(userId),
  ]);
  if (!course) return null;
  const [last, next] = await Promise.all([getLastLessonViewed(userId, courseId), nextLessonFor(userId, courseId)]);
  return {
    courseId,
    courseTitle: course.title,
    category: course.category,
    percent: completionPercent(records, { lessons }),
    completedLessons: records.filter((r) => r.status === 'completed').length,
    totalLessons: lessons.length,
    lastLesson: last ? { id: last.id, title: last.title } : null,
    nextLesson: next ? { id: next.id, title: next.title } : null,
    lastActivityAt: activity.find((a) => a.course_id === courseId)?.last_activity_at ?? null,
  };
}

/** Latest lesson activity across all courses, or null when there is none. */
export async function getLastActivityAt(userId) {
  const times = (await listCourseActivity(userId)).map((a) => a.last_activity_at).filter(Boolean).sort();
  return times.at(-1) ?? null;
}

/** Whole days since the learner's last lesson activity; null when there is none. */
export async function daysSinceLastActivity(userId, now = new Date()) {
  const last = await getLastActivityAt(userId);
  if (!last) return null;
  return Math.floor((now - new Date(last)) / DAY_MS);
}

/** Progress for every enrolled course, most recently active first. */
export async function listProgressOverview(userId) {
  const courseIds = await listEnrolledCourseIds(userId);
  const items = (await Promise.all(courseIds.map((id) => getCourseProgress(userId, id)))).filter(Boolean);
  return items.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
}

export async function assertEnrolled(userId, courseId) {
  if (!(await listEnrolledCourseIds(userId)).includes(courseId)) throw new HttpError(403, 'not_enrolled');
}

/** Marks a lesson started or completed and logs lesson_started / lesson_completed. */
export async function recordLessonProgress(userId, lessonId, status, now = new Date()) {
  if (status !== 'started' && status !== 'completed') throw new HttpError(400, 'invalid_status');
  const lesson = await findLessonById(lessonId);
  if (!lesson) throw notFound('lesson_not_found');
  await assertEnrolled(userId, lesson.course_id);
  const record = await saveLessonProgress({ userId, courseId: lesson.course_id, lessonId, status, at: now.toISOString() });
  logEvent({
    event: status === 'completed' ? 'lesson_completed' : 'lesson_started',
    entityType: 'lesson',
    entityId: lessonId,
    value: lesson.duration_min,
  });
  return record;
}

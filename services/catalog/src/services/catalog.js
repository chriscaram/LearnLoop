import { listCourses, findCourseById, listLessonOutline } from '../repositories/courses.js';

export const CATEGORIES = Object.freeze(['Data', 'Cloud', 'Leadership', 'Design']);

export function toCourseSummary(course) {
  return {
    id: course.id,
    title: course.title,
    category: course.category,
    summary: course.summary,
    level: course.level,
    lessonCount: course.lesson_ids.length,
    durationMin: course.duration_min,
  };
}

/** Published courses, optionally filtered by category (exact, case-insensitive). */
export async function listCatalog({ category } = {}) {
  const wanted = category ? String(category).toLowerCase() : null;
  return (await listCourses())
    .filter((c) => !wanted || c.category.toLowerCase() === wanted)
    .sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.title.localeCompare(b.title))
    .map(toCourseSummary);
}

export async function getCourseDetail(courseId) {
  const course = await findCourseById(courseId);
  if (!course) return null;
  return {
    ...toCourseSummary(course),
    description: course.description,
    publishedAt: course.published_at,
    lessons: await listLessonOutline(courseId),
  };
}

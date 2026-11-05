import { getStore } from '@learnloop/shared/store';

export async function listCourses() {
  return getStore().read('courses');
}

export async function findCourseById(courseId) {
  return (await listCourses()).find((c) => c.id === courseId) ?? null;
}

/** Lesson titles and durations for a course outline, in course order. */
export async function listLessonOutline(courseId) {
  const lessons = await getStore().read('lessons');
  return lessons
    .filter((l) => l.course_id === courseId)
    .sort((a, b) => a.position - b.position)
    .map((l) => ({ id: l.id, title: l.title, position: l.position, durationMin: l.duration_min }));
}

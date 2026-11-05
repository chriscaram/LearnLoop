import { getStore } from '@learnloop/shared/store';

export async function findLessonById(lessonId) {
  return (await getStore().read('lessons')).find((l) => l.id === lessonId) ?? null;
}

export async function listLessonsForCourse(courseId) {
  return (await getStore().read('lessons'))
    .filter((l) => l.course_id === courseId)
    .sort((a, b) => a.position - b.position);
}

export async function findCourseById(courseId) {
  return (await getStore().read('courses')).find((c) => c.id === courseId) ?? null;
}

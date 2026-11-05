import { notFound } from '@learnloop/shared/http';
import { findLessonById, listLessonsForCourse } from '../repositories/lessons.js';
import { listLessonProgress } from '../repositories/progress.js';
import { assertEnrolled } from './progress.js';

/** Quiz without the answers, for the learner. */
export function publicQuiz(quiz) {
  if (!quiz) return null;
  return { questions: quiz.questions.map((q) => ({ id: q.id, prompt: q.prompt, options: q.options })) };
}

export async function getLessonForLearner(userId, lessonId) {
  const lesson = await findLessonById(lessonId);
  if (!lesson) throw notFound('lesson_not_found');
  await assertEnrolled(userId, lesson.course_id);
  const record = (await listLessonProgress(userId, lesson.course_id)).find((p) => p.lesson_id === lessonId);
  return {
    id: lesson.id,
    courseId: lesson.course_id,
    position: lesson.position,
    title: lesson.title,
    durationMin: lesson.duration_min,
    bodyMarkdown: lesson.body_md,
    video: { placeholder: true, durationMin: lesson.duration_min },
    quiz: publicQuiz(lesson.quiz),
    status: record?.status ?? 'not_started',
  };
}

export async function listCourseLessons(userId, courseId) {
  await assertEnrolled(userId, courseId);
  const [lessons, records] = await Promise.all([listLessonsForCourse(courseId), listLessonProgress(userId, courseId)]);
  const status = new Map(records.map((r) => [r.lesson_id, r.status]));
  return lessons.map((l) => ({
    id: l.id,
    position: l.position,
    title: l.title,
    durationMin: l.duration_min,
    hasQuiz: Boolean(l.quiz),
    status: status.get(l.id) ?? 'not_started',
  }));
}

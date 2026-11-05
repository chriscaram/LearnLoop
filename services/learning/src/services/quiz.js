import { randomBytes } from 'node:crypto';
import { badRequest, notFound } from '@learnloop/shared/http';
import { logEvent } from '@learnloop/shared/logger';
import { findLessonById } from '../repositories/lessons.js';
import { insertQuizResult } from '../repositories/quizResults.js';
import { assertEnrolled } from './progress.js';

/** answers: { [questionId]: optionIndex }. Score is a whole percentage. */
export function gradeQuiz(quiz, answers = {}) {
  const total = quiz.questions.length;
  const correct = quiz.questions.filter((q) => Number(answers[q.id]) === q.answer_index).length;
  return {
    score: total === 0 ? 0 : Math.round((100 * correct) / total),
    correct,
    total,
    results: quiz.questions.map((q) => ({ id: q.id, correct: Number(answers[q.id]) === q.answer_index, answerIndex: q.answer_index })),
  };
}

export async function submitQuiz(userId, lessonId, answers, now = new Date()) {
  const lesson = await findLessonById(lessonId);
  if (!lesson) throw notFound('lesson_not_found');
  if (!lesson.quiz) throw badRequest('lesson_has_no_quiz');
  if (!answers || typeof answers !== 'object') throw badRequest('invalid_answers');
  await assertEnrolled(userId, lesson.course_id);
  const graded = gradeQuiz(lesson.quiz, answers);
  await insertQuizResult({
    id: `qzr_${randomBytes(6).toString('hex')}`,
    user_id: userId,
    lesson_id: lessonId,
    score: graded.score,
    correct: graded.correct,
    total: graded.total,
    submitted_at: now.toISOString(),
  });
  logEvent({ event: 'quiz_submitted', entityType: 'lesson', entityId: lessonId, value: graded.score });
  return graded;
}

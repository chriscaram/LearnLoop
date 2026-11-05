import { getStore } from '@learnloop/shared/store';

export async function insertQuizResult(result) {
  await getStore().update('quiz_results', (all) => {
    all.push(result);
  });
  return result;
}

export async function listQuizResults(userId, lessonId) {
  return (await getStore().read('quiz_results')).filter((r) => r.user_id === userId && (!lessonId || r.lesson_id === lessonId));
}

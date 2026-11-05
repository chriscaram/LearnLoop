import { getStore } from '@learnloop/shared/store';

// progress.json: { lessons: [{ user_id, course_id, lesson_id, status, started_at, completed_at }],
//                  courses: [{ user_id, course_id, last_activity_at }] }

export async function listLessonProgress(userId, courseId) {
  const { lessons } = await getStore().read('progress');
  return lessons.filter((p) => p.user_id === userId && (!courseId || p.course_id === courseId));
}

export async function listCourseActivity(userId) {
  const { courses } = await getStore().read('progress');
  return courses.filter((c) => c.user_id === userId);
}

/**
 * Records a lesson status change and the course's last activity in one write.
 * "completed" is final; "started" never downgrades it.
 */
export async function saveLessonProgress({ userId, courseId, lessonId, status, at }) {
  return getStore().update('progress', (progress) => {
    let record = progress.lessons.find((p) => p.user_id === userId && p.lesson_id === lessonId);
    if (!record) {
      record = { user_id: userId, course_id: courseId, lesson_id: lessonId, status: 'started', started_at: at, completed_at: null };
      progress.lessons.push(record);
    }
    if (status === 'completed' && record.status !== 'completed') {
      record.status = 'completed';
      record.completed_at = at;
    }
    let activity = progress.courses.find((c) => c.user_id === userId && c.course_id === courseId);
    if (!activity) {
      activity = { user_id: userId, course_id: courseId, last_activity_at: at };
      progress.courses.push(activity);
    }
    if (activity.last_activity_at === null || activity.last_activity_at < at) activity.last_activity_at = at;
    return { ...record };
  });
}

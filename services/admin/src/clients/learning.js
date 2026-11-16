// Thin internal client for the learning service's progress functions, so the
// admin view computes "last activity" and course completion exactly the way
// learners see it.
export {
  completionPercent, daysSinceLastActivity, getCourseProgress, getCourseRecord, getLastActivityAt,
} from '@learnloop/learning/services/progress';

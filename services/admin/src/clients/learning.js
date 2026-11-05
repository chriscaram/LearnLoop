// Thin internal client for the learning service's progress functions, so the
// admin view computes "last activity" exactly the way learners see it.
export { daysSinceLastActivity, getLastActivityAt, getCourseProgress } from '@learnloop/learning/services/progress';

/** Words for where a required course stands (the admin training view). */
const STATUS_LABELS = {
  assigned: 'Not started',
  in_progress: 'In progress',
  completed: 'Completed',
  overdue: 'Overdue',
};

export function trainingStatusLabel(assignment) {
  if (assignment.status === 'completed' && assignment.completedOnTime === false) return 'Completed late';
  return STATUS_LABELS[assignment.status] ?? 'Not started';
}

/** The line under a learner's name: their organization and team, when they have one. */
export function employerLine(learner) {
  if (!learner.organization) return '';
  return [learner.organization.name, learner.department].filter(Boolean).join(' · ');
}

/** "2 of 3 attempts failed" / "No attempts yet". */
export function quizAttemptsLabel(assignment) {
  if (!assignment.quizAttempts) return 'No attempts yet';
  return `${assignment.failedQuizAttempts} of ${assignment.quizAttempts} ${assignment.quizAttempts === 1 ? 'attempt' : 'attempts'} below ${assignment.requiredPassScore}%`;
}

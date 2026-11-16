/** Topics a learner can pick when asking the team, in the order the form shows them. */
export const SUPPORT_TOPICS = Object.freeze([
  ['billing', 'Billing and payments'],
  ['certificate', 'Certificates'],
  ['account', 'My account'],
  ['course_content', 'Course content'],
  ['other', 'Something else'],
]);

export function topicLabel(topic) {
  return SUPPORT_TOPICS.find(([key]) => key === topic)?.[1] ?? 'Something else';
}

/** "Answered" / "Waiting for a reply". */
export function supportStatusLabel(request) {
  return request.status === 'answered' ? 'Answered' : 'Waiting for a reply';
}

/** Whole hours (under two days) or days a question has been waiting at `now`. */
export function waitingFor(createdAt, now = new Date()) {
  const hours = Math.max(0, Math.floor((now - new Date(createdAt)) / 3_600_000));
  if (hours < 1) return 'less than an hour';
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const days = Math.floor(hours / 24);
  return `${days} days`;
}

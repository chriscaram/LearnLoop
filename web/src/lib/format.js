const DAY_MS = 86_400_000;

export function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** "today", "yesterday", "5 days ago" */
export function relativeDays(iso, now = new Date()) {
  if (!iso) return 'No activity yet';
  const days = Math.floor((now - new Date(iso)) / DAY_MS);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return `${days} days ago`;
}

export function formatDuration(minutes) {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function subscriptionLabel(subscription) {
  if (!subscription || subscription.status === 'none') return 'No subscription';
  if (subscription.status === 'active') return 'Active';
  return subscription.active ? `Cancelled, access until ${formatDate(subscription.currentPeriodEnd)}` : 'Ended';
}

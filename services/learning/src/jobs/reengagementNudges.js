// Trigger for the re-engagement agent (finding find_a431764685ac).
//
// Two equivalent entry points, both application code:
//   1. `reengagementJobs` - add `jobs: { ...reengagementJobs }` to the learning
//      service handler so the existing scheduled-job path (event.job) runs it.
//   2. `startReengagementScheduler()` - a minimal in-process interval that runs
//      the job once per day at 09:00 UTC.
//
// Both do nothing at all while the feature flag "ga-find_a431764685ac" is off.

import { FLAG_KEY, isAgentEnabled, runReengagementAgent } from "../agents/reengagementAgent.js";

const SCHEDULE_HOUR_UTC = 9;
const TICK_MS = 15 * 60 * 1000;

const scheduler = { timer: null, lastRunDate: null };

function utcDateKey(now) {
  return new Date(now).toISOString().slice(0, 10);
}

export async function sendReengagementNudges(event = {}) {
  if (!(await isAgentEnabled(event.deps || {}))) {
    return { flag: FLAG_KEY, enabled: false, sent: 0 };
  }
  return runReengagementAgent({ deps: event.deps, options: event.options, now: event.now });
}

export const reengagementJobs = {
  "reengagement-nudges": sendReengagementNudges,
};

export async function tickReengagementScheduler(now = Date.now(), event = {}) {
  if (!(await isAgentEnabled(event.deps || {}))) return null;
  const date = utcDateKey(now);
  if (scheduler.lastRunDate === date) return null;
  if (new Date(now).getUTCHours() < SCHEDULE_HOUR_UTC) return null;
  scheduler.lastRunDate = date;
  return sendReengagementNudges({ ...event, now });
}

export function startReengagementScheduler(event = {}) {
  if (scheduler.timer) return scheduler.timer;
  scheduler.timer = setInterval(() => {
    tickReengagementScheduler(Date.now(), event).catch(() => {});
  }, TICK_MS);
  if (typeof scheduler.timer.unref === "function") scheduler.timer.unref();
  return scheduler.timer;
}

export function stopReengagementScheduler() {
  if (scheduler.timer) {
    clearInterval(scheduler.timer);
    scheduler.timer = null;
  }
  scheduler.lastRunDate = null;
}

export default { reengagementJobs, sendReengagementNudges, startReengagementScheduler };
/**
 * Trigger for the re-engagement nudge agent (finding find_a431764685ac).
 *
 * Two entry points, both in application code:
 *  - `jobs`, a scheduled-job map in the shape the shared handler already routes
 *    (event.job -> the service's jobs map), same pattern as the billing renewals job;
 *  - `startReengagementScheduler()`, a minimal in-process daily interval.
 *
 * Both do nothing while the feature flag "ga-find_a431764685ac" is off.
 */
import { runReengagementNudges, FLAG_KEY } from "./reengagementNudges.js";

const DAY_MS = 24 * 60 * 60 * 1000;

let timer = null;

export const JOB_NAME = "reengagement-nudges";

export const jobs = {
  [JOB_NAME]: (event = {}) => runReengagementNudges(event.payload || {}),
};

export function startReengagementScheduler(options = {}) {
  if (timer) return timer;
  const log = options.logger || console;
  const intervalMs = options.intervalMs || DAY_MS;

  const tick = async () => {
    try {
      await runReengagementNudges(options);
    } catch (err) {
      if (typeof log.error === "function") {
        log.error("reengagement_job_failed", { flag: FLAG_KEY, error: err && err.message });
      }
    }
  };

  timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  if (options.runImmediately !== false) tick();
  return timer;
}

export function stopReengagementScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export default { jobs, JOB_NAME, startReengagementScheduler, stopReengagementScheduler };
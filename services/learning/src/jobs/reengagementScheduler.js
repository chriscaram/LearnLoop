/**
 * Trigger for the re-engagement nudge agent (find_a431764685ac).
 *
 * Two in-application entry points, both gated on the "ga-find_a431764685ac" flag
 * inside runReengagementNudgeJob (flag off => nothing happens):
 *
 *  1. `jobs` — the scheduled-job map the shared handler routes event.job to
 *     (packages/shared/src/http.js createHandler), same pattern as the billing
 *     renewal job. Wire it with one line in services/learning/src/handler.js:
 *         import { jobs } from "./jobs/reengagementScheduler.js";
 *         export const handler = createHandler({ ...existing, jobs });
 *
 *  2. `startReengagementNudgeScheduler()` — a minimal in-process daily interval
 *     for long-running processes (tools/dev server), also flag gated.
 */

import { runReengagementNudgeJob, FLAG_KEY } from "./reengagementNudge.js";

export const JOB_NAME = "reengagement-nudge";

/** Scheduled daily at 09:00 UTC ("0 9 * * *") by the platform scheduler. */
export const jobs = {
  [JOB_NAME]: (event = {}) => runReengagementNudgeJob(event.deps || {})
};

const DAILY_MS = 24 * 60 * 60 * 1000;

export function startReengagementNudgeScheduler(options = {}) {
  const intervalMs = options.intervalMs || DAILY_MS;
  const deps = options.deps || {};

  const tick = () =>
    Promise.resolve()
      .then(() => runReengagementNudgeJob(deps))
      .catch(() => {
        /* the job logs its own failures; never crash the host process */
      });

  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  return {
    flag: FLAG_KEY,
    job: JOB_NAME,
    runNow: tick,
    stop: () => clearInterval(timer)
  };
}

export default jobs;
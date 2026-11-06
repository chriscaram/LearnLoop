/**
 * Trigger for the stalled-learner re-engagement agent (find_a431764685ac).
 *
 * Two in-application entry points, both no-ops while the feature flag
 * "ga-find_a431764685ac" is absent or off:
 *   - `jobs` / `stalledLearnerNudgeJob`: for the service handler's jobs map
 *     (same pattern as the billing renewal job).
 *   - `startStalledLearnerNudgeScheduler()`: a minimal in-process interval that
 *     runs the job once per day at 09:00 UTC.
 */

import { runStalledLearnerNudgeAgent } from "./reengagementAgent.js";

export const JOB_NAME = "stalled-learner-nudges";
export const FLAG_KEY = "ga-find_a431764685ac";

const RUN_HOUR_UTC = 9;
const CHECK_INTERVAL_MS = 15 * 60 * 1000;

let timer = null;
let lastRunDay = null;

export async function stalledLearnerNudgeJob(options = {}) {
  return runStalledLearnerNudgeAgent(options);
}

export const jobs = { [JOB_NAME]: stalledLearnerNudgeJob };

export async function maybeRunScheduledNudges(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const day = now.toISOString().slice(0, 10);
  if (now.getUTCHours() !== RUN_HOUR_UTC) return { ran: false, reason: "outside_window" };
  if (lastRunDay === day) return { ran: false, reason: "already_ran_today" };
  lastRunDay = day;
  const run = options.run || stalledLearnerNudgeJob;
  const result = await run({ ...options, now });
  return { ran: true, result };
}

export function startStalledLearnerNudgeScheduler(options = {}) {
  if (timer) return timer;
  const intervalMs = options.intervalMs || CHECK_INTERVAL_MS;
  timer = setInterval(() => {
    maybeRunScheduledNudges(options).catch((err) => {
      console.error(
        JSON.stringify({
          level: "error",
          event: "reengagement_agent_scheduler_error",
          agent: FLAG_KEY,
          error: String(err && err.message ? err.message : err)
        })
      );
    });
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

export function stopStalledLearnerNudgeScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
  lastRunDay = null;
}

export function resetSchedulerState() {
  lastRunDay = null;
}

if (process.env.LEARNLOOP_IN_PROCESS_SCHEDULER === "1") {
  startStalledLearnerNudgeScheduler();
}
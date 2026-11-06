/**
 * Trigger for the re-engagement agent - application code only.
 *
 * Two ways in, both in-process:
 *  1. runReengagementNudgeJob - a job for the learning service handler's jobs
 *     map (same pattern as services/billing/src/jobs/renewals.js), invoked by
 *     the shared handler when event.job is set.
 *  2. startReengagementScheduler - a minimal in-process interval that runs the
 *     job once per day at 09:00 UTC for long-running processes.
 *
 * Both do nothing while the flag 'ga-find_a431764685ac' is absent or off.
 */

import { runReengagementAgent, FLAG_KEY } from './agent.js';

export { FLAG_KEY };
export const JOB_NAME = 'reengagement-nudges';
export const SCHEDULE = '0 9 * * *';

/** Job entry: add to the learning service jobs map as [JOB_NAME]. */
export async function runReengagementNudgeJob(event = {}, context = {}) {
  const result = await runReengagementAgent({
    logger: context.logger || event.logger,
    now: event.now,
    deps: event.deps,
    llm: event.llm
  });
  return { job: JOB_NAME, flag: FLAG_KEY, ...result };
}

export const jobs = { [JOB_NAME]: runReengagementNudgeJob };

/** Minimal in-process daily scheduler (09:00 UTC). Returns a stop function. */
export function startReengagementScheduler(options = {}) {
  const intervalMs = options.intervalMs || 15 * 60 * 1000;
  const hourUtc = options.hourUtc === undefined ? 9 : options.hourUtc;
  const logger = options.logger;
  let lastRunDay = null;
  let running = false;

  const tick = async () => {
    const now = options.now ? new Date(options.now) : new Date();
    const day = now.toISOString().slice(0, 10);
    if (running || day === lastRunDay || now.getUTCHours() !== hourUtc) return;
    running = true;
    lastRunDay = day;
    try {
      await runReengagementNudgeJob({ now, deps: options.deps, llm: options.llm }, { logger });
    } catch (err) {
      if (logger && logger.error) {
        logger.error('reengagement_scheduler_failed', {
          error: err && err.message ? err.message : String(err)
        });
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

export default { jobs, runReengagementNudgeJob, startReengagementScheduler, JOB_NAME, SCHEDULE };
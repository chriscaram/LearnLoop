// Trigger for the re-engagement agent (flag: ga-find_a431764685ac).
//
// Two application-code entry points, both no-ops while the flag is off:
//  * `reengagementJobs` — merge into the learning service handler's jobs map,
//    the same pattern billing uses for its renewal job (event.job routing in
//    packages/shared/src/http.js -> createHandler).
//  * `startReengagementScheduler()` — a minimal in-process daily scheduler
//    (09:00 UTC) for long-running/dev processes.
import { runReengagementNudges, FLAG_KEY, AGENT_NAME } from "./reengagement.js";

export const REENGAGEMENT_JOB_NAME = AGENT_NAME;

// Jobs map entry: `jobs: { ...reengagementJobs }` on the learning handler.
export const reengagementJobs = {
  [AGENT_NAME]: (event = {}, context = {}) =>
    runReengagementNudges({ log: context.log ?? event.log ?? null })
};

const DEFAULT_HOUR_UTC = 9; // 0 9 * * * (daily, 09:00 UTC)
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

export function startReengagementScheduler(options = {}) {
  const hourUtc = options.hourUtc ?? DEFAULT_HOUR_UTC;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const clock = options.now ?? (() => new Date());
  let lastRunDay = null;

  const tick = async () => {
    const now = clock();
    const day = now.toISOString().slice(0, 10);
    if (now.getUTCHours() !== hourUtc || lastRunDay === day) return null;
    lastRunDay = day;
    try {
      // The flag check lives inside runReengagementNudges: off -> no-op.
      return await runReengagementNudges({ ...options, now });
    } catch (err) {
      if (options.log && typeof options.log.error === "function") {
        options.log.error({ flag: FLAG_KEY, err: String(err) }, "reengagement scheduler failed");
      }
      return null;
    }
  };

  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return { stop: () => clearInterval(timer), tick };
}

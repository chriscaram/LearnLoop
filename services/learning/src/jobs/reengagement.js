/**
 * Daily scheduled job (09:00 UTC) for the re-engagement nudge agent
 * (finding find_a431764685ac). Registered in the learning service handler's
 * jobs map, the same in-app pattern as services/billing/src/jobs/renewals.js.
 *
 * Does nothing at all while the feature flag "ga-find_a431764685ac" is off.
 */

import {
  FLAG_KEY,
  runReengagementAgent,
  defaultFlagEnabled
} from "../agents/reengagementAgent.js";

/** Existing deterministic send path: notifications inbox + SES email. */
async function loadDelivery() {
  const delivery = {};
  for (const spec of [
    "@learnloop/notifications/src/services/inbox.js",
    "../../../notifications/src/services/inbox.js"
  ]) {
    try {
      const mod = await import(spec);
      if (typeof mod.createNotification === "function") {
        delivery.createNotification = mod.createNotification;
        if (typeof mod.listNotifications === "function") {
          delivery.listNotifications = mod.listNotifications;
        }
        break;
      }
    } catch (err) {
      // try the next specifier
    }
  }
  for (const spec of [
    "@learnloop/notifications/src/services/email.js",
    "../../../notifications/src/services/email.js"
  ]) {
    try {
      const mod = await import(spec);
      if (typeof mod.sendEmail === "function") {
        delivery.sendEmail = mod.sendEmail;
        break;
      }
    } catch (err) {
      // try the next specifier
    }
  }
  return delivery;
}

/** Learners to scan - enrolment is re-checked deterministically per learner. */
async function loadLearners() {
  for (const spec of [
    "@learnloop/admin/src/repositories/learners.js",
    "../../../admin/src/repositories/learners.js"
  ]) {
    try {
      const mod = await import(spec);
      const fn = mod.listLearners || mod.listAllLearners || mod.listUsers;
      if (typeof fn === "function") {
        const learners = await fn();
        if (Array.isArray(learners)) return learners;
      }
    } catch (err) {
      // try the next specifier
    }
  }
  return [];
}

/**
 * Job entry point. `context.log` is used when the shared handler provides it.
 */
export async function sendReengagementNudges(input = {}, context = {}) {
  const logger = context.log || input.log || console;

  if (!(await (input.flagEnabled || defaultFlagEnabled)(FLAG_KEY))) {
    logger.info?.({ event: "reengagement_job_skipped", flag: FLAG_KEY });
    return { enabled: false, sent: 0, considered: 0, skipped: 0 };
  }

  const delivery = await loadDelivery();
  const learners = Array.isArray(input.learners)
    ? input.learners
    : await loadLearners();

  return runReengagementAgent({
    learners,
    now: input.now ? new Date(input.now) : new Date(),
    createNotification: input.createNotification || delivery.createNotification,
    sendEmail: input.sendEmail || delivery.sendEmail,
    listRecentNotifications:
      input.listRecentNotifications ||
      (delivery.listNotifications
        ? (userId) => delivery.listNotifications(userId)
        : undefined),
    logger
  });
}

export default sendReengagementNudges;
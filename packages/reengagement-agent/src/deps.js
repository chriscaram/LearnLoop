/**
 * Adapters over the EXISTING deterministic code the agent must use.
 *
 * Nothing here computes a business number: every value comes from the
 * functions already in the services (see the blueprint's deterministic parts):
 *
 *   services/learning/src/services/progress.js
 *     - listProgressOverview   (per-course progress list per learner)
 *     - daysSinceLastActivity  (whole days since last lesson activity)
 *     - completionPercent      (completion percentage by lesson duration)
 *     - nextLessonFor          (exact next uncompleted lesson in course order)
 *   services/learning/src/repositories/enrolments.js
 *     - listEnrolledCourseIds  (enrolment check)
 *   services/notifications/src/services/inbox.js
 *     - createNotification     (type allowlist, truncation, logging)
 *   services/notifications/src/services/email.js
 *     - sendEmail              (rendering + SES delivery + email_sent log)
 *
 * Every dependency is injectable so tests run with no network and no AWS call.
 */

export const FLAG_KEY = 'ga-find_a431764685ac';

const LEARNING_PROGRESS = '../../../services/learning/src/services/progress.js';
const LEARNING_ENROLMENTS = '../../../services/learning/src/repositories/enrolments.js';
const NOTIFICATIONS_INBOX = '../../../services/notifications/src/services/inbox.js';
const NOTIFICATIONS_EMAIL = '../../../services/notifications/src/services/email.js';
const NOTIFICATIONS_REPO = '../../../services/notifications/src/repositories/notifications.js';
const IDENTITY_USERS = '../../../services/identity/src/repositories/users.js';
const SHARED_FLAGS = '../../shared/src/flags.js';

async function load(specifier) {
  try {
    return await import(new URL(specifier, import.meta.url).href);
  } catch {
    return null;
  }
}

function pick(mod, names) {
  if (!mod) return null;
  const candidates = [mod, mod.default].filter(Boolean);
  for (const candidate of candidates) {
    for (const name of names) {
      const value = candidate[name];
      if (typeof value === 'function') return value.bind(candidate);
    }
  }
  return null;
}

/** Reads the feature flag through the shared flags client, env as fallback. */
export async function makeFlagReader() {
  const mod = await load(SHARED_FLAGS);
  const fn = pick(mod, ['isFlagEnabled', 'isEnabled', 'getFlag', 'readFlag', 'flagEnabled']);
  return async function isFlagEnabled(key = FLAG_KEY) {
    if (fn) {
      try {
        const value = await fn(key);
        if (typeof value === 'boolean') return value;
        if (value && typeof value === 'object' && 'enabled' in value) return value.enabled === true;
        if (typeof value === 'string') return value === 'true' || value === 'on' || value === '1';
        if (value === undefined || value === null) return false;
        return Boolean(value);
      } catch {
        return false;
      }
    }
    const env = process.env;
    const raw = env[key] ?? env['FLAG_' + key.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()];
    return raw === 'true' || raw === 'on' || raw === '1';
  };
}

/**
 * Resolves the deterministic dependencies, letting callers (and tests)
 * override any of them.
 */
export async function resolveDeps(overrides = {}) {
  const [progressMod, enrolmentsMod, inboxMod, emailMod, notificationsMod, usersMod] =
    await Promise.all([
      load(LEARNING_PROGRESS),
      load(LEARNING_ENROLMENTS),
      load(NOTIFICATIONS_INBOX),
      load(NOTIFICATIONS_EMAIL),
      load(NOTIFICATIONS_REPO),
      load(IDENTITY_USERS)
    ]);

  const listUsers = pick(usersMod, ['listUsers', 'listAllUsers', 'allUsers', 'list']);
  const listNotificationsFn = pick(notificationsMod, [
    'listNotifications',
    'listForUser',
    'listByUser',
    'list'
  ]);

  const deps = {
    isFlagEnabled: overrides.isFlagEnabled || (await makeFlagReader()),

    // learning service
    listProgressOverview:
      overrides.listProgressOverview || pick(progressMod, ['listProgressOverview']),
    daysSinceLastActivity:
      overrides.daysSinceLastActivity || pick(progressMod, ['daysSinceLastActivity']),
    completionPercent: overrides.completionPercent || pick(progressMod, ['completionPercent']),
    nextLessonFor: overrides.nextLessonFor || pick(progressMod, ['nextLessonFor']),
    listEnrolledCourseIds:
      overrides.listEnrolledCourseIds || pick(enrolmentsMod, ['listEnrolledCourseIds']),

    // notifications service
    createNotification: overrides.createNotification || pick(inboxMod, ['createNotification']),
    sendEmail: overrides.sendEmail || pick(emailMod, ['sendEmail']),
    listNotifications: overrides.listNotifications || listNotificationsFn,

    // learner population
    listLearnerIds:
      overrides.listLearnerIds ||
      (listUsers
        ? async () => {
            const users = (await listUsers()) || [];
            return users
              .filter((u) => !u.role || String(u.role).toLowerCase() === 'learner')
              .map((u) => ({
                id: u.id || u.user_id || u.userId,
                email: u.email,
                name: u.name || u.full_name
              }))
              .filter((u) => u.id);
          }
        : null)
  };

  return { ...deps, ...overrides };
}

/** The deterministic functions that must exist for the agent to run at all. */
export const REQUIRED_DEPS = [
  'listLearnerIds',
  'listEnrolledCourseIds',
  'listProgressOverview',
  'daysSinceLastActivity',
  'completionPercent',
  'nextLessonFor',
  'createNotification',
  'sendEmail',
  'listNotifications'
];

export function missingDeps(deps) {
  return REQUIRED_DEPS.filter((name) => typeof deps[name] !== 'function');
}
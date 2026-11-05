// Runtime configuration, read from the environment on every call so tests can
// change it. Defaults are the local-development values.
export function getConfig() {
  const env = process.env;
  return {
    environment: env.APP_ENV ?? 'dev',
    version: env.APP_VERSION ?? 'dev',
    stateBucket: env.STATE_BUCKET ?? '',
    flagsParameter: env.FLAGS_PARAMETER ?? '/learnloop/prod/feature-flags',
    // Secrets Manager secret names (the env var names are part of the deployment contract)
    saltSecret: env.LOG_PSEUDONYM_SALT_PARAMETER ?? 'learnloop/prod/log-pseudonym-salt',
    jwtSecret: env.JWT_SECRET_PARAMETER ?? 'learnloop/prod/jwt-secret',
    sesSender: env.SES_SENDER ?? 'no-reply@example.com',
    emailRecipientOverride: env.EMAIL_RECIPIENT_OVERRIDE ?? '',
    seedDir: env.SEED_DIR ?? '',
  };
}

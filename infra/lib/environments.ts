/**
 * Deployment names shared by the app stack and the GitHub OIDC deploy role.
 *
 * The independent deployments of LearnLoop. Each one is its own stack with its
 * own buckets, functions, secrets, flags and state; the same code runs in all of
 * them because everything it reads at runtime is passed in by the stack.
 */
export const ENVIRONMENTS = {
  prod: { stackName: 'LearnLoopProd', applicationTag: 'learnloop' },
  staging: { stackName: 'LearnLoopStaging', applicationTag: 'learnloop-staging' },
} as const;
export type EnvironmentName = keyof typeof ENVIRONMENTS;
export const DEFAULT_ENVIRONMENT: EnvironmentName = 'prod';

/** Resource name prefix: learnloop-<environment> (learnloop-prod, learnloop-staging). */
export const resourcePrefix = (environment: EnvironmentName) => `learnloop-${environment}`;

export const parameterNames = (environment: EnvironmentName) => ({
  flags: `/learnloop/${environment}/feature-flags`,
});

export const secretNames = (environment: EnvironmentName) => ({
  jwtSecret: `learnloop/${environment}/jwt-secret`,
  salt: `learnloop/${environment}/log-pseudonym-salt`,
});

export const PARAMETER_NAMES = parameterNames('prod');
export const SECRET_NAMES = secretNames('prod');

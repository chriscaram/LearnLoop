// Secrets (JWT signing secret, log pseudonym salt) from Secrets Manager, cached
// for the lifetime of the Lambda execution environment.
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { getSecretsClient } from './aws.js';
import { getConfig } from './config.js';

const cache = new Map();

export async function getSecret(secretId) {
  if (!cache.has(secretId)) {
    const pending = getSecretsClient()
      .send(new GetSecretValueCommand({ SecretId: secretId }))
      .then((out) => out.SecretString);
    cache.set(secretId, pending);
    pending.catch(() => cache.delete(secretId));
  }
  return cache.get(secretId);
}

export const getJwtSecret = () => getSecret(getConfig().jwtSecret);
export const getPseudonymSalt = () => getSecret(getConfig().saltSecret);

export function clearParameterCache() {
  cache.clear();
}

// Lazily created AWS SDK v3 clients. Tests and the local dev server replace
// them with fakes through setAwsClients(); nothing here talks to AWS at import time.
import { S3Client } from '@aws-sdk/client-s3';
import { SSMClient } from '@aws-sdk/client-ssm';
import { SESClient } from '@aws-sdk/client-ses';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const overrides = {};
const created = {};

export function setAwsClients(clients) {
  Object.assign(overrides, clients);
}

export function resetAwsClients() {
  for (const key of Object.keys(overrides)) delete overrides[key];
}

function client(name, factory) {
  if (overrides[name]) return overrides[name];
  created[name] ??= factory();
  return created[name];
}

export const getS3Client = () => client('s3', () => new S3Client({}));
export const getSsmClient = () => client('ssm', () => new SSMClient({}));
export const getSesClient = () => client('ses', () => new SESClient({}));
export const getSecretsClient = () => client('secrets', () => new SecretsManagerClient({}));

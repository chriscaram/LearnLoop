import { getStore } from '@learnloop/shared/store';

// organizations.json: [{ id, name, created_at }] - the enterprise customer accounts
// whose employees learn on LearnLoop.

export async function listOrganizations() {
  return getStore().read('organizations');
}

export async function findOrganizationById(organizationId) {
  return (await getStore().read('organizations')).find((o) => o.id === organizationId) ?? null;
}

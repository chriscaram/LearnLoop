import { getStore } from '@learnloop/shared/store';

export async function findUserById(userId) {
  return (await getStore().read('users')).find((u) => u.id === userId) ?? null;
}

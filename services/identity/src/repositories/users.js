import { getStore } from '@learnloop/shared/store';

export async function findUserByEmail(email) {
  const normalised = String(email ?? '').trim().toLowerCase();
  const users = await getStore().read('users');
  return users.find((user) => user.email === normalised) ?? null;
}

export async function findUserById(userId) {
  const users = await getStore().read('users');
  return users.find((user) => user.id === userId) ?? null;
}

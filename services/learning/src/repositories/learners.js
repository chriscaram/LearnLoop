import { getStore } from '@learnloop/shared/store';

export async function listLearners() {
  return (await getStore().read('users'))
    .filter((u) => u.role === 'learner')
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function findLearnerById(userId) {
  return (await getStore().read('users')).find((u) => u.id === userId && u.role === 'learner') ?? null;
}
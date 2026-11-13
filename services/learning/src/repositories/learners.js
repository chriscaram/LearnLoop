import { getStore } from '@learnloop/shared/store';

export async function listLearners() {
  return (await getStore().read('users')).filter((u) => u.role === 'learner');
}
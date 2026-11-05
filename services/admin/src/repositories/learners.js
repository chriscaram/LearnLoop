import { getStore } from '@learnloop/shared/store';

export async function listUsersByRole(role) {
  return (await getStore().read('users')).filter((u) => u.role === role);
}

export async function findUserById(userId) {
  return (await getStore().read('users')).find((u) => u.id === userId) ?? null;
}

export async function listSubscriptions() {
  return getStore().read('subscriptions');
}

export async function listEnrolments() {
  return getStore().read('enrolments');
}

export async function listCourses() {
  return getStore().read('courses');
}

import { timingSafeEqual } from 'node:crypto';
import { issueSessionToken } from '@learnloop/shared/auth';
import { findUserByEmail, findUserById } from '../repositories/users.js';

/** Every demo account shares this password. */
export const DEMO_PASSWORD = 'learnloop-demo';

export function passwordMatches(password) {
  const given = Buffer.from(String(password ?? ''));
  const expected = Buffer.from(DEMO_PASSWORD);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The user for valid credentials, otherwise null. */
export async function verifyCredentials(email, password) {
  const user = await findUserByEmail(email);
  if (!user || !passwordMatches(password)) return null;
  return user;
}

export function createSession(user, secret, nowSeconds) {
  return issueSessionToken({ userId: user.id, role: user.role }, secret, nowSeconds);
}

export function toPublicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

export async function getCurrentUser(userId) {
  const user = await findUserById(userId);
  return user ? toPublicUser(user) : null;
}

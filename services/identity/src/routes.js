import { clearedSessionCookie, sessionCookie } from '@learnloop/shared/auth';
import { HttpError, notFound, ok } from '@learnloop/shared/http';
import { bindUser, logEvent } from '@learnloop/shared/logger';
import { getJwtSecret } from '@learnloop/shared/params';
import { createSession, getCurrentUser, toPublicUser, verifyCredentials } from './services/auth.js';

async function login({ body, now }) {
  const user = await verifyCredentials(body.email, body.password);
  if (!user) {
    logEvent({ event: 'sign_in_failed', outcome: 'failed', errorType: 'invalid_credentials', actorType: 'learner' });
    throw new HttpError(401, 'invalid_credentials');
  }
  const { token, sessionId } = createSession(user, await getJwtSecret(), Math.floor(now.getTime() / 1000));
  bindUser({ userId: user.id, sessionId, role: user.role });
  logEvent({ event: 'user_signed_in' });
  return ok({ user: toPublicUser(user) }, { cookies: [sessionCookie(token)] });
}

async function logout({ user }) {
  if (user) logEvent({ event: 'user_signed_out' });
  return ok({ signedOut: true }, { cookies: [clearedSessionCookie()] });
}

async function me({ user }) {
  const current = await getCurrentUser(user.userId);
  if (!current) throw notFound('user_not_found');
  return ok({ user: current });
}

export const routes = [
  { method: 'POST', path: '/api/auth/login', auth: 'public', handler: login },
  { method: 'POST', path: '/api/auth/logout', auth: 'public', handler: logout },
  { method: 'GET', path: '/api/me', auth: 'user', handler: me },
];

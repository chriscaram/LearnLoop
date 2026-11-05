// Session tokens: compact JWS (HS256) signed with the secret from SSM,
// carried in an HttpOnly cookie.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getJwtSecret } from './params.js';

export const SESSION_COOKIE = 'll_session';
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function signJwt(payload, secret) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

/** Returns the payload when the signature is valid and the token not expired, else null. */
export function verifyJwt(token, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  const actual = Buffer.from(parts[2], 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (header.alg !== 'HS256') return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number' || payload.exp <= nowSeconds) return null;
    return payload;
  } catch {
    return null;
  }
}

export function newSessionId() {
  return `ses_${randomBytes(8).toString('hex')}`;
}

export function issueSessionToken({ userId, role }, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  const sessionId = newSessionId();
  const token = signJwt({ sub: userId, role, sid: sessionId, iat: nowSeconds, exp: nowSeconds + SESSION_TTL_SECONDS }, secret);
  return { token, sessionId };
}

export function parseCookies(event) {
  const pairs = [...(event.cookies ?? [])];
  const header = event.headers?.cookie ?? event.headers?.Cookie;
  if (header) pairs.push(...header.split(';'));
  const cookies = {};
  for (const pair of pairs) {
    const index = pair.indexOf('=');
    if (index < 0) continue;
    cookies[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
  }
  return cookies;
}

export function sessionCookie(token) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function clearedSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** Resolve the caller from the session cookie: { userId, role, sessionId } or null. */
export async function authenticate(event) {
  const token = parseCookies(event)[SESSION_COOKIE];
  if (!token) return null;
  const payload = verifyJwt(token, await getJwtSecret());
  if (!payload) return null;
  return { userId: payload.sub, role: payload.role, sessionId: payload.sid };
}

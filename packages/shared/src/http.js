// Lambda entry point shared by all services: API Gateway HTTP API (payload
// format 2.0) in, JSON out, one request log line per request.
import { randomUUID } from 'node:crypto';
import { authenticate } from './auth.js';
import { getConfig } from './config.js';
import { getPseudonymSalt } from './params.js';
import { logError, logRequest, runWithLogContext, traceIdFromHeaders } from './logger.js';

export class HttpError extends Error {
  constructor(status, code, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (code = 'bad_request') => new HttpError(400, code);
export const notFound = (code = 'not_found') => new HttpError(404, code);
export const forbidden = (code = 'forbidden') => new HttpError(403, code);
export const conflict = (code = 'conflict') => new HttpError(409, code);

/** A handler result: { status, body, cookies? } */
export function ok(body, extra = {}) {
  return { status: 200, body, ...extra };
}

/** Respond this long before the Lambda deadline so the request line is always written. */
export const DEADLINE_MARGIN_MS = 500;

function withDeadline(promise, context) {
  const remaining = typeof context.getRemainingTimeInMillis === 'function' ? context.getRemainingTimeInMillis() : null;
  if (remaining === null) return promise;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new HttpError(504, 'timeout')), Math.max(0, remaining - DEADLINE_MARGIN_MS));
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export function routeKey(route) {
  return `${route.method} ${route.path}`;
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw badRequest('invalid_json');
  }
}

function lowerHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
}

function toResponse({ status, body, cookies }) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    cookies: cookies ?? [],
    body: JSON.stringify(body ?? {}),
  };
}

/**
 * routes: [{ method, path, auth: 'public'|'user'|'staff', handler(req) }]
 * jobs:   { name: async (now) => void } for scheduled (EventBridge) invocations
 * { listJobs: true } returns { jobs: [<registered job names>] } and does nothing else.
 */
export function createHandler({ service, routes, jobs = {} }) {
  const table = new Map(routes.map((route) => [routeKey(route), route]));

  return async function handler(event, context = {}) {
    // Deploy tooling asks which scheduled jobs this build registers; nothing else runs.
    if (event?.listJobs === true) return { jobs: Object.keys(jobs) };

    const config = getConfig();
    const base = { service, version: config.version, environment: config.environment };

    if (event?.job) {
      const job = jobs[event.job];
      const ctx = { ...base, traceId: traceIdFromHeaders({}), requestId: context.awsRequestId ?? randomUUID(), role: 'system' };
      ctx.salt = await getPseudonymSalt();
      return runWithLogContext(ctx, async () => {
        if (!job) {
          logError('unknown scheduled job', { errorType: 'UnknownJob' });
          return { ok: false };
        }
        await job(new Date());
        return { ok: true };
      });
    }

    const started = performance.now();
    const headers = lowerHeaders(event.headers);
    const route = table.get(event.routeKey);
    const ctx = {
      ...base,
      traceId: traceIdFromHeaders(headers),
      requestId: event.requestContext?.requestId ?? randomUUID(),
    };

    return runWithLogContext(ctx, async () => {
      let result;
      try {
        ctx.salt = await getPseudonymSalt();
        const session = await authenticate({ ...event, headers });
        if (session) Object.assign(ctx, session);
        if (!route) throw notFound('route_not_found');
        if (route.auth !== 'public' && !session) throw new HttpError(401, 'unauthenticated');
        if (route.auth === 'staff' && session.role !== 'staff') throw forbidden();
        result = await withDeadline(route.handler({
          params: event.pathParameters ?? {},
          query: event.queryStringParameters ?? {},
          body: ['POST', 'PUT', 'PATCH'].includes(route.method) ? parseBody(event) : {},
          user: session,
          headers,
          now: new Date(),
        }), context);
      } catch (error) {
        if (error instanceof HttpError) {
          if (error.status === 504) logError('request exceeded the function deadline', { errorType: 'Timeout' });
          result = { status: error.status, body: { error: error.code } };
        } else {
          logError('unhandled error', { errorType: error?.name ?? 'Error' });
          result = { status: 500, body: { error: 'internal_error' } };
        }
      }
      logRequest({
        method: route?.method ?? event.requestContext?.http?.method ?? 'GET',
        route: route?.path ?? 'unmatched',
        statusCode: result.status,
        latencyMs: performance.now() - started,
        userAgent: headers['user-agent'],
      });
      return toResponse(result);
    });
  };
}

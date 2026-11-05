// Runs every service handler in one Node process behind a tiny router that
// mimics API Gateway HTTP API (payload format 2.0). State is in memory (loaded
// from data/seed/), SSM, Secrets Manager and SES are faked, logs go to stdout.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { setAwsClients } from '@learnloop/shared/aws';
import { MemoryStateStore, setStore } from '@learnloop/shared/store';
import { FakeSecrets, FakeSes, FakeSsm, defaultParameters, defaultSecrets } from '@learnloop/shared/testing';
import * as identity from '@learnloop/identity';
import * as identityRoutes from '@learnloop/identity/routes';
import * as catalog from '@learnloop/catalog';
import * as catalogRoutes from '@learnloop/catalog/routes';
import * as learning from '@learnloop/learning';
import * as learningRoutes from '@learnloop/learning/routes';
import * as billing from '@learnloop/billing';
import * as billingRoutes from '@learnloop/billing/routes';
import * as notifications from '@learnloop/notifications';
import * as notificationsRoutes from '@learnloop/notifications/routes';
import * as admin from '@learnloop/admin';
import * as adminRoutes from '@learnloop/admin/routes';

const SERVICES = [
  [identity.handler, identityRoutes.routes],
  [catalog.handler, catalogRoutes.routes],
  [learning.handler, learningRoutes.routes],
  [billing.handler, billingRoutes.routes],
  [notifications.handler, notificationsRoutes.routes],
  [admin.handler, adminRoutes.routes],
];

function compile(path) {
  const names = [];
  const pattern = path.replace(/\{([a-zA-Z]+)\}/g, (_, name) => {
    names.push(name);
    return '([^/]+)';
  });
  return { regex: new RegExp(`^${pattern}$`), names };
}

/** All routes from all services, most specific (fewest parameters) first. */
export function buildRouteTable() {
  const table = [];
  for (const [handler, routes] of SERVICES) {
    for (const route of routes) table.push({ ...route, handler, ...compile(route.path) });
  }
  return table.sort((a, b) => a.names.length - b.names.length);
}

export function matchRoute(table, method, path) {
  for (const route of table) {
    if (route.method !== method) continue;
    const m = route.regex.exec(path);
    if (m) return { route, pathParameters: Object.fromEntries(route.names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

export function configureLocalEnvironment({ flags = { new_catalog_filters: { enabled: true } } } = {}) {
  process.env.APP_ENV ??= 'dev';
  process.env.APP_VERSION ??= 'dev';
  setAwsClients({ ssm: new FakeSsm(defaultParameters({ flags })), secrets: new FakeSecrets(defaultSecrets()), ses: new FakeSes() });
  setStore(new MemoryStateStore());
}

export function createDevServer() {
  const table = buildRouteTable();
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const match = matchRoute(table, req.method, url.pathname);
    const event = {
      version: '2.0',
      routeKey: match ? `${match.route.method} ${match.route.path}` : '$default',
      rawPath: url.pathname,
      rawQueryString: url.search.slice(1),
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v])),
      cookies: req.headers.cookie ? req.headers.cookie.split(';').map((c) => c.trim()) : undefined,
      queryStringParameters: Object.fromEntries(url.searchParams),
      pathParameters: match?.pathParameters,
      requestContext: { requestId: randomBytes(10).toString('base64').slice(0, 15) + '=', http: { method: req.method, path: url.pathname } },
      body: chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined,
      isBase64Encoded: false,
    };
    const handler = match?.route.handler ?? SERVICES[0][0];
    const out = await handler(event, {});
    res.statusCode = out.statusCode;
    for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v);
    if (out.cookies?.length) res.setHeader('set-cookie', out.cookies);
    res.end(out.body);
  });
}

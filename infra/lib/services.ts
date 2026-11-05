// The deployable services and their route tables. Routes are read from each
// service's own routes.js so API Gateway and the code cannot drift apart.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { routes as identity } from '../../services/identity/src/routes.js';
import { routes as catalog } from '../../services/catalog/src/routes.js';
import { routes as learning } from '../../services/learning/src/routes.js';
import { routes as billing } from '../../services/billing/src/routes.js';
import { routes as notifications } from '../../services/notifications/src/routes.js';
import { routes as admin } from '../../services/admin/src/routes.js';

export interface RouteDefinition {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
}

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const SERVICES: Record<string, RouteDefinition[]> = {
  identity, catalog, learning, billing, notifications, admin,
};

export const serviceEntry = (service: string) => path.join(REPO_ROOT, 'services', service, 'src/handler.js');

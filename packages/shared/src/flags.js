// Feature flags: a JSON map { "<flagKey>": { "enabled": bool } } stored in one
// SSM parameter. This is the standard way LearnLoop ships features dark.
import { GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { getSsmClient } from './aws.js';
import { getConfig } from './config.js';
import { logWarn } from './logger.js';

export const FLAG_CACHE_MS = 30_000;

/** Flags the app knows about, with a short description for the admin page. */
export const KNOWN_FLAGS = Object.freeze({
  new_catalog_filters: 'Category filter on the course catalog',
});

let cache = null; // { loadedAt, map }

export function resetFlagCache() {
  cache = null;
}

async function readFlagMap({ fresh = false, now = Date.now() } = {}) {
  if (!fresh && cache && now - cache.loadedAt < FLAG_CACHE_MS) return cache.map;
  const out = await getSsmClient().send(new GetParameterCommand({ Name: getConfig().flagsParameter }));
  const parsed = JSON.parse(out.Parameter?.Value ?? '{}');
  const map = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  cache = { loadedAt: now, map };
  return map;
}

/**
 * True only when the flag exists and is enabled. Unknown keys and read
 * failures return false; this function never throws.
 * The options object is accepted for call-site symmetry ({ userId }).
 */
export async function isEnabled(flagKey, { userId } = {}) {
  void userId;
  try {
    const map = await readFlagMap();
    return map[flagKey]?.enabled === true;
  } catch (error) {
    logWarn('feature flag read failed', { errorType: error?.name ?? 'Error' });
    return false;
  }
}

/** All flags: every known flag plus anything else present in the parameter. */
export async function listFlags() {
  const map = await readFlagMap({ fresh: true });
  const keys = new Set([...Object.keys(KNOWN_FLAGS), ...Object.keys(map)]);
  return [...keys].sort().map((key) => ({
    key,
    enabled: map[key]?.enabled === true,
    description: KNOWN_FLAGS[key] ?? '',
  }));
}

export async function setFlag(flagKey, enabled) {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(flagKey)) throw new TypeError(`invalid flag key: ${flagKey}`);
  let map = {};
  try {
    map = { ...(await readFlagMap({ fresh: true })) };
  } catch (error) {
    if (error?.name !== 'ParameterNotFound') throw error;
  }
  map[flagKey] = { enabled: Boolean(enabled) };
  await getSsmClient().send(new PutParameterCommand({
    Name: getConfig().flagsParameter,
    Value: JSON.stringify(map),
    Type: 'String',
    Overwrite: true,
  }));
  cache = { loadedAt: Date.now(), map };
  return { key: flagKey, enabled: Boolean(enabled) };
}

import { badRequest } from '@learnloop/shared/http';
import { listFlags, setFlag } from '@learnloop/shared/flags';
import { logEvent } from '@learnloop/shared/logger';

export async function getFlags() {
  return listFlags();
}

export async function updateFlag(flagKey, enabled) {
  if (typeof enabled !== 'boolean') throw badRequest('enabled_must_be_boolean');
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(flagKey ?? '')) throw badRequest('invalid_flag_key');
  const result = await setFlag(flagKey, enabled);
  logEvent({ event: 'feature_flag_changed', entityType: 'feature_flag', entityId: flagKey, actorType: 'staff' });
  return result;
}

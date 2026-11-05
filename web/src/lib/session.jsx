import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';

const SessionContext = createContext(null);

/** Signed-in user plus a per-visit cache of /api/me/progress. */
export function SessionProvider({ children }) {
  const [user, setUser] = useState(undefined); // undefined = loading, null = signed out
  const [progress, setProgress] = useState(null);
  const progressRequest = useRef(null);

  useEffect(() => {
    api('/api/me').then((d) => setUser(d.user)).catch(() => setUser(null));
  }, []);

  const login = useCallback(async (email, password) => {
    const d = await api('/api/auth/login', { method: 'POST', body: { email, password } });
    setUser(d.user);
    return d.user;
  }, []);

  const logout = useCallback(async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
    setProgress(null);
  }, []);

  const loadProgress = useCallback(async ({ force = false } = {}) => {
    if (!force && progress) return progress;
    if (!force && progressRequest.current) return progressRequest.current;
    progressRequest.current = api('/api/me/progress').then((d) => {
      setProgress(d.courses);
      return d.courses;
    }).finally(() => { progressRequest.current = null; });
    return progressRequest.current;
  }, [progress]);

  const invalidateProgress = useCallback(() => setProgress(null), []);

  const value = useMemo(() => ({ user, login, logout, progress, loadProgress, invalidateProgress }),
    [user, login, logout, progress, loadProgress, invalidateProgress]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);

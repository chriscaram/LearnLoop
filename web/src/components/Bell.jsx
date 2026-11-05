import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { formatDate } from '../lib/format.js';

const POLL_MS = 30_000;

export function Bell() {
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState(null);
  const ref = useRef(null);
  const navigate = useNavigate();

  const refreshCount = useCallback(() => {
    api('/api/me/notifications/unread-count').then((d) => setUnread(d.unread)).catch(() => {});
  }, []);

  useEffect(() => {
    refreshCount();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') refreshCount();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [refreshCount]);

  useEffect(() => {
    if (!open) return undefined;
    api('/api/me/notifications?limit=5').then((d) => { setItems(d.notifications); setUnread(d.unread); }).catch(() => setItems([]));
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', onKey); };
  }, [open]);

  async function openItem(n) {
    if (!n.read) {
      await api(`/api/me/notifications/${n.id}/read`, { method: 'POST' }).catch(() => {});
      setUnread((u) => Math.max(0, u - 1));
    }
    setOpen(false);
    navigate(n.link ?? '/notifications');
  }

  return (
    <div className="bell" ref={ref}>
      <button
        type="button"
        className="icon-button"
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unread > 0 && <span className="badge">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="dropdown" role="menu">
          <div className="dropdown-header">Notifications</div>
          {items === null && <p className="muted pad">Loading…</p>}
          {items?.length === 0 && <p className="muted pad">You have no notifications.</p>}
          <ul>
            {items?.map((n) => (
              <li key={n.id}>
                <button type="button" role="menuitem" className={`notification-row${n.read ? '' : ' unread'}`} onClick={() => openItem(n)}>
                  <span className="notification-title">{n.title}</span>
                  <span className="muted small">{formatDate(n.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
          <Link className="dropdown-footer" to="/notifications" onClick={() => setOpen(false)}>View all notifications</Link>
        </div>
      )}
    </div>
  );
}

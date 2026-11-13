import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { formatDate } from '../lib/format.js';
import { ErrorNote, Loading, PageTitle } from '../components/ui.jsx';

export function NotificationsPage() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    api('/api/me/notifications').then((d) => setItems(d.notifications)).catch(() => setError(true));
  }, []);

  async function markRead(id) {
    await api(`/api/me/notifications/${id}/read`, { method: 'POST' }).catch(() => {});
    setItems((list) => list.map((n) => (n.id === id ? { ...n, read: true } : n)));
  }

  return (
    <>
      <PageTitle title="Notifications" />
      {error && <ErrorNote>Notifications could not be loaded.</ErrorNote>}
      {!items && !error && <Loading />}
      {items?.length === 0 && <p className="muted">You have no notifications.</p>}
      <ul className="notification-list">
        {items?.map((n) => (
          <li key={n.id} className={`card${n.read ? '' : ' unread'}`}>
            <div className="notification-head">
              <h2 className="h3">{n.title}</h2>
              <span className="muted small">{formatDate(n.createdAt)}</span>
            </div>
            {n.appliedByAgent && <p className="muted small">Applied by agent</p>}
            <p>{n.body}</p>
            <div className="row">
              {n.link && n.link !== '/notifications' && <Link to={n.link} onClick={() => !n.read && markRead(n.id)}>Open</Link>}
              {!n.read && <button type="button" className="button ghost small" onClick={() => markRead(n.id)}>Mark as read</button>}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
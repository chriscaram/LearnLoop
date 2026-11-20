import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { ErrorNote, Loading, PageTitle } from '../components/ui.jsx';

const STATUS = { sent: 'Sent', opened: 'Opened', came_back: 'Came back', no_response: 'No response yet' };
const PAGE_SIZE = 10;
const RANGES = [['today', 'Today', 1], ['1w', '1W', 7], ['2w', '2W', 14], ['1m', '1M', 30], ['custom', 'Custom', null]];
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
const pct = (a, b) => (b ? Math.round((a * 100) / b) : 0);
const isoDay = (d) => d.toISOString().slice(0, 10);

function Ring({ label, part, whole }) {
  const r = 40;
  const c = 2 * Math.PI * r;
  const p = pct(part, whole);
  return (
    <figure className="card" style={{ textAlign: 'center', margin: 0 }}>
      <svg width="110" height="110" viewBox="0 0 100 100" role="img" aria-label={`${label}: ${part} of ${whole}, ${p}%`}>
        <circle cx="50" cy="50" r={r} fill="none" stroke="#e5e7eb" strokeWidth="10" />
        <circle cx="50" cy="50" r={r} fill="none" stroke="#5624d0" strokeWidth="10" strokeDasharray={`${(c * p) / 100} ${c}`} transform="rotate(-90 50 50)" />
        <text x="50" y="56" textAnchor="middle" fontSize="18">{p}%</text>
      </svg>
      <figcaption>{label}<br /><span className="muted small">{part} of {whole}</span></figcaption>
    </figure>
  );
}

function DailyChart({ daily }) {
  const today = isoDay(new Date());
  const [range, setRange] = useState('1w');
  const [custom, setCustom] = useState({ from: today, to: today });
  const rows = useMemo(() => {
    const span = RANGES.find(([k]) => k === range)[2];
    const to = new Date(`${range === 'custom' ? custom.to : today}T00:00:00Z`);
    const from = range === 'custom' ? new Date(`${custom.from}T00:00:00Z`) : new Date(to.getTime() - (span - 1) * 86_400_000);
    const byDay = new Map(daily.map((d) => [d.date, d]));
    const out = [];
    for (let d = from; d <= to && out.length < 366; d = new Date(d.getTime() + 86_400_000)) {
      out.push(byDay.get(isoDay(d)) ?? { date: isoDay(d), sent: 0, opened: 0, cameBack: 0 });
    }
    return out;
  }, [daily, range, custom, today]);
  const max = Math.max(1, ...rows.flatMap((r) => [r.sent, r.opened, r.cameBack]));
  const h = 120;
  const colors = { sent: '#9ca3af', opened: '#5624d0', cameBack: '#16a34a' };
  return (
    <div className="card">
      <div className="tabs" role="tablist" aria-label="Range">
        {RANGES.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={range === k} className={range === k ? 'active' : ''} onClick={() => setRange(k)}>{label}</button>)}
      </div>
      {range === 'custom' && (
        <div className="row">
          <label>From <input type="date" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} /></label>
          <label>To <input type="date" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} /></label>
        </div>
      )}
      <svg width={Math.max(rows.length * 24, 240)} height={h + 20} role="img" aria-label="Daily sent, opened and came back">
        {rows.map((r, i) => ['sent', 'opened', 'cameBack'].map((k, j) => {
          const bh = (r[k] / max) * h;
          return <rect key={`${r.date}-${k}`} x={i * 24 + j * 7} y={h - bh} width="6" height={bh} fill={colors[k]}><title>{`${r.date} ${k}: ${r[k]}`}</title></rect>;
        }))}
      </svg>
      <p className="muted small">Grey: sent · Purple: opened · Green: came back</p>
    </div>
  );
}

export function CartReminderOversightPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const [view, setView] = useState('people');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    api('/api/admin/agents/cart-reminders').then(setData).catch(() => setError(true));
  }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.people ?? []).filter((p) => (status === 'all' || p.status === status) && (!q || p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q)));
  }, [data, query, status]);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const person = data?.people.find((p) => p.userId === selected);

  return (
    <div data-ga-oversight="find_d8539d6d1401">
      <PageTitle title="AI cart reminders" />
      <p className="muted small"><Link to="/admin">Back to Admin</Link> · Read-only. Reminders the AI agent sent about courses left in the cart.</p>
      {error && <ErrorNote>The reminders could not be loaded.</ErrorNote>}
      {!data && !error && <Loading />}
      {data && !data.enabled && <p className="muted">The agent is switched off (flag ga-find_d8539d6d1401).</p>}
      {data && (
        <>
          <div className="tabs" role="tablist" aria-label="Views">
            {[['people', 'People'], ['stats', 'Stats']].map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={view === k} className={view === k ? 'active' : ''} onClick={() => setView(k)}>{label}</button>)}
          </div>
          {view === 'stats' ? (
            <>
              <div className="row">
                <Ring label="Opened out of sent" part={data.totals.opened} whole={data.totals.sent} />
                <Ring label="Came back out of opened" part={data.totals.cameBack} whole={data.totals.opened} />
              </div>
              <DailyChart daily={data.daily} />
            </>
          ) : (
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <div style={{ flex: 1 }}>
                <div className="row space">
                  <input type="search" aria-label="Search people" placeholder="Search by name or email" value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }} />
                  <select aria-label="Filter by status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }}>
                    <option value="all">All statuses</option>
                    {Object.entries(STATUS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                  </select>
                </div>
                {shown.length === 0 && <p className="muted">No one contacted yet.</p>}
                <ul className="notification-list">
                  {shown.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((p) => (
                    <li key={p.userId} className="card">
                      <button type="button" className="button ghost small" aria-pressed={selected === p.userId} onClick={() => setSelected(p.userId)}>{p.name}</button>
                      <span className="muted small"> {p.email} · {p.sentCount} sent · last {when(p.lastSentAt)} </span>
                      <span className={`status-pill ${p.status === 'came_back' ? 'answered' : p.status === 'no_response' ? 'open' : ''}`}>{STATUS[p.status]}</span>
                    </li>
                  ))}
                </ul>
                <div className="row">
                  <button type="button" className="button ghost small" disabled={page === 0} onClick={() => setPage((n) => n - 1)}>Previous</button>
                  <span className="muted small">Page {page + 1} of {pages}</span>
                  <button type="button" className="button ghost small" disabled={page + 1 >= pages} onClick={() => setPage((n) => n + 1)}>Next</button>
                </div>
              </div>
              {person && (
                <aside style={{ flex: 1 }} aria-label={`Messages to ${person.name}`}>
                  <h2 className="h3">Messages to {person.name}</h2>
                  <ul className="notification-list">
                    {person.messages.map((m) => (
                      <li key={m.id} className="card">
                        <div className="notification-head"><strong>{m.title}</strong><span className="status-pill">Applied by agent</span></div>
                        <p>{m.body}</p>
                        <p className="muted small">Sent {when(m.createdAt)} · {m.readAt ? `Opened ${when(m.readAt)}` : 'Not opened'}{m.cameBackAt ? ` · Enrolled ${when(m.cameBackAt)}` : ''}</p>
                      </li>
                    ))}
                  </ul>
                </aside>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
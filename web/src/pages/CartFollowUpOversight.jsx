import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { ErrorNote, Loading, PageTitle } from '../components/ui.jsx';

const STATUS_LABELS = { sent: 'Sent', opened: 'Opened', came_back: 'Came back', no_response: 'No response yet' };
const RANGES = [['today', 'Today', 0], ['1w', '1W', 6], ['2w', '2W', 13], ['1m', '1M', 29], ['custom', 'Custom']];
const PAGE_SIZE = 10;
const DAY_MS = 86_400_000;
const dayStr = (d) => d.toISOString().slice(0, 10);
const when = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function rangeSpan(range, custom) {
  if (range === 'custom') return custom.from && custom.to && custom.from <= custom.to ? custom : null;
  const days = RANGES.find((r) => r[0] === range)[2];
  const to = new Date();
  return { from: dayStr(new Date(to.getTime() - days * DAY_MS)), to: dayStr(to) };
}

function Ring({ label, part, total }) {
  const pct = total ? Math.round((part * 100) / total) : 0;
  const r = 34;
  const c = 2 * Math.PI * r;
  return (
    <figure className="card" style={{ margin: 0, textAlign: 'center' }}>
      <svg width="96" height="96" viewBox="0 0 96 96" role="img" aria-label={`${label}: ${part} of ${total}, ${pct}%`}>
        <circle cx="48" cy="48" r={r} fill="none" stroke="#e5e7eb" strokeWidth="10" />
        <circle cx="48" cy="48" r={r} fill="none" stroke="#5624d0" strokeWidth="10" strokeDasharray={`${(c * pct) / 100} ${c}`} transform="rotate(-90 48 48)" />
        <text x="48" y="53" textAnchor="middle" fontSize="16">{pct}%</text>
      </svg>
      <figcaption>{label}<br /><span className="muted small">{part} of {total}</span></figcaption>
    </figure>
  );
}

const SERIES = [['sent', 'Sent', '#9ca3af'], ['opened', 'Opened', '#5624d0'], ['cameBack', 'Came back', '#1e8a5a']];

function DailyChart({ days }) {
  const max = Math.max(1, ...days.flatMap((d) => [d.sent, d.opened, d.cameBack]));
  const h = 120;
  const w = Math.max(days.length * 24, 120);
  return (
    <div className="card">
      <svg width="100%" viewBox={`0 0 ${w} ${h + 20}`} role="img" aria-label="Daily reminders sent, opened and came back">
        {days.map((d, i) => SERIES.map(([key, name, color], j) => {
          const bh = (d[key] / max) * h;
          return <rect key={`${d.date}-${key}`} x={i * 24 + j * 7 + 2} y={h - bh} width="6" height={bh} fill={color}><title>{`${d.date} ${name}: ${d[key]}`}</title></rect>;
        }))}
        {days.map((d, i) => (days.length <= 14 || i % 7 === 0) && <text key={d.date} x={i * 24 + 2} y={h + 14} fontSize="8">{d.date.slice(5)}</text>)}
      </svg>
      <p className="muted small">{SERIES.map(([, name, color]) => <span key={name} style={{ marginRight: 12 }}><span style={{ color }}>■</span> {name}</span>)}</p>
    </div>
  );
}

export function CartFollowUpOversightPage() {
  const [range, setRange] = useState('1m');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState(null);
  const span = rangeSpan(range, custom);

  useEffect(() => {
    if (!span) return;
    setError(false);
    api(`/api/admin/agents/cart-follow-up?from=${span.from}&to=${span.to}`).then(setData).catch(() => setError(true));
  }, [span?.from, span?.to]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.people ?? []).filter((p) => (status === 'all' || p.status === status)
      && (!q || p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q)));
  }, [data, query, status]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const shown = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const selected = data?.people.find((p) => p.userId === selectedId) ?? null;

  return (
    <div data-ga-oversight="cart-follow-up">
      <PageTitle title="Cart reminders sent by the AI agent" subtitle="Read-only. Every message here was applied by the agent; statuses are derived from inbox reads and later enrolments." />
      <p className="small"><Link to="/admin">← Back to Admin</Link>{data && !data.agentEnabled && <span className="muted"> · The agent is switched off (flag ga-find_4219d5566568).</span>}</p>
      {error && <ErrorNote>The agent activity could not be loaded.</ErrorNote>}
      {!data && !error && <Loading />}
      {data && (
        <>
          <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
            <Ring label="Opened out of sent" part={data.stats.opened} total={data.stats.sent} />
            <Ring label="Came back out of opened" part={data.stats.cameBack} total={data.stats.opened} />
          </div>
          <div className="tabs" role="tablist" aria-label="Chart range">
            {RANGES.map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={range === key} className={range === key ? 'active' : ''} onClick={() => setRange(key)}>{label}</button>
            ))}
          </div>
          {range === 'custom' && (
            <div className="row">
              <label>From <input type="date" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} /></label>
              <label>To <input type="date" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} /></label>
            </div>
          )}
          <DailyChart days={data.daily} />
          <div className="row space">
            <label className="search">
              <span className="sr-only">Search people</span>
              <input type="search" placeholder="Search by name or email" value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }} />
            </label>
            <label>
              <span className="sr-only">Filter by status</span>
              <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }}>
                <option value="all">All statuses</option>
                {Object.entries(STATUS_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
            </label>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16 }}>
            <div>
              {filtered.length === 0 && <p className="muted">The agent has not contacted anyone matching this view.</p>}
              <ul className="notification-list">
                {shown.map((p) => (
                  <li key={p.userId} className="card">
                    <button type="button" className="button ghost small" aria-pressed={p.userId === selectedId} onClick={() => setSelectedId(p.userId)}>{p.name}</button>
                    <span className="muted small"> {p.email} · last sent {when(p.lastSentAt)} </span>
                    <span className={`status-pill ${p.status === 'came_back' ? 'answered' : p.status === 'no_response' ? 'open' : ''}`}>{STATUS_LABELS[p.status]}</span>
                  </li>
                ))}
              </ul>
              <div className="row">
                <button type="button" className="button ghost small" disabled={page === 0} onClick={() => setPage((n) => n - 1)}>Previous</button>
                <span className="muted small">Page {page + 1} of {pages}</span>
                <button type="button" className="button ghost small" disabled={page + 1 >= pages} onClick={() => setPage((n) => n + 1)}>Next</button>
              </div>
            </div>
            <div>
              {!selected && <p className="muted">Select a person to see every message the agent sent them.</p>}
              {selected && (
                <>
                  <h2 className="h3">{selected.name}</h2>
                  <ul className="notification-list">
                    {selected.messages.map((m) => (
                      <li key={m.id} className="card">
                        <div className="notification-head">
                          <strong>{m.title}</strong>
                          <span className="status-pill">Applied by agent</span>
                        </div>
                        <p>{m.body}</p>
                        <p className="muted small">
                          Sent {when(m.createdAt)} · {m.opened ? `Opened ${when(m.readAt)}` : 'Not opened'}{m.cameBackAt ? ` · Came back ${when(m.cameBackAt)}` : ''}
                        </p>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
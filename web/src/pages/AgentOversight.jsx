import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { ErrorNote, Loading, PageTitle } from '../components/ui.jsx';

// Read-only oversight of the lesson-reminder AI agent (marker: ga-oversight).
const STATUS_LABELS = { sent: 'Sent', opened: 'Opened', came_back: 'Came back', no_response: 'No response yet' };
const PAGE_SIZE = 20;
const RANGES = [['today', 'Today', 1], ['1w', '1W', 7], ['2w', '2W', 14], ['1m', '1M', 30], ['custom', 'Custom', null]];
const MAX_DAYS = 92;
const DAY_MS = 86_400_000;
const COLORS = { sent: '#5624d0', opened: '#0e7c86', cameBack: '#b4690e' };
const dayKey = (iso) => String(iso).slice(0, 10);
const when = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function daysFrom(from, to) {
  const out = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); out.length < MAX_DAYS && dayKey(new Date(t).toISOString()) <= to; t += DAY_MS) {
    out.push(dayKey(new Date(t).toISOString()));
  }
  return out;
}

function Ring({ label, part, whole }) {
  const pct = whole ? Math.round((100 * part) / whole) : 0;
  const r = 40;
  const c = 2 * Math.PI * r;
  return (
    <figure className="card" style={{ textAlign: 'center', margin: 0 }}>
      <svg width="110" height="110" viewBox="0 0 100 100" role="img" aria-label={`${label}: ${part} of ${whole}, ${pct}%`}>
        <circle cx="50" cy="50" r={r} fill="none" stroke="#e5e7eb" strokeWidth="10" />
        <circle cx="50" cy="50" r={r} fill="none" stroke={COLORS.sent} strokeWidth="10" strokeDasharray={`${(c * pct) / 100} ${c}`} transform="rotate(-90 50 50)" />
        <text x="50" y="55" textAnchor="middle" fontSize="18">{pct}%</text>
      </svg>
      <figcaption><strong>{label}</strong><div className="muted small">{part} of {whole}</div></figcaption>
    </figure>
  );
}

function DailyChart({ messages, days }) {
  const series = days.map((d) => ({
    day: d,
    sent: messages.filter((m) => dayKey(m.createdAt) === d).length,
    opened: messages.filter((m) => m.readAt && dayKey(m.readAt) === d).length,
    cameBack: messages.filter((m) => m.cameBackAt && dayKey(m.cameBackAt) === d).length,
  }));
  const max = Math.max(1, ...series.flatMap((s) => [s.sent, s.opened, s.cameBack]));
  const w = 24;
  const h = 120;
  const every = Math.ceil(days.length / 8);
  return (
    <div className="table-wrap">
      <svg width={Math.max(w * days.length, 240)} height={h + 20} role="img" aria-label="Sent, opened and came back per day">
        {series.flatMap((s, i) => ['sent', 'opened', 'cameBack'].map((k, j) => {
          const bh = (h * s[k]) / max;
          return <rect key={`${s.day}-${k}`} x={i * w + j * 7 + 2} y={h - bh} width="6" height={bh} fill={COLORS[k]}><title>{`${s.day} ${k}: ${s[k]}`}</title></rect>;
        }))}
        {series.map((s, i) => (i % every === 0 ? <text key={s.day} x={i * w} y={h + 14} fontSize="10">{s.day.slice(5)}</text> : null))}
      </svg>
      <p className="muted small">
        {[['sent', 'Sent'], ['opened', 'Opened'], ['cameBack', 'Came back']].map(([k, l]) => <span key={k} style={{ marginRight: 12 }}><span style={{ color: COLORS[k] }}>■</span> {l}</span>)}
      </p>
    </div>
  );
}

export function AgentOversightPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState(null);
  const [range, setRange] = useState('1w');
  const [custom, setCustom] = useState({ from: '', to: '' });

  useEffect(() => {
    api('/api/admin/lesson-reminders').then(setData).catch(() => setError(true));
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.people ?? []).filter((p) => (status === 'all' || p.status === status)
      && (!q || p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q)));
  }, [data, query, status]);

  const days = useMemo(() => {
    const today = dayKey(new Date().toISOString());
    if (range === 'custom') return custom.from && custom.to && custom.from <= custom.to ? daysFrom(custom.from, custom.to) : [];
    const n = RANGES.find(([k]) => k === range)[2];
    return daysFrom(dayKey(new Date(Date.now() - (n - 1) * DAY_MS).toISOString()), today);
  }, [range, custom]);

  if (error) return <ErrorNote>The AI agent's messages could not be loaded.</ErrorNote>;
  if (!data) return <Loading />;
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const shown = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const selected = data.people.find((p) => p.userId === selectedId) ?? null;
  const allMessages = data.people.flatMap((p) => p.messages);

  return (
    <div data-ga-oversight="lesson_reminders">
      <PageTitle title="AI agent: lesson reminders" subtitle="Read-only. What the AI agent sent to learners who stopped, and whether they came back to their lessons." />
      <p><Link to="/admin">← Back to Admin</Link></p>

      <section aria-label="Stats">
        <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
          <Ring label="Opened out of sent" part={data.stats.opened} whole={data.stats.sent} />
          <Ring label="Came back out of opened" part={data.stats.cameBack} whole={data.stats.opened} />
        </div>
        <div className="row" role="group" aria-label="Chart range" style={{ gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
          {RANGES.map(([k, label]) => (
            <button key={k} type="button" className={`button small ${range === k ? '' : 'ghost'}`} aria-pressed={range === k} onClick={() => setRange(k)}>{label}</button>
          ))}
          {range === 'custom' && (
            <>
              <label className="small">From <input type="date" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} /></label>
              <label className="small">To <input type="date" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} /></label>
            </>
          )}
        </div>
        {days.length > 0 ? <DailyChart messages={allMessages} days={days} /> : <p className="muted small">Choose a start and end date.</p>}
      </section>

      <div className="row" style={{ alignItems: 'flex-start', gap: 24, marginTop: 24, flexWrap: 'wrap' }}>
        <section aria-label="People contacted" style={{ flex: '1 1 360px' }}>
          <div className="row space">
            <label className="search">
              <span className="sr-only">Search people</span>
              <input type="search" placeholder="Search by name or email" value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }} />
            </label>
            <label className="small">
              <span className="sr-only">Status</span>
              <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }}>
                <option value="all">All statuses</option>
                {Object.entries(STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
          </div>
          {filtered.length === 0 && <p className="muted">The AI agent has not contacted anyone matching this.</p>}
          <ul className="notification-list">
            {shown.map((p) => (
              <li key={p.userId} className={`card${p.userId === selectedId ? ' unread' : ''}`}>
                <button type="button" className="button ghost" style={{ width: '100%', textAlign: 'left' }} onClick={() => setSelectedId(p.userId)} aria-pressed={p.userId === selectedId}>
                  <span className="notification-head">
                    <strong>{p.name}</strong>
                    <span className={`status-pill ${p.status === 'came_back' ? 'answered' : p.status === 'no_response' ? 'open' : ''}`}>{STATUS_LABELS[p.status]}</span>
                  </span>
                  <span className="muted small">{p.email} · {p.messages.length} sent · last {when(p.lastMessageAt)}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="row space">
            <button type="button" className="button ghost small" disabled={page === 0} onClick={() => setPage((n) => n - 1)}>Previous</button>
            <span className="muted small">Page {page + 1} of {pages} · {filtered.length} people</span>
            <button type="button" className="button ghost small" disabled={page + 1 >= pages} onClick={() => setPage((n) => n + 1)}>Next</button>
          </div>
        </section>

        <section aria-label="Messages sent" style={{ flex: '1 1 360px' }}>
          {!selected && <p className="muted">Select a person to see every message the AI agent sent them.</p>}
          {selected && (
            <>
              <h2 className="h3">{selected.name}</h2>
              <ul className="notification-list">
                {selected.messages.map((m) => (
                  <li key={m.id} className="card">
                    <div className="notification-head">
                      <h3 className="h3">{m.title}</h3>
                      <span className="status-pill">Applied by agent</span>
                    </div>
                    <p className="muted small">
                      Sent {when(m.createdAt)} · {m.opened ? `Opened ${when(m.readAt)}` : 'Not opened'}
                      {m.cameBackAt ? ` · Came back ${when(m.cameBackAt)}` : ''}
                    </p>
                    <p>{m.body}</p>
                    {m.link && <p className="muted small">Link: <code>{m.link}</code></p>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
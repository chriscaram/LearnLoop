import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { ErrorNote, Loading, PageTitle } from '../components/ui.jsx';

// Staff oversight for the inactivity nudge AI agent (finding find_99c029aac886). Read-only.
const STATUS_LABELS = { sent: 'Sent', opened: 'Opened', came_back: 'Came back', no_response: 'No response yet' };
const RANGES = [['today', 'Today', 1], ['1w', '1W', 7], ['2w', '2W', 14], ['1m', '1M', 30], ['custom', 'Custom', null]];
const PAGE_SIZE = 20;
const DAY_MS = 86_400_000;
const pct = (n, d) => (d ? Math.round((100 * n) / d) : 0);
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
const isoDay = (d) => d.toISOString().slice(0, 10);

function rangeDays(range, from, to, now = new Date()) {
  let start;
  let end = isoDay(now);
  if (range === 'custom') {
    if (!from || !to || from > to) return [];
    [start, end] = [from, to];
  } else {
    start = isoDay(new Date(now.getTime() - (RANGES.find((r) => r[0] === range)[2] - 1) * DAY_MS));
  }
  const out = [];
  for (let d = new Date(`${start}T00:00:00Z`); isoDay(d) <= end && out.length < 366; d = new Date(d.getTime() + DAY_MS)) out.push(isoDay(d));
  return out;
}

function Ring({ label, value, total }) {
  const r = 40;
  const c = 2 * Math.PI * r;
  const p = pct(value, total);
  return (
    <figure className="card" style={{ textAlign: 'center', margin: 0 }}>
      <svg width="120" height="120" viewBox="0 0 100 100" role="img" aria-label={`${label}: ${value} of ${total}, ${p}%`}>
        <circle cx="50" cy="50" r={r} fill="none" stroke="#e5e7eb" strokeWidth="10" />
        <circle cx="50" cy="50" r={r} fill="none" stroke="#5624d0" strokeWidth="10" strokeDasharray={`${(c * p) / 100} ${c}`} transform="rotate(-90 50 50)" />
        <text x="50" y="56" textAnchor="middle" fontSize="18">{p}%</text>
      </svg>
      <figcaption>{label}<br /><span className="muted small">{value} of {total}</span></figcaption>
    </figure>
  );
}

const SERIES = [['sent', 'Sent', '#9ca3af'], ['opened', 'Opened', '#5624d0'], ['cameBack', 'Came back', '#16a34a']];

function DailyChart({ days }) {
  const max = Math.max(1, ...days.flatMap((d) => SERIES.map(([k]) => d[k])));
  const w = 640;
  const h = 160;
  const group = w / Math.max(1, days.length);
  const bar = Math.max(1, (group - 4) / 3);
  return (
    <div>
      <svg width="100%" viewBox={`0 0 ${w} ${h + 20}`} role="img" aria-label="Daily sent, opened and came back">
        {days.map((d, i) => (
          <g key={d.date}>
            {SERIES.map(([k, , color], j) => {
              const bh = (h * d[k]) / max;
              return <rect key={k} x={i * group + 2 + j * bar} y={h - bh} width={bar} height={bh} fill={color}><title>{`${d.date} ${k}: ${d[k]}`}</title></rect>;
            })}
            {(days.length <= 14 || i % 7 === 0) && <text x={i * group + group / 2} y={h + 14} fontSize="9" textAnchor="middle">{d.date.slice(5)}</text>}
          </g>
        ))}
      </svg>
      <p className="muted small">{SERIES.map(([k, label, color]) => <span key={k} style={{ marginRight: 12 }}><span style={{ color }}>■</span> {label}</span>)}</p>
    </div>
  );
}

export function AgentNudgesPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState(null);
  const [range, setRange] = useState('1w');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  useEffect(() => {
    api('/api/admin/agent-nudges').then(setData).catch(() => setError(true));
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.people ?? []).filter((p) => (status === 'all' || p.status === status)
      && (!q || p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q)));
  }, [data, query, status]);

  const daily = useMemo(() => {
    const byDate = new Map((data?.daily ?? []).map((d) => [d.date, d]));
    return rangeDays(range, from, to).map((date) => byDate.get(date) ?? { date, sent: 0, opened: 0, cameBack: 0 });
  }, [data, range, from, to]);

  if (error) return <ErrorNote>The AI agent activity could not be loaded.</ErrorNote>;
  if (!data) return <Loading />;
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const shown = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const selected = data.people.find((p) => p.userId === selectedId) ?? null;
  const count = (s) => data.people.filter((p) => p.status === s).length;

  return (
    <section data-ga-oversight="ga-find_99c029aac886">
      <PageTitle title="AI agent: re-engagement nudges" subtitle="What the AI agent sent to inactive learners and whether it worked. Read-only." />
      <p><Link to="/admin">← Back to Admin</Link></p>

      <h2 className="h3">Stats</h2>
      <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
        <Ring label="Opened out of sent" value={data.totals.opened} total={data.totals.sent} />
        <Ring label="Came back out of opened" value={data.totals.cameBackOfOpened} total={data.totals.opened} />
      </div>
      <div className="tabs" role="tablist" aria-label="Chart range">
        {RANGES.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={range === key} className={range === key ? 'active' : ''} onClick={() => setRange(key)}>{label}</button>
        ))}
      </div>
      {range === 'custom' && (
        <div className="row">
          <label>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label>To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
      )}
      <DailyChart days={daily} />

      <h2 className="h3">People contacted</h2>
      <div className="row space">
        <label className="search">
          <span className="sr-only">Search people</span>
          <input type="search" placeholder="Search by name or email" value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }} />
        </label>
        <div className="row" role="group" aria-label="Filter by status">
          {['all', ...Object.keys(STATUS_LABELS)].map((s) => (
            <button key={s} type="button" className={`button small ${status === s ? '' : 'ghost'}`} aria-pressed={status === s} onClick={() => { setStatus(s); setPage(0); }}>
              {s === 'all' ? `All (${data.people.length})` : `${STATUS_LABELS[s]} (${count(s)})`}
            </button>
          ))}
        </div>
      </div>
      <div className="row" style={{ alignItems: 'flex-start', gap: 24 }}>
        <div style={{ flex: 1 }}>
          {shown.length === 0 && <p className="muted">No one matches.</p>}
          <ul className="notification-list">
            {shown.map((p) => (
              <li key={p.userId} className={`card${p.userId === selectedId ? ' unread' : ''}`}>
                <button type="button" className="button ghost" style={{ width: '100%', textAlign: 'left' }} onClick={() => setSelectedId(p.userId)}>
                  <strong>{p.name}</strong> <span className="muted small">{p.email}</span>{' '}
                  <span className={`status-pill ${p.status === 'came_back' ? 'answered' : p.status === 'no_response' ? 'open' : ''}`}>{STATUS_LABELS[p.status]}</span>
                  <div className="muted small">{p.messages.length} sent · last {when(p.lastSentAt)}</div>
                </button>
              </li>
            ))}
          </ul>
          <div className="row">
            <button type="button" className="button ghost small" disabled={page === 0} onClick={() => setPage((x) => x - 1)}>Previous</button>
            <span className="muted small">Page {page + 1} of {pages}</span>
            <button type="button" className="button ghost small" disabled={page + 1 >= pages} onClick={() => setPage((x) => x + 1)}>Next</button>
          </div>
        </div>
        <aside style={{ flex: 1 }} aria-label="Messages sent">
          {!selected && <p className="muted">Select a person to see every message the AI agent sent them.</p>}
          {selected && (
            <>
              <h3 className="h3">{selected.name}</h3>
              <ul className="notification-list">
                {selected.messages.map((m) => (
                  <li key={m.id} className="card">
                    <div className="notification-head">
                      <strong>{m.title}</strong>
                      <span className="status-pill">Applied by agent</span>
                    </div>
                    <p className="muted small">Sent {when(m.createdAt)} · {m.opened ? `Opened ${when(m.readAt)}` : 'Not opened'}{m.cameBackAt ? ` · Came back ${when(m.cameBackAt)}` : ''}{m.emailStatus ? ` · Email ${m.emailStatus}` : ''}</p>
                    <p>{m.body}</p>
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>
      </div>
    </section>
  );
}
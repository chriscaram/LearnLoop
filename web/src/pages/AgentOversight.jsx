// Staff oversight for the AI re-engagement agent (flag ga-find_9c5cee13064a).
// Read-only: every status comes from the agent's own notifications and later lesson activity.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { ErrorNote, Loading, PageTitle } from '../components/ui.jsx';

const STATUS_LABELS = { sent: 'Sent', opened: 'Opened', came_back: 'Came back', no_response: 'No response yet' };
const PAGE_SIZE = 20;
const DAY_MS = 86_400_000;
const MAX_CHART_DAYS = 92;
const RANGES = [['today', 'Today', 1], ['1w', '1W', 7], ['2w', '2W', 14], ['1m', '1M', 30], ['custom', 'Custom', null]];
const COLORS = { sent: '#6b7280', opened: '#5624d0', cameBack: '#16a34a' };

const dayOf = (iso) => iso.slice(0, 10);
const shiftDay = (day, n) => new Date(Date.parse(day) + n * DAY_MS).toISOString().slice(0, 10);
const formatDateTime = (iso) => `${new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC`;

function Ring({ label, part, whole }) {
  const pct = whole ? Math.round((100 * part) / whole) : 0;
  const r = 40;
  const c = 2 * Math.PI * r;
  return (
    <figure className="card" style={{ margin: 0, textAlign: 'center' }}>
      <svg width="110" height="110" viewBox="0 0 110 110" role="img" aria-label={`${label}: ${part} of ${whole}, ${pct}%`}>
        <circle cx="55" cy="55" r={r} fill="none" stroke="#e5e7eb" strokeWidth="12" />
        <circle cx="55" cy="55" r={r} fill="none" stroke={COLORS.opened} strokeWidth="12" strokeDasharray={`${(c * pct) / 100} ${c}`} transform="rotate(-90 55 55)" />
        <text x="55" y="61" textAnchor="middle" fontSize="18">{pct}%</text>
      </svg>
      <figcaption><strong>{label}</strong><div className="muted small">{part} of {whole}</div></figcaption>
    </figure>
  );
}

function dailySeries(people, from, to) {
  const days = [];
  for (let d = from; d <= to && days.length < MAX_CHART_DAYS; d = shiftDay(d, 1)) days.push(d);
  const counts = new Map(days.map((d) => [d, { day: d, sent: 0, opened: 0, cameBack: 0 }]));
  for (const p of people) {
    for (const m of p.messages) {
      const bump = (iso, key) => { if (iso && counts.has(dayOf(iso))) counts.get(dayOf(iso))[key] += 1; };
      bump(m.createdAt, 'sent');
      bump(m.readAt, 'opened');
      bump(m.cameBackAt, 'cameBack');
    }
  }
  return [...counts.values()];
}

function DailyChart({ series }) {
  const max = Math.max(1, ...series.flatMap((d) => [d.sent, d.opened, d.cameBack]));
  const group = 24;
  const h = 120;
  return (
    <svg width={Math.max(series.length * group, 120)} height={h + 20} role="img" aria-label="Daily sent, opened and came back">
      {series.map((d, i) => ['sent', 'opened', 'cameBack'].map((key, k) => {
        const bh = (h * d[key]) / max;
        return <rect key={`${d.day}-${key}`} x={i * group + k * 7} y={h - bh} width="6" height={bh} fill={COLORS[key]}><title>{`${d.day} ${key}: ${d[key]}`}</title></rect>;
      }))}
      {series.length > 0 && <text x="0" y={h + 15} fontSize="10">{series[0].day}</text>}
      {series.length > 1 && <text x={series.length * group} y={h + 15} fontSize="10" textAnchor="end">{series.at(-1).day}</text>}
    </svg>
  );
}

function StatsView({ data }) {
  const today = new Date().toISOString().slice(0, 10);
  const [range, setRange] = useState('1w');
  const [custom, setCustom] = useState({ from: shiftDay(today, -6), to: today });
  const days = RANGES.find(([key]) => key === range)[2];
  const { from, to } = range === 'custom' ? custom : { from: shiftDay(today, -(days - 1)), to: today };
  const series = useMemo(() => dailySeries(data.people, from, to), [data, from, to]);
  const t = data.totals;
  return (
    <section aria-label="Agent outreach stats">
      <div className="row">
        <Ring label="Opened out of sent" part={t.opened} whole={t.sent} />
        <Ring label="Came back out of opened" part={t.cameBackOfOpened} whole={t.opened} />
      </div>
      <div className="row" role="group" aria-label="Chart range">
        {RANGES.map(([key, label]) => (
          <button key={key} type="button" className={`button small ${range === key ? '' : 'ghost'}`} aria-pressed={range === key} onClick={() => setRange(key)}>{label}</button>
        ))}
        {range === 'custom' && (
          <>
            <label>From <input type="date" value={custom.from} max={custom.to} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} /></label>
            <label>To <input type="date" value={custom.to} min={custom.from} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} /></label>
          </>
        )}
      </div>
      <DailyChart series={series} />
      <p className="muted small">
        <span style={{ color: COLORS.sent }}>■</span> Sent <span style={{ color: COLORS.opened }}>■</span> Opened <span style={{ color: COLORS.cameBack }}>■</span> Came back
      </p>
    </section>
  );
}

export function AgentOversightPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    api('/api/admin/agent-outreach').then(setData).catch(() => setError(true));
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.people ?? []).filter((p) => (status === 'all' || p.status === status)
      && (!q || p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q)));
  }, [data, query, status]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const shown = filtered.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  const person = data?.people.find((p) => p.userId === selected) ?? null;

  return (
    <div data-ga-oversight="true">
      <PageTitle title="AI agent outreach" subtitle="Re-engagement messages the AI agent sent, and whether learners opened them and came back to their lessons." />
      <p><Link to="/admin">← Back to Admin</Link></p>
      {error && <ErrorNote>Agent outreach could not be loaded.</ErrorNote>}
      {!data && !error && <Loading />}
      {data && (
        <>
          <StatsView data={data} />
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
            <span className="muted small">{filtered.length} of {data.people.length} people</span>
          </div>
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <div className="table-wrap" style={{ flex: 1 }}>
              <table>
                <thead><tr><th scope="col">Learner</th><th scope="col">Status</th><th scope="col">Last sent</th></tr></thead>
                <tbody>
                  {shown.map((p) => (
                    <tr key={p.userId} aria-selected={p.userId === selected}>
                      <td><button type="button" className="button ghost small" onClick={() => setSelected(p.userId)}>{p.name}</button><div className="muted small">{p.email}</div></td>
                      <td><span className={`status-pill ${p.status === 'came_back' ? 'answered' : p.status === 'no_response' ? 'open' : ''}`}>{STATUS_LABELS[p.status]}</span></td>
                      <td>{formatDateTime(p.lastSentAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.people.length === 0 && <p className="muted">The AI agent has not contacted anyone yet.</p>}
              <div className="row end">
                <button type="button" className="button ghost small" disabled={current === 0} onClick={() => setPage(current - 1)}>Previous</button>
                <span className="muted small">Page {current + 1} of {pages}</span>
                <button type="button" className="button ghost small" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>Next</button>
              </div>
            </div>
            {person && (
              <aside className="card" style={{ flex: 1 }} aria-label={`Messages sent to ${person.name}`}>
                <h2 className="h3">{person.name}</h2>
                <p className="muted small">{person.email} · {STATUS_LABELS[person.status]}</p>
                <ul className="notification-list">
                  {person.messages.map((m) => (
                    <li key={m.id} className="card">
                      <div className="notification-head">
                        <strong>{m.title}</strong>
                        <span className="status-pill">Applied by agent</span>
                      </div>
                      <p className="muted small">Sent {formatDateTime(m.createdAt)} · {m.opened ? `Opened ${formatDateTime(m.readAt)}` : 'Not opened'}{m.cameBack ? ' · Came back' : ''}</p>
                      <p>{m.body}</p>
                    </li>
                  ))}
                </ul>
              </aside>
            )}
          </div>
        </>
      )}
    </div>
  );
}
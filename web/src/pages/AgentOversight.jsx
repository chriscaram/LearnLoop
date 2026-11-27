import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { ErrorNote, Loading, PageTitle } from '../components/ui.jsx';

const STATUS = { sent: 'Sent', opened: 'Opened', came_back: 'Came back', no_response: 'No response yet' };
const PAGE_SIZE = 20;
const DAY_MS = 86_400_000;
const RANGES = [['today', 'Today', 1], ['1w', '1W', 7], ['2w', '2W', 14], ['1m', '1M', 30], ['custom', 'Custom', null]];
const day = (iso) => iso.slice(0, 10);
const when = (iso) => new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
const pct = (part, whole) => (whole ? Math.round((100 * part) / whole) : 0);

function Ring({ label, part, whole }) {
  const r = 36;
  const c = 2 * Math.PI * r;
  return (
    <figure className="card">
      <svg width="96" height="96" viewBox="0 0 96 96" role="img" aria-label={`${label}: ${part} of ${whole}`}>
        <circle cx="48" cy="48" r={r} fill="none" stroke="#e5e7eb" strokeWidth="10" />
        <circle cx="48" cy="48" r={r} fill="none" stroke="#5624d0" strokeWidth="10" strokeDasharray={`${(c * pct(part, whole)) / 100} ${c}`} transform="rotate(-90 48 48)" />
        <text x="48" y="53" textAnchor="middle" fontSize="16">{pct(part, whole)}%</text>
      </svg>
      <figcaption>{label}: {part} of {whole}</figcaption>
    </figure>
  );
}

function DailyChart({ people }) {
  const [range, setRange] = useState('1w');
  const today = day(new Date().toISOString());
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const days = useMemo(() => {
    const n = RANGES.find((x) => x[0] === range)[2];
    const start = n ? Date.parse(today) - (n - 1) * DAY_MS : Date.parse(from);
    const end = n ? Date.parse(today) : Date.parse(to);
    const out = [];
    for (let t = start; t <= end && out.length < 366; t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
    return out;
  }, [range, from, to, today]);
  const counts = days.map((d) => ({
    d,
    sent: people.flatMap((p) => p.messages).filter((m) => day(m.createdAt) === d).length,
    opened: people.flatMap((p) => p.messages).filter((m) => m.readAt && day(m.readAt) === d).length,
    back: people.filter((p) => p.status === 'came_back' && p.lastActivityAt && day(p.lastActivityAt) === d).length,
  }));
  const max = Math.max(1, ...counts.flatMap((c) => [c.sent, c.opened, c.back]));
  const w = Math.max(12, Math.floor(600 / Math.max(1, days.length)));
  return (
    <div className="card">
      <div className="tabs" role="tablist" aria-label="Range">
        {RANGES.map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={range === key} className={range === key ? 'active' : ''} onClick={() => setRange(key)}>{label}</button>)}
      </div>
      {range === 'custom' && (
        <div className="row">
          <label>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label>To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
      )}
      <svg width={w * days.length} height="140" role="img" aria-label="Daily sent, opened and came back">
        {counts.map((c, i) => [['sent', '#5624d0'], ['opened', '#8b5cf6'], ['back', '#16a34a']].map(([k, color], j) => {
          const h = (120 * c[k]) / max;
          return <rect key={`${c.d}-${k}`} x={i * w + j * (w / 3)} y={130 - h} width={w / 3 - 1} height={h} fill={color}><title>{`${c.d} ${k}: ${c[k]}`}</title></rect>;
        }))}
      </svg>
      <p className="muted small">Purple: sent · Light purple: opened · Green: came back</p>
    </div>
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
    api('/api/admin/learners?view=agent_nudges').then(setData).catch(() => setError(true));
  }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.people ?? []).filter((p) => (status === 'all' || p.status === status)
      && (!q || p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q)));
  }, [data, query, status]);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const person = data?.people.find((p) => p.userId === selected);

  return (
    <div data-ga-oversight="">
      <PageTitle title="AI agent: learning reminders" subtitle="What the agent sent and whether learners came back. Read-only." />
      <p><Link to="/admin">Back to Admin</Link></p>
      {error && <ErrorNote>The agent's messages could not be loaded.</ErrorNote>}
      {!data && !error && <Loading />}
      {data && (
        <>
          <div className="row">
            <Ring label="Opened out of sent" part={data.totals.opened} whole={data.totals.sent} />
            <Ring label="Came back out of opened" part={data.totals.cameBack} whole={data.totals.opened} />
          </div>
          <DailyChart people={data.people} />
          <div className="row space">
            <input type="search" aria-label="Search learners" placeholder="Search by name or email" value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }} />
            <select aria-label="Filter by status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }}>
              <option value="all">All statuses</option>
              {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="row">
            <ul className="notification-list">
              {shown.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((p) => (
                <li key={p.userId} className="card">
                  <button type="button" className="button ghost small" onClick={() => setSelected(p.userId)}>{p.name}</button>
                  <span className="muted small"> {p.email}{p.account ? ` · ${p.account}` : ''}</span>
                  <span className={`status-pill ${p.status === 'came_back' ? 'answered' : p.status === 'no_response' ? 'open' : ''}`}>{STATUS[p.status]}</span>
                </li>
              ))}
              {shown.length === 0 && <li className="muted">No learners match.</li>}
            </ul>
            {person && (
              <section className="card" aria-label={`Messages to ${person.name}`}>
                <h2 className="h3">{person.name}</h2>
                <ol>
                  {person.messages.map((m) => (
                    <li key={m.id}>
                      <strong>{m.title}</strong> <span className="status-pill">Applied by agent</span>
                      <div className="muted small">{when(m.createdAt)} · {m.opened ? `Opened ${when(m.readAt)}` : 'Not opened'}</div>
                      <p>{m.body}</p>
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </div>
          <div className="row">
            <button type="button" className="button ghost small" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
            <span className="muted small">Page {page + 1} of {pages}</span>
            <button type="button" className="button ghost small" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Next</button>
          </div>
        </>
      )}
    </div>
  );
}
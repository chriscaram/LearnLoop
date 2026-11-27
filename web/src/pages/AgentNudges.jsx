import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { ErrorNote, Loading, PageTitle } from '../components/ui.jsx';

const STATUS_LABELS = { sent: 'Sent', opened: 'Opened', came_back: 'Came back', no_response: 'No response yet' };
const PAGE_SIZE = 20;
const RANGES = [['today', 'Today', 0], ['1w', '1W', 6], ['2w', '2W', 13], ['1m', '1M', 29], ['custom', 'Custom', null]];
const day = (iso) => (iso ? iso.slice(0, 10) : null);
const when = (iso) => new Date(iso).toLocaleString();

function Ring({ label, part, total }) {
  const pct = total ? Math.round((100 * part) / total) : 0;
  const r = 36;
  const c = 2 * Math.PI * r;
  return (
    <figure className="card">
      <svg width="96" height="96" viewBox="0 0 96 96" role="img" aria-label={`${label}: ${part} of ${total}, ${pct}%`}>
        <circle cx="48" cy="48" r={r} fill="none" stroke="#e5e7eb" strokeWidth="10" />
        <circle cx="48" cy="48" r={r} fill="none" stroke="#5624d0" strokeWidth="10" strokeDasharray={`${(c * pct) / 100} ${c}`} transform="rotate(-90 48 48)" />
        <text x="48" y="53" textAnchor="middle" fontSize="16">{pct}%</text>
      </svg>
      <figcaption>{label}: {part} / {total}</figcaption>
    </figure>
  );
}

function DailyChart({ rows }) {
  const max = Math.max(1, ...rows.flatMap((r) => [r.sent, r.opened, r.cameBack]));
  const w = Math.max(rows.length * 24, 120);
  const colors = ['#5624d0', '#1e88e5', '#2e7d32'];
  return (
    <svg width={w} height="130" role="img" aria-label="Daily sent, opened and came back">
      {rows.map((r, i) => [r.sent, r.opened, r.cameBack].map((v, k) => (
        <rect key={`${r.date}-${k}`} x={i * 24 + k * 7} y={110 - (100 * v) / max} width="6" height={(100 * v) / max} fill={colors[k]}><title>{`${r.date}: ${['sent', 'opened', 'came back'][k]} ${v}`}</title></rect>
      )))}
      <text x="0" y="126" fontSize="10">{rows[0]?.date}</text>
      <text x={w} y="126" fontSize="10" textAnchor="end">{rows.at(-1)?.date}</text>
    </svg>
  );
}

export function AgentNudgesPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState(null);
  const [range, setRange] = useState('1w');
  const today = new Date().toISOString().slice(0, 10);
  const [custom, setCustom] = useState({ from: today, to: today });

  useEffect(() => { api('/api/admin/agent-nudges').then(setData).catch(() => setError(true)); }, []);

  const people = useMemo(() => (data?.people ?? []).filter((p) => (status === 'all' || p.status === status)
    && (!q.trim() || `${p.name} ${p.email}`.toLowerCase().includes(q.trim().toLowerCase()))), [data, q, status]);
  const pages = Math.max(1, Math.ceil(people.length / PAGE_SIZE));
  const shown = people.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const person = data?.people.find((p) => p.userId === selected);

  const { from, to } = useMemo(() => {
    if (range === 'custom') return custom;
    const span = RANGES.find(([k]) => k === range)[2];
    return { from: new Date(Date.now() - span * 86_400_000).toISOString().slice(0, 10), to: today };
  }, [range, custom, today]);
  const messages = (data?.people ?? []).flatMap((p) => p.messages);
  const inRange = (d) => d && d >= from && d <= to;
  const ranged = messages.filter((m) => inRange(day(m.createdAt)));
  const daily = [];
  for (let d = new Date(`${from}T00:00:00Z`); day(d.toISOString()) <= to && daily.length < 400; d = new Date(d.getTime() + 86_400_000)) {
    const date = day(d.toISOString());
    daily.push({
      date,
      sent: messages.filter((m) => day(m.createdAt) === date).length,
      opened: messages.filter((m) => day(m.openedAt) === date).length,
      cameBack: messages.filter((m) => day(m.cameBackAt) === date).length,
    });
  }

  return (
    <div data-ga-oversight="ga-find_02688b9ceef7">
      <PageTitle title="AI agent: learning nudges" subtitle="What the AI agent sent to lapsed learners and whether they came back. Read-only." />
      <p><Link to="/admin">Back to Admin</Link></p>
      {error && <ErrorNote>The agent activity could not be loaded.</ErrorNote>}
      {!data && !error && <Loading />}
      {data && (
        <>
          <section aria-label="Stats">
            <div className="row">
              {RANGES.map(([k, label]) => <button key={k} type="button" className={`button small${range === k ? ' dark' : ' ghost'}`} onClick={() => setRange(k)}>{label}</button>)}
              {range === 'custom' && (
                <>
                  <input type="date" aria-label="From" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
                  <input type="date" aria-label="To" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
                </>
              )}
            </div>
            <div className="row">
              <Ring label="Opened out of sent" part={ranged.filter((m) => m.openedAt).length} total={ranged.length} />
              <Ring label="Came back out of opened" part={ranged.filter((m) => m.openedAt && m.cameBackAt).length} total={ranged.filter((m) => m.openedAt).length} />
            </div>
            <DailyChart rows={daily} />
          </section>
          <div className="row">
            <input type="search" aria-label="Search learners" placeholder="Search name or email" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
            <select aria-label="Filter by status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }}>
              <option value="all">All statuses</option>
              {Object.entries(STATUS_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </div>
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <ul className="notification-list" style={{ flex: 1 }}>
              {shown.length === 0 && <li className="muted">The AI agent has not contacted anyone matching this view.</li>}
              {shown.map((p) => (
                <li key={p.userId} className="card">
                  <button type="button" className="button ghost small" onClick={() => setSelected(p.userId)}>{p.name}</button>
                  <span className="muted small"> {p.email} · {p.messages.length} sent · last {when(p.lastSentAt)} </span>
                  <span className="badge">{STATUS_LABELS[p.status]}</span>
                </li>
              ))}
              <li className="row">
                <button type="button" className="button ghost small" disabled={page === 0} onClick={() => setPage((n) => n - 1)}>Previous</button>
                <span className="muted small">Page {page + 1} of {pages}</span>
                <button type="button" className="button ghost small" disabled={page + 1 >= pages} onClick={() => setPage((n) => n + 1)}>Next</button>
              </li>
            </ul>
            {person && (
              <aside className="card" style={{ flex: 1 }} aria-label={`Messages sent to ${person.name}`}>
                <h2 className="h3">{person.name}</h2>
                <ol>
                  {person.messages.map((m) => (
                    <li key={m.id}>
                      <strong>{m.title}</strong> <span className="badge">Applied by agent</span>
                      <div className="muted small">Sent {when(m.createdAt)} · {m.openedAt ? `Opened ${when(m.openedAt)}` : 'Not opened'}{m.cameBackAt ? ` · Came back ${when(m.cameBackAt)}` : ''}</div>
                      <p>{m.body}</p>
                    </li>
                  ))}
                </ol>
              </aside>
            )}
          </div>
        </>
      )}
    </div>
  );
}
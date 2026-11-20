import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { ErrorNote, Loading, PageTitle } from '../components/ui.jsx';

const STATUS = { sent: 'Sent', opened: 'Opened', came_back: 'Came back', no_response: 'No response yet' };
const CHIP = { sent: '', opened: '', came_back: 'answered', no_response: 'open' };
const PAGE_SIZE = 10;
const DAY_MS = 86_400_000;
const RANGES = [['today', 'Today', 1], ['1w', '1W', 7], ['2w', '2W', 14], ['1m', '1M', 30], ['custom', 'Custom', null]];
const COLORS = { sent: '#5624d0', opened: '#1c7c54', came: '#b4690e' };
const day = (iso) => (iso ? iso.slice(0, 10) : null);
const when = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const pct = (n, d) => (d ? Math.round((100 * n) / d) : 0);

function Ring({ label, value, total }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const p = pct(value, total);
  return (
    <figure style={{ margin: 0, textAlign: 'center' }}>
      <svg width="96" height="96" viewBox="0 0 96 96" role="img" aria-label={`${label}: ${value} of ${total}, ${p}%`}>
        <circle cx="48" cy="48" r={r} fill="none" stroke="#e5e7eb" strokeWidth="10" />
        <circle cx="48" cy="48" r={r} fill="none" stroke={COLORS.sent} strokeWidth="10" strokeDasharray={`${(c * p) / 100} ${c}`} transform="rotate(-90 48 48)" />
        <text x="48" y="53" textAnchor="middle" fontSize="16">{p}%</text>
      </svg>
      <figcaption className="small"><strong>{label}</strong><br />{value} of {total}</figcaption>
    </figure>
  );
}

function DailyChart({ messages }) {
  const [range, setRange] = useState('1w');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const days = useMemo(() => {
    let start;
    let end = Date.parse(`${day(new Date().toISOString())}T00:00:00Z`);
    if (range === 'custom') {
      if (!from || !to) return [];
      start = Date.parse(`${from}T00:00:00Z`);
      end = Date.parse(`${to}T00:00:00Z`);
    } else {
      start = end - (RANGES.find((r) => r[0] === range)[2] - 1) * DAY_MS;
    }
    const out = [];
    for (let t = start; t <= end && out.length < 366; t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
    return out;
  }, [range, from, to]);
  const series = days.map((d) => ({
    d,
    sent: messages.filter((m) => day(m.sentAt) === d).length,
    opened: messages.filter((m) => day(m.openedAt) === d).length,
    came: messages.filter((m) => day(m.cameBackAt) === d).length,
  }));
  const max = Math.max(1, ...series.flatMap((s) => [s.sent, s.opened, s.came]));
  const W = 640;
  const H = 160;
  const bw = days.length ? W / days.length : W;
  return (
    <div>
      <div className="tabs" role="tablist" aria-label="Date range">
        {RANGES.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={range === key} className={range === key ? 'active' : ''} onClick={() => setRange(key)}>{label}</button>
        ))}
      </div>
      {range === 'custom' && (
        <div className="row">
          <label className="small">From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="small">To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
      )}
      <svg width="100%" viewBox={`0 0 ${W} ${H + 20}`} role="img" aria-label="Messages sent, opened and came back per day">
        {series.map((s, i) => ['sent', 'opened', 'came'].map((k, j) => {
          const h = (s[k] / max) * (H - 10);
          return <rect key={`${s.d}-${k}`} x={i * bw + (j + 0.5) * (bw / 4)} y={H - h} width={Math.max(1, bw / 4 - 1)} height={h} fill={COLORS[k]}><title>{`${s.d}: ${s[k]} ${k === 'came' ? 'came back' : k}`}</title></rect>;
        }))}
        <line x1="0" y1={H} x2={W} y2={H} stroke="#9ca3af" />
        {series.length > 0 && <text x="0" y={H + 15} fontSize="11">{series[0].d}</text>}
        {series.length > 1 && <text x={W} y={H + 15} fontSize="11" textAnchor="end">{series.at(-1).d}</text>}
      </svg>
      <p className="small">
        <span style={{ color: COLORS.sent }}>■</span> Sent · <span style={{ color: COLORS.opened }}>■</span> Opened · <span style={{ color: COLORS.came }}>■</span> Came back
      </p>
    </div>
  );
}

function People({ people }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState(null);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return people.filter((p) => (status === 'all' || p.status === status) && (!q || p.name.toLowerCase().includes(q)));
  }, [people, query, status]);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const current = shown.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const person = people.find((p) => p.userId === selected);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '1.5rem' }}>
      <div>
        <div className="row space">
          <label className="search">
            <span className="sr-only">Search people</span>
            <input type="search" placeholder="Search by name" value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }} />
          </label>
          <select aria-label="Filter by status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }}>
            <option value="all">All statuses</option>
            {Object.entries(STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
        {shown.length === 0 && <p className="muted">Nobody matches.</p>}
        <div className="table-wrap">
          <table>
            <thead><tr><th scope="col">Person</th><th scope="col">Status</th><th scope="col">Last message</th></tr></thead>
            <tbody>
              {current.map((p) => (
                <tr key={p.userId} aria-selected={p.userId === selected}>
                  <td><button type="button" className="button ghost small" onClick={() => setSelected(p.userId)}>{p.name}</button></td>
                  <td><span className={`status-pill ${CHIP[p.status]}`}>{STATUS[p.status]}</span></td>
                  <td className="small">{when(p.lastSentAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row space">
          <button type="button" className="button ghost small" disabled={page === 0} onClick={() => setPage((n) => n - 1)}>Previous</button>
          <span className="muted small">Page {Math.min(page + 1, pages)} of {pages}</span>
          <button type="button" className="button ghost small" disabled={page + 1 >= pages} onClick={() => setPage((n) => n + 1)}>Next</button>
        </div>
      </div>
      <div>
        {!person && <p className="muted">Select a person to see every message the AI agent sent them.</p>}
        {person && (
          <>
            <h2 className="h3">{person.name}</h2>
            <ul className="support-queue">
              {person.messages.map((m) => (
                <li key={m.id} className="card">
                  <div className="notification-head"><strong>{m.title}</strong><span className="status-pill">Applied by agent</span></div>
                  <p className="muted small">
                    {m.kind === 'escalation' ? `Escalation about ${m.learnerName}` : 'Nudge'} · {m.courseTitle} · sent {when(m.sentAt)}
                  </p>
                  <p className="small">{m.openedAt ? `Opened ${when(m.openedAt)}` : 'Not opened'}{m.cameBackAt ? ` · Came back ${when(m.cameBackAt)}` : ''}</p>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function CountsTable({ rows, label }) {
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th scope="col">{label}</th><th scope="col">On time</th><th scope="col">Completed late</th><th scope="col">Overdue</th><th scope="col">At risk</th><th scope="col">On track</th><th scope="col">Total</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.group}><td>{r.group}</td><td>{r.on_time}</td><td>{r.late}</td><td>{r.overdue}</td><td>{r.at_risk}</td><td>{r.on_track}</td><td>{r.total}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Deadlines({ deadlines }) {
  const [by, setBy] = useState('organization');
  return (
    <>
      <div className="row">
        <label className="small">Group by{' '}
          <select value={by} onChange={(e) => setBy(e.target.value)}>
            <option value="organization">Organization</option>
            <option value="manager">Manager</option>
          </select>
        </label>
      </div>
      <CountsTable rows={deadlines[by]} label={by === 'organization' ? 'Organization' : 'Manager'} />
      <h2 className="h3">Per deadline</h2>
      <CountsTable rows={deadlines.byDeadline} label="Due date" />
    </>
  );
}

const VIEWS = [['people', 'People contacted'], ['stats', 'Stats'], ['deadlines', 'Deadlines']];

/** Read-only oversight of what the training follow-up AI agent sent and whether it worked. */
export function AgentOversightPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const [view, setView] = useState('people');
  useEffect(() => {
    api('/api/admin/agent-oversight').then(setData).catch(() => setError(true));
  }, []);
  const messages = useMemo(() => (data?.people ?? []).flatMap((p) => p.messages), [data]);
  return (
    <div data-ga-oversight="true">
      <PageTitle title="AI agent oversight" subtitle="Training follow-up messages the AI agent drafted and staff sent, and what happened next." />
      <p className="small"><Link to="/admin">← Admin</Link> · <Link to="/admin/agent-drafts">Drafts awaiting review</Link></p>
      <div className="tabs" role="tablist" aria-label="Oversight sections">
        {VIEWS.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={view === key} className={view === key ? 'active' : ''} onClick={() => setView(key)}>{label}</button>
        ))}
      </div>
      {error && <ErrorNote>The AI agent oversight could not be loaded.</ErrorNote>}
      {!data && !error && <Loading />}
      {data && view === 'people' && <People people={data.people} />}
      {data && view === 'stats' && (
        <>
          <div className="row">
            <Ring label="Opened out of sent" value={data.totals.opened} total={data.totals.sent} />
            <Ring label="Came back out of opened" value={data.totals.cameBackOfOpened} total={data.totals.opened} />
          </div>
          <DailyChart messages={messages} />
        </>
      )}
      {data && view === 'deadlines' && <Deadlines deadlines={data.deadlines} />}
    </div>
  );
}
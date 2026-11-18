import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { ErrorNote, Loading, PageTitle } from '../components/ui.jsx';

const STATUSES = ['Sent', 'Opened', 'Came back', 'No response yet'];
const RANGES = [['today', 'Today', 0], ['1w', '1W', 6], ['2w', '2W', 13], ['1m', '1M', 29]];
const SERIES = [['sent', 'Sent', '#5624d0'], ['opened', 'Opened', '#1e6055'], ['cameBack', 'Came back', '#b4690e']];
const isoDay = (d) => d.toISOString().slice(0, 10);
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

function presetRange(key) {
  const days = RANGES.find((r) => r[0] === key)?.[2] ?? 13;
  const to = new Date();
  return { from: isoDay(new Date(to.getTime() - days * 86_400_000)), to: isoDay(to) };
}

function Ring({ label, part, whole }) {
  const pct = whole ? Math.round((100 * part) / whole) : 0;
  const r = 40;
  const c = 2 * Math.PI * r;
  return (
    <figure className="card" style={{ textAlign: 'center', margin: 0 }}>
      <svg width="110" height="110" viewBox="0 0 110 110" role="img" aria-label={`${label}: ${part} of ${whole}, ${pct}%`}>
        <circle cx="55" cy="55" r={r} fill="none" stroke="#e5e7eb" strokeWidth="12" />
        <circle cx="55" cy="55" r={r} fill="none" stroke="#5624d0" strokeWidth="12" strokeDasharray={`${(c * pct) / 100} ${c}`} transform="rotate(-90 55 55)" />
        <text x="55" y="61" textAnchor="middle" fontSize="18">{pct}%</text>
      </svg>
      <figcaption>{label}: {part} / {whole}</figcaption>
    </figure>
  );
}

function DailyChart({ days }) {
  const max = Math.max(1, ...days.flatMap((d) => [d.sent, d.opened, d.cameBack]));
  const w = 26;
  const h = 120;
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={Math.max(220, days.length * w)} height={h + 18} role="img" aria-label="Daily sent, opened and came back">
        {days.map((d, i) => SERIES.map(([key, name, color], j) => {
          const bh = (d[key] / max) * h;
          return <rect key={`${d.date}-${key}`} x={i * w + j * 7 + 2} y={h - bh} width="6" height={bh} fill={color}><title>{`${d.date} ${name}: ${d[key]}`}</title></rect>;
        }))}
        {days.map((d, i) => (i % Math.ceil(days.length / 7) === 0 ? <text key={d.date} x={i * w + 2} y={h + 14} fontSize="10">{d.date.slice(5)}</text> : null))}
      </svg>
      <p className="small">{SERIES.map(([, name, color]) => <span key={name} style={{ marginRight: 12 }}><span style={{ color }}>■</span> {name}</span>)}</p>
    </div>
  );
}

export function AgentOversightPage() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [rangeKey, setRangeKey] = useState('2w');
  const [custom, setCustom] = useState(() => presetRange('2w'));
  const [selected, setSelected] = useState(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const range = rangeKey === 'custom' ? custom : presetRange(rangeKey);

  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), from: range.from, to: range.to });
    if (q.trim()) params.set('q', q.trim());
    if (status) params.set('status', status);
    if (selected) params.set('userId', selected);
    setError(false);
    api(`/api/admin/agent-oversight?${params}`).then(setData).catch(() => setError(true));
  }, [q, status, page, range.from, range.to, selected]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const person = data?.people.find((p) => p.userId === selected);

  return (
    <section data-ga-oversight="ga-find_95e2c1e5a8e6">
      <PageTitle title="AI agent messages" />
      <p className="muted small">Re-engagement nudges sent by the AI agent. Read-only. <Link to="/admin">Back to admin</Link></p>
      {error && <ErrorNote>The agent's messages could not be loaded.</ErrorNote>}
      {!data && !error && <Loading />}
      {data && (
        <>
          <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
            <Ring label="Opened out of sent" part={data.stats.opened} whole={data.stats.sent} />
            <Ring label="Came back out of opened" part={data.stats.cameBack} whole={data.stats.opened} />
          </div>
          <div className="row" role="group" aria-label="Date range" style={{ gap: 8, margin: '12px 0', flexWrap: 'wrap' }}>
            {RANGES.map(([key, label]) => (
              <button key={key} type="button" className={`button small${rangeKey === key ? ' dark' : ' ghost'}`} aria-pressed={rangeKey === key} onClick={() => setRangeKey(key)}>{label}</button>
            ))}
            <button type="button" className={`button small${rangeKey === 'custom' ? ' dark' : ' ghost'}`} aria-pressed={rangeKey === 'custom'} onClick={() => setRangeKey('custom')}>Custom</button>
            {rangeKey === 'custom' && (
              <>
                <input type="date" aria-label="From" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
                <input type="date" aria-label="To" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
              </>
            )}
          </div>
          <DailyChart days={data.daily} />
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 16, marginTop: 16 }}>
            <div>
              <div className="row" style={{ gap: 8 }}>
                <input type="search" aria-label="Search learners" placeholder="Search name or email" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
                <select aria-label="Filter by status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
                  <option value="">All statuses</option>
                  {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              {data.people.length === 0 && <p className="muted">No learners contacted by the agent match.</p>}
              <ul className="notification-list">
                {data.people.map((p) => (
                  <li key={p.userId} className={`card${p.userId === selected ? ' unread' : ''}`}>
                    <button type="button" className="button ghost small" onClick={() => setSelected(p.userId)} aria-pressed={p.userId === selected}>{p.name}</button>
                    <span className="badge" style={{ marginLeft: 8 }}>{p.status}</span>
                    <div className="muted small">{p.email} · {p.sent} sent · last {when(p.lastSentAt)}</div>
                  </li>
                ))}
              </ul>
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="button ghost small" disabled={page <= 1} onClick={() => setPage((n) => n - 1)}>Previous</button>
                <span className="small">Page {data.page} of {pages}</span>
                <button type="button" className="button ghost small" disabled={page >= pages} onClick={() => setPage((n) => n + 1)}>Next</button>
              </div>
            </div>
            <div>
              {!selected && <p className="muted">Select a learner to see every message the agent sent them.</p>}
              {selected && (
                <>
                  <h2 className="h3">{person?.name ?? 'Learner'}</h2>
                  <ul className="notification-list">
                    {data.messages.map((m) => (
                      <li key={m.id} className="card">
                        <div className="notification-head">
                          <strong>{m.title}</strong>
                          <span className="badge">Applied by agent</span>
                        </div>
                        <p>{m.body}</p>
                        <div className="muted small">Sent {when(m.createdAt)} · {m.openedAt ? `Opened ${when(m.openedAt)}` : 'Not opened'}{m.cameBackAt ? ` · Came back ${when(m.cameBackAt)}` : ''}</div>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
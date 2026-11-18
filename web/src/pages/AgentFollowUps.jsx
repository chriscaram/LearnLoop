import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { ErrorNote, Loading, PageTitle } from '../components/ui.jsx';
import { DailyChart, DeadlineView, Ring } from '../components/AgentFollowUpStats.jsx';

const LABELS = { sent: 'Sent', opened: 'Opened', came_back: 'Came back', no_response: 'No response yet' };
const PAGE_SIZE = 10;
const when = (iso) => (iso ? `${new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC` : '');
const chip = { padding: '2px 8px', borderRadius: 12, border: '1px solid currentColor', fontSize: 12, whiteSpace: 'nowrap' };

function Chip({ status }) {
  return <span className={`chip chip-${status}`} style={chip}>{LABELS[status]}</span>;
}

const AgentMarker = () => <span className="small" style={{ ...chip, color: '#5624d0' }}>Applied by agent</span>;

export function AgentFollowUpsPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState(null);
  const [tab, setTab] = useState('people');

  useEffect(() => { api('/api/admin/agent-follow-ups').then(setData).catch(() => setError(true)); }, []);

  const people = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.people ?? []).filter((p) => (status === 'all' || p.status === status)
      && `${p.name} ${p.organization ?? ''} ${p.department ?? ''}`.toLowerCase().includes(needle));
  }, [data, q, status]);
  const pages = Math.max(1, Math.ceil(people.length / PAGE_SIZE));
  const shown = people.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const person = data?.people.find((p) => p.userId === selected);
  const messages = useMemo(() => (data?.people ?? []).flatMap((p) => p.messages), [data]);

  return (
    <div data-ga-oversight="ga-find_a52857d8153f">
      <PageTitle title="AI training follow-ups" subtitle="Read-only: every reminder the AI agent sent, and whether it worked." />
      <p><Link to="/admin">← Back to admin</Link></p>
      {error && <ErrorNote>The follow-up history could not be loaded.</ErrorNote>}
      {!data && !error && <Loading />}
      {data && !data.enabled && <p className="muted">The AI follow-up agent is switched off.</p>}
      {data?.enabled && (
        <>
          <div className="row" role="tablist">
            {[['people', 'People'], ['stats', 'Stats'], ['deadlines', 'Deadlines']].map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={`button small ${tab === k ? 'dark' : 'ghost'}`} onClick={() => setTab(k)}>{l}</button>
            ))}
          </div>

          {tab === 'people' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 16, marginTop: 12 }}>
              <section>
                <div className="row">
                  <input type="search" aria-label="Search people" placeholder="Search by name, account or team" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
                  <select aria-label="Filter by status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }}>
                    <option value="all">All statuses</option>
                    {Object.entries(LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                </div>
                {people.length === 0 && <p className="muted">No one matches.</p>}
                <ul className="notification-list">
                  {shown.map((p) => (
                    <li key={p.userId} className={`card${selected === p.userId ? ' unread' : ''}`}>
                      <button type="button" className="button ghost small" style={{ width: '100%', textAlign: 'left' }} onClick={() => setSelected(p.userId)}>
                        <strong>{p.name}</strong> <Chip status={p.status} />
                        <br /><span className="muted small">{[p.organization, p.department].filter(Boolean).join(' · ')} · last sent {when(p.lastSentAt)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="row">
                  <button type="button" className="button ghost small" disabled={page === 0} onClick={() => setPage((n) => n - 1)}>Previous</button>
                  <span className="small">Page {page + 1} of {pages}</span>
                  <button type="button" className="button ghost small" disabled={page + 1 >= pages} onClick={() => setPage((n) => n + 1)}>Next</button>
                </div>
              </section>
              <section aria-live="polite">
                {!person && <p className="muted">Select a person to see every message the AI agent sent them.</p>}
                {person && (
                  <>
                    <h2 className="h3">{person.name}</h2>
                    <ul className="notification-list">
                      {person.messages.map((m) => (
                        <li key={m.id} className="card">
                          <div className="notification-head"><strong>{m.title}</strong> <AgentMarker /></div>
                          <p className="small muted">Sent {when(m.createdAt)} · {m.opened ? `Opened ${when(m.readAt)}` : 'Not opened'} · <Chip status={m.status} /></p>
                          <p>{m.body}</p>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </section>
            </div>
          )}

          {tab === 'stats' && (
            <div style={{ marginTop: 12 }}>
              <div className="row" style={{ gap: 16 }}>
                <Ring label="Opened out of sent" part={data.stats.opened} whole={data.stats.sent} />
                <Ring label="Came back out of opened" part={data.stats.cameBack} whole={data.stats.opened} />
              </div>
              <DailyChart messages={messages} now={data.now} />
              <h2 className="h3">Proposed manager follow-ups</h2>
              {data.escalations.length === 0 && <p className="muted">None proposed.</p>}
              <ul className="notification-list">
                {data.escalations.map((e) => (
                  <li key={e.id} className="card">
                    <div className="notification-head"><strong>{e.title}</strong> <AgentMarker /></div>
                    <p className="small muted">{when(e.createdAt)}</p>
                    <p style={{ whiteSpace: 'pre-line' }}>{e.body}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {tab === 'deadlines' && <DeadlineView rows={data.deadlines} />}
        </>
      )}
    </div>
  );
}
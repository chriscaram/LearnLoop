import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../lib/api.js';
import { formatDate } from '../lib/format.js';
import { ErrorNote, Loading, PageTitle } from '../components/ui.jsx';

const FOCUS = { not_started: 'Not started', stalled: 'Stalled partway', failed_quiz: 'Failed quiz' };

/** Staff review queue for the training follow-up AI agent: nothing is sent until staff approve. */
export function AgentDraftsPage() {
  const [drafts, setDrafts] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [edits, setEdits] = useState({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  const load = () => api('/api/admin/agent-drafts')
    .then((d) => { setDrafts(d.drafts); setSelected(new Set()); })
    .catch((e) => setError(errorMessage(e)));
  useEffect(() => { load(); }, []);

  const toggle = (id) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const edit = (d, field, value) => setEdits((all) => ({ ...all, [d.id]: { title: all[d.id]?.title ?? d.title, body: all[d.id]?.body ?? d.body, [field]: value } }));

  async function approveSelected() {
    setBusy(true);
    setNote(null);
    let sent = 0;
    let failed = 0;
    for (const id of selected) {
      try {
        await api(`/api/admin/agent-drafts/${id}/approve`, { method: 'POST', body: edits[id] ?? {} });
        sent += 1;
      } catch {
        failed += 1;
      }
    }
    setBusy(false);
    setNote(`${sent} sent${failed ? `, ${failed} could not be sent` : ''}.`);
    load();
  }

  async function reject(id) {
    try {
      await api(`/api/admin/agent-drafts/${id}/reject`, { method: 'POST', body: {} });
      load();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <>
      <PageTitle title="AI agent drafts" subtitle="Training follow-up messages written by the AI agent. Edit, approve or reject them before anything is sent." />
      <p className="small"><Link to="/admin">← Admin</Link> · <Link to="/admin/agent-oversight">AI agent oversight</Link></p>
      {error && <ErrorNote>{error}</ErrorNote>}
      {!drafts && !error && <Loading />}
      {drafts && drafts.length === 0 && <p className="muted">No drafts waiting for review.</p>}
      {drafts && drafts.length > 0 && (
        <>
          <div className="row space">
            <span className="muted small">{drafts.length} drafts · {selected.size} selected</span>
            <div className="row end">
              <button type="button" className="button ghost small" onClick={() => setSelected(new Set(drafts.map((d) => d.id)))}>Select all</button>
              <button type="button" className="button" disabled={busy || selected.size === 0} onClick={approveSelected}>{busy ? 'Sending…' : `Approve and send ${selected.size}`}</button>
            </div>
          </div>
          {note && <p className="success" role="status">{note}</p>}
          <ul className="support-queue">
            {drafts.map((d) => (
              <li key={d.id} className="card">
                <div className="notification-head">
                  <label className="row">
                    <input type="checkbox" checked={selected.has(d.id)} onChange={() => toggle(d.id)} />
                    <strong>{d.kind === 'escalation' ? `To manager ${d.recipientName} about ${d.learnerName}` : `To ${d.learnerName}`}</strong>
                  </label>
                  <span className="status-pill">Applied by agent</span>
                </div>
                <p className="muted small">{d.courseTitle} · due {formatDate(d.dueAt)}{d.focus ? ` · ${FOCUS[d.focus]}` : ''} · drafted {formatDate(d.createdAt)}</p>
                <div className="form">
                  <label htmlFor={`t-${d.id}`}>Subject</label>
                  <input id={`t-${d.id}`} maxLength={120} value={edits[d.id]?.title ?? d.title} onChange={(e) => edit(d, 'title', e.target.value)} />
                  <label htmlFor={`b-${d.id}`}>Message</label>
                  <textarea id={`b-${d.id}`} maxLength={2000} rows={4} value={edits[d.id]?.body ?? d.body} onChange={(e) => edit(d, 'body', e.target.value)} />
                  <div className="row end"><button type="button" className="button ghost small" onClick={() => reject(d.id)}>Reject</button></div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
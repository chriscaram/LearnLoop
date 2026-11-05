import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '../lib/api.js';
import { relativeDays } from '../lib/format.js';
import { ErrorNote, Loading, PageTitle } from '../components/ui.jsx';

function MessageDialog({ learner, onClose }) {
  const ref = useRef(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [state, setState] = useState({ busy: false, error: null, done: null });

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  async function send(e) {
    e.preventDefault();
    setState({ busy: true, error: null, done: null });
    try {
      const d = await api(`/api/admin/learners/${learner.userId}/message`, { method: 'POST', body: { title, body } });
      setState({ busy: false, error: null, done: d.email === 'sent' ? 'Message sent to the inbox and by email.' : 'Message added to the inbox. The email could not be sent.' });
    } catch (err) {
      setState({ busy: false, error: errorMessage(err), done: null });
    }
  }

  return (
    <dialog ref={ref} className="dialog" onClose={onClose} aria-labelledby="dialog-title">
      <form onSubmit={send} className="form">
        <h2 id="dialog-title">Message {learner.name}</h2>
        <label htmlFor="msg-title">Subject</label>
        <input id="msg-title" required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} disabled={Boolean(state.done)} />
        <label htmlFor="msg-body">Message</label>
        <textarea id="msg-body" required maxLength={2000} rows={6} value={body} onChange={(e) => setBody(e.target.value)} disabled={Boolean(state.done)} />
        {state.error && <ErrorNote>{state.error}</ErrorNote>}
        {state.done && <p className="success" role="status">{state.done}</p>}
        <div className="row end">
          <button type="button" className="button ghost" onClick={() => ref.current.close()}>{state.done ? 'Close' : 'Cancel'}</button>
          {!state.done && <button type="submit" className="button" disabled={state.busy}>{state.busy ? 'Sending…' : 'Send message'}</button>}
        </div>
      </form>
    </dialog>
  );
}

function LearnersTab() {
  const [learners, setLearners] = useState(null);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState('');
  const [messaging, setMessaging] = useState(null);

  useEffect(() => {
    api('/api/admin/learners').then((d) => setLearners(d.learners)).catch(() => setError(true));
  }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (learners ?? []).filter((l) => !q || l.name.toLowerCase().includes(q) || l.email.includes(q));
  }, [learners, query]);

  if (error) return <ErrorNote>Learners could not be loaded.</ErrorNote>;
  if (!learners) return <Loading />;
  return (
    <>
      <div className="row space">
        <label className="search">
          <span className="sr-only">Search learners</span>
          <input type="search" placeholder="Search by name or email" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <span className="muted small">{shown.length} of {learners.length} learners</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th scope="col">Name</th><th scope="col">Plan</th><th scope="col">Enrolled courses</th><th scope="col">Last activity</th><th scope="col"><span className="sr-only">Actions</span></th></tr>
          </thead>
          <tbody>
            {shown.map((l) => (
              <tr key={l.userId}>
                <td><div>{l.name}</div><div className="muted small">{l.email}</div></td>
                <td>{l.plan}</td>
                <td>{l.enrolledCourses.length ? l.enrolledCourses.join(', ') : <span className="muted">None</span>}</td>
                <td>{relativeDays(l.lastActivityAt)}</td>
                <td><button type="button" className="button ghost small" onClick={() => setMessaging(l)}>Send message</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {messaging && <MessageDialog learner={messaging} onClose={() => setMessaging(null)} />}
    </>
  );
}

function FlagsTab() {
  const [flags, setFlags] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api('/api/admin/flags').then((d) => setFlags(d.flags)).catch((e) => setError(errorMessage(e)));
  }, []);

  async function toggle(flag) {
    setError(null);
    try {
      const d = await api(`/api/admin/flags/${flag.key}`, { method: 'PUT', body: { enabled: !flag.enabled } });
      setFlags((list) => list.map((f) => (f.key === flag.key ? { ...f, enabled: d.flag.enabled } : f)));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  if (!flags) return error ? <ErrorNote>{error}</ErrorNote> : <Loading />;
  return (
    <>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="table-wrap">
        <table>
          <thead><tr><th scope="col">Flag</th><th scope="col">Description</th><th scope="col">State</th></tr></thead>
          <tbody>
            {flags.map((f) => (
              <tr key={f.key}>
                <td><code>{f.key}</code></td>
                <td>{f.description || <span className="muted">No description</span>}</td>
                <td>
                  <label className="switch">
                    <input type="checkbox" role="switch" checked={f.enabled} onChange={() => toggle(f)} aria-label={`${f.key} ${f.enabled ? 'on' : 'off'}`} />
                    <span>{f.enabled ? 'On' : 'Off'}</span>
                  </label>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">Changes apply within 30 seconds.</p>
    </>
  );
}

export function AdminPage() {
  const [tab, setTab] = useState('learners');
  return (
    <>
      <PageTitle title="Admin" />
      <div className="tabs" role="tablist" aria-label="Admin sections">
        <button type="button" role="tab" aria-selected={tab === 'learners'} className={tab === 'learners' ? 'active' : ''} onClick={() => setTab('learners')}>Learners</button>
        <button type="button" role="tab" aria-selected={tab === 'flags'} className={tab === 'flags' ? 'active' : ''} onClick={() => setTab('flags')}>Feature flags</button>
      </div>
      <div role="tabpanel">{tab === 'learners' ? <LearnersTab /> : <FlagsTab />}</div>
    </>
  );
}

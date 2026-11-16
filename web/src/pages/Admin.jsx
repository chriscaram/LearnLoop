import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '../lib/api.js';
import { formatDate, relativeDays } from '../lib/format.js';
import { topicLabel, waitingFor } from '../lib/support.js';
import { employerLine, quizAttemptsLabel, trainingStatusLabel } from '../lib/training.js';
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

function TrainingDialog({ learner, onClose }) {
  const ref = useRef(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    ref.current?.showModal();
    api(`/api/admin/learners/${learner.userId}/training`).then(setData).catch(() => setError(true));
  }, [learner.userId]);

  return (
    <dialog ref={ref} className="dialog wide" onClose={onClose} aria-labelledby="training-title">
      <h2 id="training-title">Required training: {learner.name}</h2>
      {data && (
        <p className="muted small">
          {employerLine(data.learner)}{data.learner.manager ? ` · Manager: ${data.learner.manager.name}` : ''}
        </p>
      )}
      {error && <ErrorNote>The training could not be loaded.</ErrorNote>}
      {!data && !error && <Loading />}
      {data && data.assignments.length === 0 && <p className="muted">No required courses.</p>}
      {data && data.assignments.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th scope="col">Course</th><th scope="col">Due</th><th scope="col">Status</th><th scope="col">Progress</th><th scope="col">Quizzes</th></tr></thead>
            <tbody>
              {data.assignments.map((a) => (
                <tr key={a.id}>
                  <td>{a.courseTitle}</td>
                  <td>{formatDate(a.dueAt)}</td>
                  <td><span className={`status-pill ${a.status === 'overdue' ? 'open' : a.status === 'completed' ? 'answered' : ''}`}>{trainingStatusLabel(a)}</span></td>
                  <td>{a.percent}% · {a.completedLessons} of {a.totalLessons} lessons</td>
                  <td>{quizAttemptsLabel(a)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="row end">
        <button type="button" className="button ghost" onClick={() => ref.current.close()}>Close</button>
      </div>
    </dialog>
  );
}

function LearnersTab() {
  const [learners, setLearners] = useState(null);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState('');
  const [messaging, setMessaging] = useState(null);
  const [training, setTraining] = useState(null);

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
                <td><div>{l.name}</div><div className="muted small">{l.email}</div>{l.organization && <div className="muted small">{employerLine(l)}</div>}</td>
                <td>{l.plan}</td>
                <td>{l.enrolledCourses.length ? l.enrolledCourses.join(', ') : <span className="muted">None</span>}</td>
                <td>{relativeDays(l.lastActivityAt)}</td>
                <td>
                  <div className="row end">
                    {l.organization && <button type="button" className="button ghost small" onClick={() => setTraining(l)}>Training</button>}
                    <button type="button" className="button ghost small" onClick={() => setMessaging(l)}>Send message</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {messaging && <MessageDialog learner={messaging} onClose={() => setMessaging(null)} />}
      {training && <TrainingDialog learner={training} onClose={() => setTraining(null)} />}
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

function SupportRequest({ request, onReplied }) {
  const [body, setBody] = useState('');
  const [state, setState] = useState({ busy: false, error: null });

  async function reply(e) {
    e.preventDefault();
    setState({ busy: true, error: null });
    try {
      await api(`/api/admin/support-requests/${request.id}/reply`, { method: 'POST', body: { body } });
      onReplied(request.id);
    } catch (err) {
      setState({ busy: false, error: errorMessage(err) });
    }
  }

  return (
    <li className="card">
      <div className="notification-head">
        <h3 className="h3">{topicLabel(request.topic)} · {request.learner?.name ?? 'Unknown learner'}</h3>
        <span className={`status-pill ${request.overdue ? 'open' : ''}`}>
          {request.overdue ? `Overdue, waiting ${waitingFor(request.createdAt)}` : `Waiting ${waitingFor(request.createdAt)}`}
        </span>
      </div>
      <p className="muted small">{request.learner?.email} · asked on {formatDate(request.createdAt)}</p>
      <p className="support-body">{request.body}</p>
      <form className="form" onSubmit={reply}>
        <label htmlFor={`reply-${request.id}`}>Reply</label>
        <textarea id={`reply-${request.id}`} required maxLength={2000} rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
        {state.error && <ErrorNote>{state.error}</ErrorNote>}
        <div className="row end">
          <button type="submit" className="button" disabled={state.busy || !body.trim()}>{state.busy ? 'Sending…' : 'Send reply'}</button>
        </div>
      </form>
    </li>
  );
}

function SupportTab() {
  const [requests, setRequests] = useState(null);
  const [error, setError] = useState(false);
  const [sent, setSent] = useState(0);

  useEffect(() => {
    api('/api/admin/support-requests').then((d) => setRequests(d.supportRequests)).catch(() => setError(true));
  }, []);

  if (error) return <ErrorNote>Support requests could not be loaded.</ErrorNote>;
  if (!requests) return <Loading />;
  const overdue = requests.filter((r) => r.overdue).length;
  return (
    <>
      <div className="row space">
        <span className="muted small">
          {requests.length} open {requests.length === 1 ? 'question' : 'questions'}, oldest first{overdue ? ` · ${overdue} waiting longer than one business day` : ''}
        </span>
        {sent > 0 && <span className="success small" role="status">{sent} {sent === 1 ? 'reply' : 'replies'} sent</span>}
      </div>
      {requests.length === 0 && <p className="muted">No open questions. Everything has been answered.</p>}
      <ul className="support-queue">
        {requests.map((r) => (
          <SupportRequest key={r.id} request={r} onReplied={(id) => { setRequests((list) => list.filter((x) => x.id !== id)); setSent((n) => n + 1); }} />
        ))}
      </ul>
    </>
  );
}

const TABS = [['learners', 'Learners'], ['support', 'Support requests'], ['flags', 'Feature flags']];

export function AdminPage() {
  const [tab, setTab] = useState('learners');
  return (
    <>
      <PageTitle title="Admin" />
      <div className="tabs" role="tablist" aria-label="Admin sections">
        {TABS.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>
      <div role="tabpanel">{tab === 'learners' ? <LearnersTab /> : tab === 'support' ? <SupportTab /> : <FlagsTab />}</div>
    </>
  );
}

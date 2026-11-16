import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api.js';
import { formatDate } from '../lib/format.js';
import { SUPPORT_TOPICS, supportStatusLabel, topicLabel } from '../lib/support.js';
import { ErrorNote, Loading, PageTitle } from '../components/ui.jsx';

function AskForm({ onAsked }) {
  const [topic, setTopic] = useState(SUPPORT_TOPICS[0][0]);
  const [body, setBody] = useState('');
  const [state, setState] = useState({ busy: false, error: null, done: false });

  async function submit(e) {
    e.preventDefault();
    setState({ busy: true, error: null, done: false });
    try {
      const d = await api('/api/me/support-requests', { method: 'POST', body: { topic, body } });
      setBody('');
      setState({ busy: false, error: null, done: true });
      onAsked(d.supportRequest);
    } catch (err) {
      setState({ busy: false, error: errorMessage(err), done: false });
    }
  }

  return (
    <form className="form card" onSubmit={submit}>
      <h2 className="h3">Ask the LearnLoop team</h2>
      <p className="muted small">We reply within one business day. You will find the answer here and in your notifications.</p>
      <label htmlFor="help-topic">Topic</label>
      <select id="help-topic" value={topic} onChange={(e) => setTopic(e.target.value)}>
        {SUPPORT_TOPICS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select>
      <label htmlFor="help-body">Your question</label>
      <textarea id="help-body" required maxLength={2000} rows={5} value={body} onChange={(e) => setBody(e.target.value)} />
      {state.error && <ErrorNote>{state.error}</ErrorNote>}
      {state.done && <p className="success" role="status">Thanks, your question has been sent.</p>}
      <div className="row end">
        <button type="submit" className="button" disabled={state.busy || !body.trim()}>{state.busy ? 'Sending…' : 'Send question'}</button>
      </div>
    </form>
  );
}

export function HelpPage() {
  const [requests, setRequests] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    api('/api/me/support-requests').then((d) => setRequests(d.supportRequests)).catch(() => setError(true));
  }, []);

  return (
    <>
      <PageTitle title="Help and support" subtitle="Questions about billing, certificates, your account or a course." />
      <AskForm onAsked={(r) => setRequests((list) => [r, ...(list ?? [])])} />
      <h2 className="h3 help-history-title">Your questions</h2>
      {error && <ErrorNote>Your questions could not be loaded.</ErrorNote>}
      {!requests && !error && <Loading />}
      {requests?.length === 0 && <p className="muted">You have not asked anything yet.</p>}
      <ul className="card-list support-list">
        {requests?.map((r) => (
          <li key={r.id} className="card">
            <div className="notification-head">
              <h3 className="h3">{topicLabel(r.topic)}</h3>
              <span className={`status-pill ${r.status}`}>{supportStatusLabel(r)}</span>
            </div>
            <p className="muted small">Asked on {formatDate(r.createdAt)}</p>
            <p className="support-body">{r.body}</p>
            {r.replies.map((reply, i) => (
              <div key={i} className="support-reply">
                <p className="small"><strong>{reply.staffName}</strong> from the LearnLoop team · {formatDate(reply.createdAt)}</p>
                <p className="support-body">{reply.body}</p>
              </div>
            ))}
          </li>
        ))}
      </ul>
    </>
  );
}

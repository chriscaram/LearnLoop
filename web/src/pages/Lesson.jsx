import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errorMessage } from '../lib/api.js';
import { formatDuration } from '../lib/format.js';
import { markdownToHtml } from '../lib/markdown.js';
import { useSession } from '../lib/session.jsx';
import { ErrorNote, Loading } from '../components/ui.jsx';

function Quiz({ lessonId, quiz }) {
  const [answers, setAnswers] = useState({});
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    try {
      const d = await api(`/api/lessons/${lessonId}/quiz`, { method: 'POST', body: { answers } });
      setResult(d.result);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <section className="card quiz" aria-labelledby="quiz-heading">
      <h2 id="quiz-heading">Check your understanding</h2>
      <form onSubmit={submit}>
        {quiz.questions.map((q, qi) => {
          const outcome = result?.results.find((r) => r.id === q.id);
          return (
            <fieldset key={q.id} className="question">
              <legend>{qi + 1}. {q.prompt}</legend>
              {q.options.map((option, oi) => (
                <label key={option} className={`option${outcome && outcome.answerIndex === oi ? ' correct' : ''}`}>
                  <input type="radio" name={q.id} value={oi} checked={answers[q.id] === oi} disabled={Boolean(result)} onChange={() => setAnswers({ ...answers, [q.id]: oi })} />
                  {option}
                </label>
              ))}
            </fieldset>
          );
        })}
        {error && <ErrorNote>{error}</ErrorNote>}
        {result ? (
          <p className="stat" role="status">Score: {result.score}% ({result.correct} of {result.total} correct)</p>
        ) : (
          <button type="submit" className="button" disabled={Object.keys(answers).length < quiz.questions.length}>Submit answers</button>
        )}
      </form>
    </section>
  );
}

export function LessonPage() {
  const { lessonId } = useParams();
  const { invalidateProgress } = useSession();
  const [lesson, setLesson] = useState(null);
  const [siblings, setSiblings] = useState([]);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState('not_started');

  useEffect(() => {
    let cancelled = false;
    setLesson(null);
    setError(null);
    api(`/api/lessons/${lessonId}`).then(async ({ lesson: l }) => {
      if (cancelled) return;
      setLesson(l);
      setStatus(l.status);
      api(`/api/courses/${l.courseId}/lessons`).then((d) => !cancelled && setSiblings(d.lessons)).catch(() => {});
      if (l.status !== 'completed') {
        await api(`/api/lessons/${lessonId}/progress`, { method: 'POST', body: { status: 'started' } });
        if (!cancelled) setStatus('started');
        invalidateProgress();
      }
    }).catch((e) => !cancelled && setError(errorMessage(e)));
    return () => { cancelled = true; };
  }, [lessonId, invalidateProgress]);

  const html = useMemo(() => markdownToHtml(lesson?.bodyMarkdown ?? ''), [lesson]);
  const index = siblings.findIndex((s) => s.id === lessonId);
  const next = index >= 0 ? siblings[index + 1] : null;
  const previous = index > 0 ? siblings[index - 1] : null;

  async function complete() {
    try {
      await api(`/api/lessons/${lessonId}/progress`, { method: 'POST', body: { status: 'completed' } });
      setStatus('completed');
      setSiblings((list) => list.map((s) => (s.id === lessonId ? { ...s, status: 'completed' } : s)));
      invalidateProgress();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  if (error && !lesson) {
    return <ErrorNote>{error} <Link to="/courses">Back to courses</Link></ErrorNote>;
  }
  if (!lesson) return <Loading />;

  return (
    <div className="lesson-layout">
      <article className="lesson">
        <p><Link to={`/courses/${lesson.courseId}`}>Back to course</Link></p>
        <div className="eyebrow">Lesson {lesson.position} · {formatDuration(lesson.durationMin)}</div>
        <h1>{lesson.title}</h1>
        <figure className="video-placeholder" aria-label={`Lesson video, ${lesson.durationMin} minutes`}>
          <div className="play" aria-hidden="true">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
          </div>
          <figcaption>Video · {formatDuration(lesson.durationMin)}</figcaption>
        </figure>
        {/* eslint-disable-next-line react/no-danger -- markdownToHtml escapes all input */}
        <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />
        <div className="lesson-actions">
          {status === 'completed'
            ? <p className="success" role="status">Lesson completed</p>
            : <button type="button" className="button" onClick={complete}>Mark lesson as complete</button>}
          <div className="pager">
            {previous && <Link to={`/lessons/${previous.id}`}>Previous: {previous.title}</Link>}
            {next && <Link to={`/lessons/${next.id}`}>Next: {next.title}</Link>}
          </div>
        </div>
        {lesson.quiz && <Quiz key={lesson.id} lessonId={lesson.id} quiz={lesson.quiz} />}
      </article>
      <aside className="lesson-sidebar" aria-label="Course lessons">
        <h2 className="h3">In this course</h2>
        <ol>
          {siblings.map((s) => (
            <li key={s.id} className={s.id === lessonId ? 'current' : ''}>
              <Link to={`/lessons/${s.id}`} aria-current={s.id === lessonId ? 'page' : undefined}>{s.title}</Link>
              <span className={`status-dot ${s.id === lessonId ? status : s.status}`} aria-label={(s.id === lessonId ? status : s.status).replace('_', ' ')} />
            </li>
          ))}
        </ol>
      </aside>
    </div>
  );
}

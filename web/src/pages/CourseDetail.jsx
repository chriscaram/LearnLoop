import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, errorMessage } from '../lib/api.js';
import { formatDuration } from '../lib/format.js';
import { useSession } from '../lib/session.jsx';
import { ErrorNote, Loading, ProgressBar } from '../components/ui.jsx';

export function CourseDetailPage() {
  const { courseId } = useParams();
  const { user, progress, loadProgress, invalidateProgress } = useSession();
  const navigate = useNavigate();
  const [course, setCourse] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setCourse(null);
    api(`/api/courses/${courseId}`).then((d) => setCourse(d.course)).catch((e) => setError(e.status === 404 ? 'Course not found.' : errorMessage(e)));
  }, [courseId]);

  useEffect(() => {
    if (course?.enrolled) loadProgress().catch(() => {});
  }, [course?.enrolled, loadProgress]);

  async function enrol() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/courses/${courseId}/enrol`, { method: 'POST' });
      invalidateProgress();
      navigate(`/lessons/${course.lessons[0].id}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  if (error && !course) return <ErrorNote>{error}</ErrorNote>;
  if (!course) return <Loading />;
  const mine = progress?.find((p) => p.courseId === course.id);

  return (
    <article className="course-detail">
      <p><Link to="/courses">All courses</Link></p>
      <div className="eyebrow">{course.category} · {course.level}</div>
      <h1>{course.title}</h1>
      <p className="lead">{course.description}</p>
      <div className="card action-card">
        {!user && <p><Link to="/login">Sign in</Link> to enrol in this course.</p>}
        {user && !course.enrolled && (
          <button type="button" className="button" onClick={enrol} disabled={busy}>{busy ? 'Enrolling…' : 'Enrol in this course'}</button>
        )}
        {user && course.enrolled && (
          <>
            {mine && <ProgressBar percent={mine.percent} label={`${course.title} progress`} />}
            {mine && <p className="muted small">{mine.percent}% complete</p>}
            {mine?.nextLesson
              ? <Link className="button" to={`/lessons/${mine.nextLesson.id}`}>Continue: {mine.nextLesson.title}</Link>
              : <Link className="button" to={`/lessons/${course.lessons[0].id}`}>Open the first lesson</Link>}
          </>
        )}
        {error && <ErrorNote>{error} {error.includes('subscription') && <Link to="/subscription">See plans</Link>}</ErrorNote>}
      </div>
      <h2>Lessons</h2>
      <ol className="lesson-outline">
        {course.lessons.map((l) => (
          <li key={l.id}>
            <span>{l.title}</span>
            <span className="muted small">{formatDuration(l.durationMin)}</span>
          </li>
        ))}
      </ol>
    </article>
  );
}

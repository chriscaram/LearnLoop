import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { formatDuration } from '../lib/format.js';
import { ErrorNote, Loading, PageTitle } from '../components/ui.jsx';

export function CoursesPage() {
  const [params, setParams] = useSearchParams();
  const category = params.get('category');
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const query = category ? `?category=${encodeURIComponent(category)}` : '';
    api(`/api/courses${query}`).then(setData).catch(() => setError(true));
  }, [category]);

  return (
    <>
      <PageTitle title="Courses" subtitle="Every course is included in your subscription." />
      {data?.categories && (
        <div className="filters" role="group" aria-label="Filter by category">
          <button type="button" className={`chip${category ? '' : ' active'}`} aria-pressed={!category} onClick={() => setParams({})}>All</button>
          {data.categories.map((c) => (
            <button key={c} type="button" className={`chip${category === c ? ' active' : ''}`} aria-pressed={category === c} onClick={() => setParams({ category: c })}>{c}</button>
          ))}
        </div>
      )}
      {error && <ErrorNote>The catalog could not be loaded.</ErrorNote>}
      {!data && !error && <Loading />}
      <div className="course-grid">
        {data?.courses.map((c) => (
          <article key={c.id} className="card course-card">
            <div className="eyebrow">{c.category} · {c.level}</div>
            <h2 className="h3"><Link to={`/courses/${c.id}`}>{c.title}</Link></h2>
            <p>{c.summary}</p>
            <p className="muted small">{c.lessonCount} lessons · {formatDuration(c.durationMin)}</p>
          </article>
        ))}
      </div>
    </>
  );
}

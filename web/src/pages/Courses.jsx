import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { courseMeta, matchesQuery } from '../data/catalog.js';
import { Carousel, CourseCard, CourseRow, Stars } from '../components/course.jsx';
import { ErrorNote, Loading } from '../components/ui.jsx';

const SORTS = {
  popular: { label: 'Most Popular', fn: (a, b) => courseMeta(b.id).students - courseMeta(a.id).students },
  rated: { label: 'Highest Rated', fn: (a, b) => courseMeta(b.id).rating - courseMeta(a.id).rating },
  reviewed: { label: 'Most Reviewed', fn: (a, b) => courseMeta(b.id).ratingCount - courseMeta(a.id).ratingCount },
  price: { label: 'Lowest Price', fn: (a, b) => courseMeta(a.id).price - courseMeta(b.id).price },
};
const DURATIONS = [['short', 'Under 2 hours', (m) => m < 120], ['medium', '2–3 hours', (m) => m >= 120 && m <= 180], ['long', '3+ hours', (m) => m > 180]];

export function CoursesPage() {
  const [params, setParams] = useSearchParams();
  const category = params.get('category');
  const query = params.get('q') ?? '';
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const [sort, setSort] = useState('popular');
  const [minRating, setMinRating] = useState(0);
  const [levels, setLevels] = useState([]);
  const [durations, setDurations] = useState([]);

  useEffect(() => {
    const q = category ? `?category=${encodeURIComponent(category)}` : '';
    setData(null);
    api(`/api/courses${q}`).then(setData).catch(() => setError(true));
  }, [category]);

  const toggle = (list, setList, v) => setList(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const shown = useMemo(() => {
    if (!data) return [];
    return data.courses
      .filter((c) => matchesQuery(c, query))
      .filter((c) => courseMeta(c.id).rating >= minRating)
      .filter((c) => !levels.length || levels.includes(c.level))
      .filter((c) => !durations.length || DURATIONS.some(([k, , f]) => durations.includes(k) && f(c.durationMin)))
      .sort(SORTS[sort].fn);
  }, [data, query, minRating, levels, durations, sort]);

  const allLevels = [...new Set(data?.courses.map((c) => c.level) ?? [])];
  const heading = query ? `${shown.length} results for “${query}”` : category ? `${category} Courses` : 'All courses';
  const filtersOn = minRating || levels.length || durations.length;

  return (
    <div className="container page courses-page">
      <nav className="crumbs" aria-label="Breadcrumb"><Link to="/courses">Courses</Link>{category && <> <span aria-hidden="true">›</span> {category}</>}</nav>
      <h1 className="results-title">{heading}</h1>
      {!query && <p className="muted">Courses to get you started, taught by real-world experts. Every course is included in the Personal Plan.</p>}

      {data?.categories && (
        <div className="filters" role="group" aria-label="Filter by category">
          <button type="button" className={`chip${category ? '' : ' active'}`} aria-pressed={!category} onClick={() => setParams(query ? { q: query } : {})}>All</button>
          {data.categories.map((c) => (
            <button key={c} type="button" className={`chip${category === c ? ' active' : ''}`} aria-pressed={category === c} onClick={() => setParams(query ? { category: c, q: query } : { category: c })}>{c}</button>
          ))}
        </div>
      )}

      {error && <ErrorNote>The catalog could not be loaded.</ErrorNote>}
      {!data && !error && <Loading />}

      {data && !query && (
        <section className="rail">
          <h2>{category ? `Most popular in ${category}` : 'Courses to get you started'}</h2>
          <Carousel label="Most popular">
            {[...data.courses].sort(SORTS.popular.fn).map((c) => <CourseCard key={c.id} course={c} />)}
          </Carousel>
        </section>
      )}

      {data && (
        <>
          <h2 className="section-title">{query ? 'Results' : category ? `All ${category} courses` : 'All courses'}</h2>
          <div className="results-toolbar">
            <label className="sort-select">
              <span>Sort by</span>
              <select value={sort} onChange={(e) => setSort(e.target.value)}>
                {Object.entries(SORTS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
              </select>
            </label>
            {filtersOn ? <button type="button" className="link-button" onClick={() => { setMinRating(0); setLevels([]); setDurations([]); }}>Clear filters</button> : null}
            <span className="results-count">{shown.length} results</span>
          </div>
          <div className="results-layout">
            <aside className="filter-panel" aria-label="Filters">
              <fieldset>
                <legend>Ratings</legend>
                {[4.5, 4.0, 0].map((r) => (
                  <label key={r} className="filter-option">
                    <input type="radio" name="rating" checked={minRating === r} onChange={() => setMinRating(r)} />
                    {r ? <><Stars rating={r} /> <span>{r.toFixed(1)} &amp; up</span></> : <span>Any rating</span>}
                  </label>
                ))}
              </fieldset>
              <fieldset>
                <legend>Video duration</legend>
                {DURATIONS.map(([k, label]) => (
                  <label key={k} className="filter-option">
                    <input type="checkbox" checked={durations.includes(k)} onChange={() => toggle(durations, setDurations, k)} /> {label}
                  </label>
                ))}
              </fieldset>
              <fieldset>
                <legend>Level</legend>
                {allLevels.map((l) => (
                  <label key={l} className="filter-option">
                    <input type="checkbox" checked={levels.includes(l)} onChange={() => toggle(levels, setLevels, l)} /> {l}
                  </label>
                ))}
              </fieldset>
            </aside>
            <div className="results-list">
              {shown.length === 0 && (
                <div className="empty-results">
                  <h3>Sorry, we couldn’t find any results{query ? ` for “${query}”` : ''}</h3>
                  <p>Try adjusting your search or filters. Here are some ideas:</p>
                  <ul><li>Make sure all words are spelled correctly</li><li>Try different search terms</li><li>Try more general search terms</li></ul>
                </div>
              )}
              {shown.map((c) => <CourseRow key={c.id} course={c} />)}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

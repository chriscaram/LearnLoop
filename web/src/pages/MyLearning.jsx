import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useCart } from '../lib/cart.jsx';
import { useSession } from '../lib/session.jsx';
import { relativeDays } from '../lib/format.js';
import { courseMeta } from '../data/catalog.js';
import { CourseCard, Stars } from '../components/course.jsx';
import { ErrorNote, Loading, ProgressBar } from '../components/ui.jsx';

function LearningCard({ c }) {
  const meta = courseMeta(c.courseId);
  const target = c.nextLesson ? `/lessons/${c.nextLesson.id}` : `/courses/${c.courseId}`;
  return (
    <article className="learning-card">
      <Link to={target} className="course-tile-link">
        <div className="thumb play">
          <img src={meta.image} alt="" loading="lazy" width="480" height="270" />
        </div>
        <h3 className="course-tile-title">{c.courseTitle}</h3>
      </Link>
      <p className="course-tile-instructor">{meta.instructor.name}</p>
      <ProgressBar percent={c.percent} label={`${c.courseTitle} progress`} />
      <div className="learning-foot">
        <span className="small">{c.percent ? `${c.percent}% complete` : 'Start course'}</span>
        <span className="small muted">{relativeDays(c.lastActivityAt)}</span>
      </div>
      <div className="learning-foot">
        <Stars rating={meta.rating} />
        <span className="small muted">Leave a rating</span>
      </div>
    </article>
  );
}

export function MyLearningPage() {
  const { progress, loadProgress } = useSession();
  const { wishlist } = useCart();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'wishlist' ? 'wishlist' : 'all';
  const [error, setError] = useState(false);

  useEffect(() => {
    loadProgress({ force: true }).catch(() => setError(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="my-learning">
      <div className="ml-band">
        <div className="container">
          <h1>My learning</h1>
          <div className="ml-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'all'} className={tab === 'all' ? 'active' : ''} onClick={() => setParams({})}>All courses</button>
            <button type="button" role="tab" aria-selected={tab === 'wishlist'} className={tab === 'wishlist' ? 'active' : ''} onClick={() => setParams({ tab: 'wishlist' })}>Wishlist</button>
          </div>
        </div>
      </div>
      <div className="container page">
        {tab === 'all' && (
          <>
            {error && <ErrorNote>Your courses could not be loaded.</ErrorNote>}
            {progress === null && !error && <Loading />}
            {progress?.length === 0 && (
              <div className="cart-empty">
                <p>Start learning from over 12 expert-led courses.</p>
                <Link to="/courses" className="button primary large">Browse now</Link>
              </div>
            )}
            <div className="tile-grid">
              {progress?.map((c) => <LearningCard key={c.courseId} c={c} />)}
            </div>
          </>
        )}
        {tab === 'wishlist' && (
          <>
            {wishlist.length === 0 && (
              <div className="cart-empty">
                <p>Your wishlist is empty. Tap the heart on any course to save it for later.</p>
                <Link to="/courses" className="button primary large">Browse courses</Link>
              </div>
            )}
            <div className="tile-grid">{wishlist.map((c) => <CourseCard key={c.id} course={c} />)}</div>
          </>
        )}
      </div>
    </div>
  );
}

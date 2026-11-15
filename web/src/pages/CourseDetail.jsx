import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, errorMessage } from '../lib/api.js';
import { formatDuration } from '../lib/format.js';
import { useCart } from '../lib/cart.jsx';
import { useSession } from '../lib/session.jsx';
import { courseMeta, formatCount, formatPrice, groupLessons, ratingBreakdown, reviewsFor } from '../data/catalog.js';
import { Avatar, Badge, Carousel, CourseCard, Stars } from '../components/course.jsx';
import {
  AlertIcon, CheckIcon, ClockIcon, DownloadIcon, FileIcon, GlobeIcon, HeartIcon, MobileIcon, PlayIcon, QuizIcon, StarIcon, TrophyIcon, UsersIcon, VideoIcon,
} from '../components/icons.jsx';
import { ErrorNote, Loading, ProgressBar } from '../components/ui.jsx';

function PurchaseCard({ course, meta, mine, subscription, onEnrol, busy, error }) {
  const { user } = useSession();
  const cart = useCart();
  const navigate = useNavigate();
  const inCart = cart.inCart(course.id);
  const saved = cart.inWishlist(course.id);
  const quizCount = meta.sections.length || 2;

  function buyNow() {
    cart.add(course);
    navigate(user ? '/checkout' : '/cart');
  }

  return (
    <div className="purchase-card">
      <div className="preview">
        <img src={meta.image} alt="" width="480" height="270" />
        <span className="preview-play" aria-hidden="true"><PlayIcon width="34" height="34" /></span>
        <span className="preview-label">Preview this course</span>
      </div>
      <div className="purchase-body">
        {course.enrolled ? (
          <>
            <p className="enrolled-note">You are enrolled in this course</p>
            {mine && <ProgressBar percent={mine.percent} label={`${course.title} progress`} />}
            {mine && <p className="muted small">{mine.percent}% complete · {mine.completedLessons} of {mine.totalLessons} lectures</p>}
            <Link className="button primary block large" to={mine?.nextLesson ? `/lessons/${mine.nextLesson.id}` : `/lessons/${course.lessons[0].id}`}>
              {mine?.completedLessons ? 'Continue course' : 'Go to course'}
            </Link>
          </>
        ) : (
          <>
            <div className="purchase-price">
              <strong>{formatPrice(meta.price)}</strong>
              <s>{formatPrice(meta.listPrice)}</s>
              <span>{meta.discountPercent}% off</span>
            </div>
            <p className="urgency"><ClockIcon width="16" height="16" /> <strong>2 days</strong> left at this price!</p>
            <div className="purchase-actions">
              {inCart
                ? <Link to="/cart" className="button primary large grow">Go to cart</Link>
                : <button type="button" className="button primary large grow" onClick={() => cart.add(course)}>Add to cart</button>}
              <button type="button" className={`button outline square${saved ? ' saved' : ''}`} aria-pressed={saved} aria-label={saved ? 'Remove from wishlist' : 'Add to wishlist'} onClick={() => cart.toggleWishlist(course)}>
                <HeartIcon filled={saved} />
              </button>
            </div>
            <button type="button" className="button outline block large" onClick={buyNow}>Buy now</button>
            {user && subscription?.active && (
              <button type="button" className="button dark block" onClick={onEnrol} disabled={busy}>{busy ? 'Enrolling…' : 'Enroll now · included in your plan'}</button>
            )}
            {!user && <p className="small center"><Link to="/login">Log in</Link> to enroll with your Personal Plan.</p>}
            <p className="guarantee">30-Day Money-Back Guarantee</p>
            <p className="guarantee sub">Full Lifetime Access</p>
          </>
        )}
        {error && <ErrorNote>{error} {error.includes('subscription') && <Link to="/subscription">See plans</Link>}</ErrorNote>}
        <div className="includes">
          <h2>This course includes:</h2>
          <ul>
            <li><VideoIcon width="16" height="16" /> {formatDuration(course.durationMin)} on-demand video</li>
            <li><FileIcon width="16" height="16" /> {course.lessons.length} articles</li>
            <li><QuizIcon width="16" height="16" /> {quizCount} practice quizzes</li>
            <li><DownloadIcon width="16" height="16" /> {Math.max(3, course.lessons.length - 2)} downloadable resources</li>
            <li><MobileIcon width="16" height="16" /> Access on mobile and TV</li>
            <li><TrophyIcon width="16" height="16" /> Certificate of completion</li>
          </ul>
        </div>
        <div className="share-row">
          <button type="button" className="link-button" onClick={() => navigator.clipboard?.writeText(window.location.href)}>Share</button>
          <a className="link-button" href="#main">Gift this course</a>
          <a className="link-button" href="#main">Apply coupon</a>
        </div>
      </div>
    </div>
  );
}

export function CourseDetailPage() {
  const { courseId } = useParams();
  const { user, progress, loadProgress, invalidateProgress } = useSession();
  const navigate = useNavigate();
  const [course, setCourse] = useState(null);
  const [related, setRelated] = useState([]);
  const [subscription, setSubscription] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [openAll, setOpenAll] = useState(false);
  const [showFullDesc, setShowFullDesc] = useState(false);

  useEffect(() => {
    setCourse(null);
    setError(null);
    window.scrollTo(0, 0);
    api(`/api/courses/${courseId}`).then((d) => setCourse(d.course)).catch((e) => setError(e.status === 404 ? 'Course not found.' : errorMessage(e)));
    api('/api/courses').then((d) => setRelated(d.courses.filter((c) => c.id !== courseId))).catch(() => {});
  }, [courseId]);

  useEffect(() => {
    if (user) api('/api/me/subscription').then((d) => setSubscription(d.subscription)).catch(() => {});
  }, [user]);

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

  if (error && !course) return <div className="container page"><ErrorNote>{error}</ErrorNote></div>;
  if (!course) return <div className="container page"><Loading /></div>;

  const meta = courseMeta(course.id);
  const mine = progress?.find((p) => p.courseId === course.id);
  const sections = groupLessons(course.id, course.lessons);
  const breakdown = ratingBreakdown(meta.rating);
  const reviews = reviewsFor(course.category);
  const alsoBought = [...related.filter((c) => c.category === course.category), ...related.filter((c) => c.category !== course.category)].slice(0, 8);
  const byInstructor = related.filter((c) => courseMeta(c.id).instructor.id === meta.instructor.id);

  return (
    <article className="course-detail">
      <div className="course-band">
        <div className="container course-band-inner">
          <div className="course-band-text">
            <nav className="crumbs light" aria-label="Breadcrumb">
              <Link to="/courses">Courses</Link> <span aria-hidden="true">›</span> <Link to={`/courses?category=${course.category}`}>{course.category}</Link> <span aria-hidden="true">›</span> <span>{course.level}</span>
            </nav>
            <h1>{course.title}</h1>
            <p className="course-subtitle">{course.summary}</p>
            <div className="course-stats">
              <Badge kind={meta.badge} />
              <span className="rating light"><strong className="rating-number">{meta.rating.toFixed(1)}</strong><Stars rating={meta.rating} /></span>
              <a href="#reviews" className="light-link">({formatCount(meta.ratingCount)} ratings)</a>
              <span>{formatCount(meta.students)} students</span>
            </div>
            <p className="created-by">Created by <a href="#instructor" className="light-link">{meta.instructor.name}</a></p>
            <p className="course-facts">
              <span><AlertIcon width="16" height="16" /> Last updated {meta.updated}</span>
              <span><GlobeIcon width="16" height="16" /> English</span>
              <span>English [Auto], Spanish [Auto]</span>
            </p>
          </div>
        </div>
      </div>

      <div className="container course-layout">
        <div className="course-main">
          {meta.outcomes.length > 0 && (
            <section className="learn-box">
              <h2>What you’ll learn</h2>
              <ul>
                {meta.outcomes.map((o) => <li key={o}><CheckIcon width="16" height="16" /> {o}</li>)}
              </ul>
            </section>
          )}

          <section className="course-content">
            <h2>Course content</h2>
            <div className="content-summary">
              <span>{sections.length} sections · {course.lessons.length} lectures · {formatDuration(course.durationMin)} total length</span>
              <button type="button" className="link-button" onClick={() => setOpenAll((v) => !v)}>{openAll ? 'Collapse all sections' : 'Expand all sections'}</button>
            </div>
            <div className="accordion">
              {sections.map((s, i) => (
                <details key={`${s.title}-${openAll}`} open={openAll || i === 0}>
                  <summary>
                    <span className="section-name">{s.title}</span>
                    <span className="section-meta">{s.lessons.length} lectures · {formatDuration(s.lessons.reduce((m, l) => m + l.durationMin, 0))}</span>
                  </summary>
                  <ul>
                    {s.lessons.map((l, li) => (
                      <li key={l.id}>
                        <PlayIcon width="14" height="14" />
                        {course.enrolled ? <Link to={`/lessons/${l.id}`}>{l.title}</Link> : <span>{l.title}</span>}
                        {!course.enrolled && i === 0 && li === 0 && <span className="preview-link">Preview</span>}
                        <span className="lesson-time">{formatDuration(l.durationMin)}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              ))}
            </div>
          </section>

          {meta.requirements.length > 0 && (
            <section>
              <h2>Requirements</h2>
              <ul className="bullets">{meta.requirements.map((r) => <li key={r}>{r}</li>)}</ul>
            </section>
          )}

          <section className={`description${showFullDesc ? ' open' : ''}`}>
            <h2>Description</h2>
            <div className="desc-body">
            <p>{course.description}</p>
            <p>This course is built for busy professionals. Every lecture is short and focused, every section ends with a practice quiz, and you can learn at your own pace on any device. By the end you will have a set of skills you can apply at work straight away.</p>
            {meta.audience.length > 0 && (
              <>
                <h3>Who this course is for:</h3>
                <ul className="bullets">{meta.audience.map((a) => <li key={a}>{a}</li>)}</ul>
              </>
            )}
            </div>
            <button type="button" className="link-button" onClick={() => setShowFullDesc((v) => !v)}>{showFullDesc ? 'Show less' : 'Show more'}</button>
          </section>

          <section id="instructor" className="instructor">
            <h2>Instructor</h2>
            <h3 className="instructor-name">{meta.instructor.name}</h3>
            <p className="muted">{meta.instructor.headline}</p>
            <div className="instructor-head">
              <img src={meta.instructor.photo} alt={meta.instructor.name} width="112" height="112" />
              <ul>
                <li><StarIcon width="16" height="16" /> {meta.instructor.rating} Instructor Rating</li>
                <li><AlertIcon width="16" height="16" /> {formatCount(meta.instructor.reviews)} Reviews</li>
                <li><UsersIcon width="16" height="16" /> {formatCount(meta.instructor.students)} Students</li>
                <li><PlayIcon width="16" height="16" /> {meta.instructor.courses} Courses</li>
              </ul>
            </div>
            <p>{meta.instructor.bio}</p>
          </section>

          <section id="reviews" className="feedback">
            <h2><StarIcon width="22" height="22" className="star-fill" /> {meta.rating.toFixed(1)} course rating · {formatCount(meta.ratingCount)} ratings</h2>
            <div className="feedback-grid">
              <div className="feedback-score">
                <strong>{meta.rating.toFixed(1)}</strong>
                <Stars rating={meta.rating} size="md" />
                <span>Course Rating</span>
              </div>
              <ul className="feedback-bars">
                {breakdown.map((pct, i) => (
                  <li key={i}>
                    <span className="bar"><span style={{ width: `${pct}%` }} /></span>
                    <Stars rating={5 - i} />
                    <span className="pct">{pct < 1 ? '< 1' : pct}%</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="reviews-grid">
              {reviews.map((r) => (
                <div key={r.name} className="review">
                  <div className="review-head">
                    <Avatar name={r.name} size={44} photo={r.photo} />
                    <div>
                      <strong>{r.name}</strong>
                      <span><Stars rating={r.rating} /> <span className="muted small">{r.when}</span></span>
                    </div>
                  </div>
                  <p>{r.text}</p>
                  <p className="muted small">Helpful? <button type="button" className="vote" aria-label="Helpful">👍</button><button type="button" className="vote" aria-label="Not helpful">👎</button></p>
                </div>
              ))}
            </div>
          </section>

          {alsoBought.length > 0 && (
            <section className="rail">
              <h2>Students also bought</h2>
              <Carousel label="Students also bought">{alsoBought.map((c) => <CourseCard key={c.id} course={c} />)}</Carousel>
            </section>
          )}
          {byInstructor.length > 0 && (
            <section className="rail">
              <h2>More courses by <a href="#instructor">{meta.instructor.name}</a></h2>
              <div className="tile-grid">{byInstructor.map((c) => <CourseCard key={c.id} course={c} />)}</div>
            </section>
          )}
        </div>
        <aside className="course-aside" aria-label="Purchase">
          <PurchaseCard course={course} meta={meta} mine={mine} subscription={subscription} onEnrol={enrol} busy={busy} error={error} />
        </aside>
      </div>
    </article>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { formatDate } from '../lib/format.js';
import { useSession } from '../lib/session.jsx';
import { CATEGORIES, HERO_SLIDES, PLAN, courseMeta } from '../data/catalog.js';
import { Avatar, Carousel, CourseCard } from '../components/course.jsx';
import { ChevronLeft, ChevronRight, PlayIcon } from '../components/icons.jsx';
import { ErrorNote, Loading, ProgressBar } from '../components/ui.jsx';

function Hero() {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setIndex((i) => (i + 1) % HERO_SLIDES.length), 9000);
    return () => clearInterval(t);
  }, []);
  const go = (d) => setIndex((i) => (i + d + HERO_SLIDES.length) % HERO_SLIDES.length);
  const slide = HERO_SLIDES[index];
  return (
    <section className="hero" aria-roledescription="carousel" aria-label="Highlights">
      <img className="hero-image" src={slide.image} alt="" width="1340" height="400" />
      <div className="hero-box" aria-live="polite">
        <h1>{slide.title}</h1>
        <p>{slide.text}</p>
      </div>
      <button type="button" className="carousel-arrow prev" aria-label="Previous slide" onClick={() => go(-1)}><ChevronLeft /></button>
      <button type="button" className="carousel-arrow next" aria-label="Next slide" onClick={() => go(1)}><ChevronRight /></button>
    </section>
  );
}

function ContinueCard({ c }) {
  const meta = courseMeta(c.courseId);
  const target = c.nextLesson ? `/lessons/${c.nextLesson.id}` : `/courses/${c.courseId}`;
  return (
    <Link to={target} className="continue-card">
      <div className="continue-thumb">
        <img src={meta.image} alt="" width="128" height="72" />
        <span className="play-overlay" aria-hidden="true"><PlayIcon width="22" height="22" /></span>
      </div>
      <div className="continue-body">
        <span className="continue-course">{c.courseTitle}</span>
        <strong className="continue-lesson">{c.nextLesson ? c.nextLesson.title : 'Course completed'}</strong>
        <span className="continue-meta">
          Lecture · {c.completedLessons} of {c.totalLessons} completed
        </span>
      </div>
      <ProgressBar percent={c.percent} label={`${c.courseTitle} progress`} />
    </Link>
  );
}

function CourseRail({ title, subtitle, courses, link }) {
  if (!courses?.length) return null;
  return (
    <section className="rail">
      <div className="rail-head">
        <h2>{title}</h2>
        {link}
      </div>
      {subtitle && <p className="rail-sub">{subtitle}</p>}
      <Carousel label={title}>
        {courses.map((c) => <CourseCard key={c.id} course={c} />)}
      </Carousel>
    </section>
  );
}

export function DashboardPage() {
  const { user, progress, loadProgress } = useSession();
  const [courses, setCourses] = useState(null);
  const [subscription, setSubscription] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    api('/api/courses').then((d) => setCourses(d.courses)).catch(() => setError(true));
    if (user) {
      loadProgress({ force: true }).catch(() => setError(true));
      api('/api/me/subscription').then((d) => setSubscription(d.subscription)).catch(() => setError(true));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const rails = useMemo(() => {
    if (!courses) return null;
    const enrolledIds = new Set((user ? progress ?? [] : []).map((p) => p.courseId));
    const notEnrolled = courses.filter((c) => !enrolledIds.has(c.id));
    // Keep the rails full for learners who already own most of the catalog.
    const open = notEnrolled.length >= 5 ? notEnrolled : [...notEnrolled, ...courses.filter((c) => enrolledIds.has(c.id))];
    const by = (fn) => [...open].sort(fn);
    const anchor = user && progress?.length ? [...progress].sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''))[0] : null;
    const anchorCategory = anchor?.category;
    const because = anchor
      ? [...open.filter((c) => c.category === anchorCategory), ...by((a, b) => courseMeta(b.id).rating - courseMeta(a.id).rating).filter((c) => c.category !== anchorCategory)]
      : null;
    const topCategory = CATEGORIES.find((c) => c.name !== anchorCategory)?.name ?? 'Leadership';
    return {
      anchor,
      because,
      recommended: by((a, b) => courseMeta(b.id).rating - courseMeta(a.id).rating),
      viewing: by((a, b) => courseMeta(b.id).students - courseMeta(a.id).students),
      short: by((a, b) => a.durationMin - b.durationMin),
      topCategory,
      inCategory: courses.filter((c) => c.category === topCategory).sort((a, b) => courseMeta(b.id).students - courseMeta(a.id).students),
    };
  }, [courses, progress, user]);

  const inProgress = (progress ?? []).filter((p) => p.nextLesson).sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
  const hasPlan = subscription?.active;

  return (
    <div className="home">
      <div className="container">
        {user && (
          <div className="welcome">
            <Avatar name={user.name} size={64} />
            <div>
              <h1>Welcome back, {user.name.split(' ')[0]}</h1>
              <p className="muted">
                {progress?.length ? `${progress.length} ${progress.length === 1 ? 'course' : 'courses'} in your library` : 'Ready to start something new?'}
                {' · '}<Link to="/my-learning">Go to My learning</Link>
              </p>
            </div>
          </div>
        )}
        {error && <ErrorNote>Some information could not be loaded.</ErrorNote>}
        <Hero />

        {user && inProgress.length > 0 && (
          <section className="rail">
            <div className="rail-head">
              <h2>Let’s start learning, {user.name.split(' ')[0]}</h2>
              <Link to="/my-learning" className="rail-link">My learning</Link>
            </div>
            <div className="continue-grid">
              {inProgress.slice(0, 3).map((c) => <ContinueCard key={c.courseId} c={c} />)}
            </div>
          </section>
        )}

        {user && subscription && !hasPlan && (
          <section className="plan-band">
            <div>
              <span className="plan-kicker">LearnLoop {PLAN.name}</span>
              <h2>Unlock every course with one subscription</h2>
              <p>{PLAN.features.join(' · ')}</p>
            </div>
            <Link to="/subscription" className="button primary large">Start subscription · {subscription.plan.priceUsd} USD/month</Link>
          </section>
        )}
        {user && hasPlan && subscription.status === 'active' && (
          <p className="plan-note">Your {PLAN.name} renews on {formatDate(subscription.currentPeriodEnd)}. <Link to="/subscription">Manage</Link></p>
        )}

        {!rails && !error && <Loading />}
        {rails && (
          <>
            <h2 className="section-title">What to learn next</h2>
            {rails.because && (
              <CourseRail title={<>Because you enrolled in “<Link to={`/courses/${rails.anchor.courseId}`}>{rails.anchor.courseTitle}</Link>”</>} courses={rails.because} />
            )}
            <CourseRail title="Recommended for you" courses={rails.recommended} />
            <CourseRail title="Learners are viewing" courses={rails.viewing} />
            <CourseRail
              title={<>Top courses in <Link to={`/courses?category=${rails.topCategory}`}>{rails.topCategory}</Link></>}
              courses={rails.inCategory}
            />
            <CourseRail title="Short and sweet courses for you" courses={rails.short} />
          </>
        )}

        <section className="rail">
          <h2>Top categories</h2>
          <div className="category-grid">
            {CATEGORIES.map((c) => (
              <Link key={c.name} to={`/courses?category=${c.name}`} className="category-card">
                <div className="category-img"><img src={c.image} alt="" loading="lazy" width="640" height="360" /></div>
                <strong>{c.name}</strong>
              </Link>
            ))}
          </div>
        </section>

        <section className="rail">
          <h2>Featured topics by category</h2>
          <div className="topics-grid">
            {CATEGORIES.map((c) => (
              <div key={c.name}>
                <h3>{c.name}</h3>
                <ul>
                  {c.topics.map(([t, n]) => (
                    <li key={t}><Link to={`/courses?q=${encodeURIComponent(t)}`}>{t}</Link><span>{n} learners</span></li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <Link to="/courses" className="button outline">Explore more topics</Link>
        </section>
      </div>

      <section className="promo-band">
        <div className="container promo-inner">
          <img src="/images/banners/teach.jpg" alt="" loading="lazy" width="640" height="360" />
          <div>
            <h2>Become an instructor</h2>
            <p>Instructors from around the world teach millions of learners on LearnLoop. We provide the tools and skills to teach what you love.</p>
            <a href="#main" className="button dark large">Start teaching today</a>
          </div>
        </div>
      </section>
    </div>
  );
}

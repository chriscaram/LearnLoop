import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { courseMeta, formatCount, formatPrice } from '../data/catalog.js';
import { formatDuration } from '../lib/format.js';
import { ChevronLeft, ChevronRight } from './icons.jsx';

export function Stars({ rating, size = 'sm' }) {
  const label = `Rating: ${rating.toFixed(1)} out of 5`;
  return (
    <span className={`stars stars-${size}`} role="img" aria-label={label}>
      {[0, 1, 2, 3, 4].map((i) => {
        const fill = Math.max(0, Math.min(1, rating - i));
        return (
          <svg key={i} viewBox="0 0 24 24" aria-hidden="true">
            <defs>
              <linearGradient id={`sg-${i}-${Math.round(fill * 100)}`}>
                <stop offset={`${fill * 100}%`} stopColor="currentColor" />
                <stop offset={`${fill * 100}%`} stopColor="transparent" />
              </linearGradient>
            </defs>
            <path d="m12 2.8 2.9 5.9 6.4.9-4.7 4.5 1.1 6.4L12 17.5l-5.7 3 1.1-6.4-4.7-4.5 6.4-.9z" fill={`url(#sg-${i}-${Math.round(fill * 100)})`} stroke="currentColor" strokeWidth="1.4" />
          </svg>
        );
      })}
    </span>
  );
}

export function Rating({ courseId, showCount = true, size }) {
  const meta = courseMeta(courseId);
  return (
    <span className="rating">
      <strong className="rating-number">{meta.rating.toFixed(1)}</strong>
      <Stars rating={meta.rating} size={size} />
      {showCount && <span className="rating-count">({formatCount(meta.ratingCount)})</span>}
    </span>
  );
}

export function Badge({ kind }) {
  if (!kind) return null;
  const cls = { Bestseller: 'bestseller', 'Highest Rated': 'highest', 'Hot & New': 'hot' }[kind] ?? 'bestseller';
  return <span className={`course-badge ${cls}`}>{kind}</span>;
}

export function Price({ courseId, size }) {
  const meta = courseMeta(courseId);
  return (
    <span className={`price-row ${size ?? ''}`}>
      <strong className="price-now">{formatPrice(meta.price)}</strong>
      <s className="price-was">{formatPrice(meta.listPrice)}</s>
    </span>
  );
}

/** Vertical card, used in carousels and grids. */
export function CourseCard({ course, progressPercent }) {
  const meta = courseMeta(course.id);
  return (
    <article className="course-tile">
      <Link to={`/courses/${course.id}`} className="course-tile-link">
        <div className="thumb">
          <img src={meta.image} alt="" loading="lazy" width="480" height="270" />
        </div>
        <h3 className="course-tile-title">{course.title}</h3>
      </Link>
      <p className="course-tile-instructor">{meta.instructor.name}</p>
      <Rating courseId={course.id} />
      {progressPercent === undefined ? <Price courseId={course.id} /> : <p className="small muted">{progressPercent}% complete</p>}
      <div className="course-tile-badges">
        <Badge kind={meta.badge} />
      </div>
    </article>
  );
}

/** Horizontal row, used on the search/category results page. */
export function CourseRow({ course }) {
  const meta = courseMeta(course.id);
  return (
    <article className="course-row">
      <Link to={`/courses/${course.id}`} className="course-row-thumb" tabIndex={-1} aria-hidden="true">
        <img src={meta.image} alt="" loading="lazy" width="260" height="146" />
      </Link>
      <div className="course-row-body">
        <h3 className="course-row-title"><Link to={`/courses/${course.id}`}>{course.title}</Link></h3>
        <p className="course-row-summary">{course.summary}</p>
        <p className="course-tile-instructor">{meta.instructor.name}</p>
        <Rating courseId={course.id} />
        <p className="course-row-facts">{formatDuration(course.durationMin)} total · {course.lessonCount} lectures · {course.level}</p>
        <Badge kind={meta.badge} />
      </div>
      <div className="course-row-price">
        <strong className="price-now">{formatPrice(meta.price)}</strong>
        <s className="price-was">{formatPrice(meta.listPrice)}</s>
      </div>
    </article>
  );
}

export function Carousel({ label, children }) {
  const track = useRef(null);
  const scroll = (dir) => {
    const el = track.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.9, behavior: 'smooth' });
  };
  return (
    <div className="carousel" role="region" aria-label={label}>
      <button type="button" className="carousel-arrow prev" aria-label="Previous" onClick={() => scroll(-1)}><ChevronLeft /></button>
      <div className="carousel-track" ref={track}>{children}</div>
      <button type="button" className="carousel-arrow next" aria-label="Next" onClick={() => scroll(1)}><ChevronRight /></button>
    </div>
  );
}

export function Avatar({ name, size = 32, photo }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
  if (photo) return <img className="avatar" src={photo} alt="" width={size} height={size} style={{ width: size, height: size }} />;
  return <span className="avatar initials" style={{ width: size, height: size, fontSize: size * 0.38 }} aria-hidden="true">{initials}</span>;
}

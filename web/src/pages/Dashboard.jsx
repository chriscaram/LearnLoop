import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { formatDate, relativeDays, subscriptionLabel } from '../lib/format.js';
import { useSession } from '../lib/session.jsx';
import { ErrorNote, Loading, PageTitle, ProgressBar } from '../components/ui.jsx';

export function DashboardPage() {
  const { user, progress, loadProgress } = useSession();
  const [subscription, setSubscription] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    loadProgress({ force: true }).catch(() => setError(true));
    api('/api/me/subscription').then((d) => setSubscription(d.subscription)).catch(() => setError(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <PageTitle title={`Hello, ${user.name.split(' ')[0]}`} />
      {error && <ErrorNote>Some information could not be loaded.</ErrorNote>}
      <div className="dashboard-grid">
        <section aria-labelledby="continue-heading">
          <h2 id="continue-heading">Continue learning</h2>
          {progress === null && !error && <Loading />}
          {progress?.length === 0 && (
            <div className="card empty">
              <p>You are not enrolled in a course yet.</p>
              <Link className="button" to="/courses">Browse courses</Link>
            </div>
          )}
          <div className="card-list">
            {progress?.map((c) => (
              <article key={c.courseId} className="card course-progress">
                <div className="eyebrow">{c.category}</div>
                <h3><Link to={`/courses/${c.courseId}`}>{c.courseTitle}</Link></h3>
                <ProgressBar percent={c.percent} label={`${c.courseTitle} progress`} />
                <p className="muted small">
                  {c.percent}% complete · {c.completedLessons} of {c.totalLessons} lessons · Last activity: {relativeDays(c.lastActivityAt)}
                </p>
                {c.lastLesson && <p className="small">Last lesson: {c.lastLesson.title}</p>}
                {c.nextLesson ? (
                  <Link className="button" to={`/lessons/${c.nextLesson.id}`}>{c.completedLessons ? 'Continue' : 'Start'}: {c.nextLesson.title}</Link>
                ) : (
                  <p className="success small">Course completed</p>
                )}
              </article>
            ))}
          </div>
        </section>
        <aside aria-labelledby="subscription-heading">
          <h2 id="subscription-heading">Subscription</h2>
          <div className="card">
            {!subscription ? <Loading /> : (
              <>
                <p className="stat">{subscriptionLabel(subscription)}</p>
                <p className="muted small">{subscription.plan.name} plan · {subscription.plan.priceUsd} USD per month</p>
                {subscription.status === 'active' && <p className="small">Renews on {formatDate(subscription.currentPeriodEnd)}</p>}
                <Link to="/subscription">Manage subscription</Link>
              </>
            )}
          </div>
        </aside>
      </div>
    </>
  );
}

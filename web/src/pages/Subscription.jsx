import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api.js';
import { formatDate, subscriptionLabel } from '../lib/format.js';
import { ErrorNote, Loading } from '../components/ui.jsx';
import { PLAN } from '../data/catalog.js';
import { CheckIcon } from '../components/icons.jsx';

export function SubscriptionPage() {
  const [subscription, setSubscription] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/api/me/subscription').then((d) => setSubscription(d.subscription)).catch((e) => setError(errorMessage(e)));
  }, []);

  async function run(path) {
    setBusy(true);
    setError(null);
    try {
      const d = await api(path, { method: 'POST' });
      setSubscription(d.subscription);
      setConfirming(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (!subscription) return <div className="container page">{error ? <ErrorNote>{error}</ErrorNote> : <Loading />}</div>;
  const canSubscribe = subscription.status !== 'active';

  return (
    <div className="container page subscription-page">
      <div className="plan-hero">
        <div>
          <span className="plan-kicker">Plans &amp; Pricing</span>
          <h1>Grow your skills with the {PLAN.name}</h1>
          <p className="lead">One subscription, every course in the catalog. Learn at your own pace and cancel anytime.</p>
          <ul className="plan-features">
            {PLAN.features.map((f) => <li key={f}><CheckIcon width="18" height="18" /> {f}</li>)}
          </ul>
        </div>
        <img src="/images/banners/business.jpg" alt="" width="640" height="360" />
      </div>
      <section className="card plan">
        <span className="plan-kicker">For you · Individual</span>
        <h2>{PLAN.name} <span className="muted small">({subscription.plan.name} billing)</span></h2>
        <p className="price"><strong>{subscription.plan.priceUsd} USD</strong> per month. All courses included.</p>
        <dl className="facts">
          <dt>Status</dt><dd>{subscriptionLabel(subscription)}</dd>
          {subscription.startedAt && (<><dt>Member since</dt><dd>{formatDate(subscription.startedAt)}</dd></>)}
          {subscription.status === 'active' && (<><dt>Next renewal</dt><dd>{formatDate(subscription.currentPeriodEnd)} ({subscription.daysUntilRenewal} days)</dd></>)}
        </dl>
        {error && <ErrorNote>{error}</ErrorNote>}
        {canSubscribe && (
          <button type="button" className="button primary large" disabled={busy} onClick={() => run('/api/checkout')}>Subscribe for {subscription.plan.priceUsd} USD per month</button>
        )}
        {subscription.status === 'active' && !confirming && (
          <button type="button" className="button ghost" onClick={() => setConfirming(true)}>Cancel subscription</button>
        )}
        {confirming && (
          <div className="confirm" role="alertdialog" aria-labelledby="confirm-text">
            <p id="confirm-text">Cancel your subscription? You keep access until {formatDate(subscription.currentPeriodEnd)}.</p>
            <button type="button" className="button danger" disabled={busy} onClick={() => run('/api/me/subscription/cancel')}>Yes, cancel</button>
            <button type="button" className="button ghost" onClick={() => setConfirming(false)}>Keep subscription</button>
          </div>
        )}
        <p className="muted small">Payments in this demo are simulated; no card is charged.</p>
      </section>
    </div>
  );
}

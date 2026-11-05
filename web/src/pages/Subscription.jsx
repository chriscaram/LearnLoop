import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api.js';
import { formatDate, subscriptionLabel } from '../lib/format.js';
import { ErrorNote, Loading, PageTitle } from '../components/ui.jsx';

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

  if (!subscription) return error ? <ErrorNote>{error}</ErrorNote> : <Loading />;
  const canSubscribe = subscription.status !== 'active';

  return (
    <>
      <PageTitle title="Subscription" />
      <section className="card plan">
        <h2>{subscription.plan.name} plan</h2>
        <p className="price"><strong>{subscription.plan.priceUsd} USD</strong> per month. All courses included.</p>
        <dl className="facts">
          <dt>Status</dt><dd>{subscriptionLabel(subscription)}</dd>
          {subscription.startedAt && (<><dt>Member since</dt><dd>{formatDate(subscription.startedAt)}</dd></>)}
          {subscription.status === 'active' && (<><dt>Next renewal</dt><dd>{formatDate(subscription.currentPeriodEnd)} ({subscription.daysUntilRenewal} days)</dd></>)}
        </dl>
        {error && <ErrorNote>{error}</ErrorNote>}
        {canSubscribe && (
          <button type="button" className="button" disabled={busy} onClick={() => run('/api/checkout')}>Subscribe for {subscription.plan.priceUsd} USD per month</button>
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
    </>
  );
}

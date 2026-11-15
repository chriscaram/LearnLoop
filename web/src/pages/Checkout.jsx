import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../lib/api.js';
import { useCart } from '../lib/cart.jsx';
import { useSession } from '../lib/session.jsx';
import { PLAN, courseMeta, formatPrice } from '../data/catalog.js';
import { CheckIcon, LockIcon } from '../components/icons.jsx';
import { ErrorNote, Loading } from '../components/ui.jsx';

const COUNTRIES = ['United States', 'Canada', 'Mexico', 'Spain', 'United Kingdom', 'Germany', 'Brazil', 'Argentina', 'Colombia', 'Chile'];

export function CheckoutPage() {
  const cart = useCart();
  const { invalidateProgress } = useSession();
  const [subscription, setSubscription] = useState(null);
  const [country, setCountry] = useState('United States');
  const [method, setMethod] = useState('card');
  const [card, setCard] = useState({ name: '', number: '', expiry: '', cvc: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  useEffect(() => {
    api('/api/me/subscription').then((d) => setSubscription(d.subscription)).catch((e) => setError(errorMessage(e)));
  }, []);

  async function complete(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const purchased = [...cart.items];
    try {
      // Enrolment needs an active subscription; the existing simulated checkout starts one.
      const current = (await api('/api/me/subscription')).subscription;
      if (!current.active) await api('/api/checkout', { method: 'POST' });
      const results = await Promise.allSettled(purchased.map((c) => api(`/api/courses/${c.id}/enrol`, { method: 'POST' })));
      const ok = purchased.filter((_, i) => results[i].status === 'fulfilled');
      const failed = purchased.filter((_, i) => results[i].status === 'rejected');
      cart.removeMany(ok.map((c) => c.id));
      invalidateProgress();
      if (failed.length && !ok.length) throw results.find((r) => r.status === 'rejected').reason;
      setDone({ ok, failed, startedPlan: !current.active });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="container page checkout-done">
        <div className="done-icon" aria-hidden="true"><CheckIcon width="40" height="40" /></div>
        <h1>Thank you for your purchase!</h1>
        <p className="muted">You now have access to {done.ok.length} new {done.ok.length === 1 ? 'course' : 'courses'}.{done.startedPlan && ` Your LearnLoop ${PLAN.name} is now active.`}</p>
        {done.failed.length > 0 && <ErrorNote>We could not enroll you in: {done.failed.map((c) => c.title).join(', ')}. They are still in your cart.</ErrorNote>}
        <ul className="done-list">
          {done.ok.map((c) => (
            <li key={c.id}>
              <img src={courseMeta(c.id).image} alt="" width="120" height="68" />
              <div><strong>{c.title}</strong><span className="small muted">By {courseMeta(c.id).instructor.name}</span></div>
              <Link to={`/courses/${c.id}`} className="button primary">Start learning</Link>
            </li>
          ))}
        </ul>
        <Link to="/my-learning" className="button outline large">Go to My learning</Link>
      </div>
    );
  }

  if (cart.items.length === 0) {
    return (
      <div className="container page">
        <h1>Checkout</h1>
        <p>Your cart is empty. <Link to="/courses">Browse courses</Link></p>
      </div>
    );
  }

  const set = (k) => (e) => setCard({ ...card, [k]: e.target.value });

  return (
    <form className="checkout" onSubmit={complete}>
      <div className="checkout-main">
        <h1>Checkout</h1>
        <section>
          <h2>Billing address</h2>
          <div className="field-row">
            <label className="field">
              <span>Country</span>
              <select value={country} onChange={(e) => setCountry(e.target.value)} required>
                {COUNTRIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </label>
          </div>
          <p className="small muted">LearnLoop is required by law to collect applicable transaction taxes for purchases made in certain tax jurisdictions.</p>
        </section>

        <section>
          <div className="row space"><h2>Payment method</h2><span className="small muted secure"><LockIcon width="14" height="14" /> Secure and encrypted</span></div>
          <div className="pay-methods">
            <label className={`pay-method${method === 'card' ? ' selected' : ''}`}>
              <input type="radio" name="method" checked={method === 'card'} onChange={() => setMethod('card')} />
              <span className="card-logo">CARD</span> Cards
            </label>
            {method === 'card' && (
              <div className="card-fields">
                <label className="field"><span>Name on card</span><input type="text" autoComplete="cc-name" placeholder="Name on card" value={card.name} onChange={set('name')} /></label>
                <label className="field"><span>Card number</span><input type="text" inputMode="numeric" autoComplete="cc-number" placeholder="1234 5678 9012 3456" value={card.number} onChange={set('number')} /></label>
                <div className="field-row">
                  <label className="field"><span>Expiry date</span><input type="text" autoComplete="cc-exp" placeholder="MM/YY" value={card.expiry} onChange={set('expiry')} /></label>
                  <label className="field"><span>CVC/CVV</span><input type="text" inputMode="numeric" autoComplete="cc-csc" placeholder="CVC" value={card.cvc} onChange={set('cvc')} /></label>
                </div>
                <p className="small muted">Demo checkout: payments are simulated and no card is charged. You can leave these fields empty.</p>
              </div>
            )}
            <label className={`pay-method${method === 'paypal' ? ' selected' : ''}`}>
              <input type="radio" name="method" checked={method === 'paypal'} onChange={() => setMethod('paypal')} />
              <span className="card-logo paypal">PayPal</span> PayPal
            </label>
          </div>
        </section>

        <section>
          <h2>Order details ({cart.items.length} {cart.items.length === 1 ? 'course' : 'courses'})</h2>
          <ul className="order-list">
            {cart.items.map((c) => {
              const meta = courseMeta(c.id);
              return (
                <li key={c.id}>
                  <img src={meta.image} alt="" width="64" height="36" />
                  <span className="order-title">{c.title}</span>
                  <span className="order-price"><strong>{formatPrice(meta.price)}</strong><s>{formatPrice(meta.listPrice)}</s></span>
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      <aside className="checkout-summary" aria-label="Order summary">
        <h2>Order summary</h2>
        <dl>
          <dt>Original Price:</dt><dd>{formatPrice(cart.totals.original)}</dd>
          <dt>Discounts ({cart.totals.discountPercent}% Off):</dt><dd>-{formatPrice(cart.totals.original - cart.totals.total)}</dd>
        </dl>
        <dl className="summary-total">
          <dt>Total ({cart.items.length} {cart.items.length === 1 ? 'course' : 'courses'}):</dt><dd>{formatPrice(cart.totals.total)}</dd>
        </dl>
        {subscription === null && !error && <Loading />}
        {subscription && !subscription.active && (
          <p className="plan-included">Includes your LearnLoop {PLAN.name} ({subscription.plan.priceUsd} USD/month), needed to access courses. Cancel anytime.</p>
        )}
        <p className="small muted">By completing your purchase you agree to these <a href="#main">Terms of Service</a>.</p>
        {error && <ErrorNote>{error}</ErrorNote>}
        <button type="submit" className="button primary block large" disabled={busy || !subscription}>
          {busy ? 'Processing…' : <><LockIcon width="16" height="16" /> Complete Checkout</>}
        </button>
        <div className="guarantee-box">
          <strong>30-Day Money-Back Guarantee</strong>
          <p className="small">Not satisfied? Get a full refund within 30 days. Simple and straightforward!</p>
        </div>
      </aside>
    </form>
  );
}

import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { formatDuration } from '../lib/format.js';
import { useCart } from '../lib/cart.jsx';
import { useSession } from '../lib/session.jsx';
import { courseMeta, formatPrice } from '../data/catalog.js';
import { Badge, Carousel, CourseCard, Rating } from '../components/course.jsx';
import { CartIcon } from '../components/icons.jsx';

export function CartPage() {
  const cart = useCart();
  const { user } = useSession();
  const navigate = useNavigate();
  const [suggestions, setSuggestions] = useState([]);
  const [coupon, setCoupon] = useState('');
  const [couponNote, setCouponNote] = useState(null);

  useEffect(() => {
    api('/api/courses').then((d) => setSuggestions(d.courses)).catch(() => {});
  }, []);

  const ids = new Set(cart.items.map((c) => c.id));
  const more = suggestions.filter((c) => !ids.has(c.id)).sort((a, b) => courseMeta(b.id).students - courseMeta(a.id).students);
  const count = cart.items.length;

  return (
    <div className="container page cart-page">
      <h1>Shopping Cart</h1>
      {count === 0 ? (
        <>
          <p className="cart-count">0 Courses in Cart</p>
          <div className="cart-empty">
            <CartIcon width="72" height="72" />
            <p>Your cart is empty. Keep shopping to find a course!</p>
            <Link to="/courses" className="button primary large">Keep shopping</Link>
          </div>
        </>
      ) : (
        <div className="cart-layout">
          <section>
            <p className="cart-count">{count} {count === 1 ? 'Course' : 'Courses'} in Cart</p>
            <ul className="cart-list">
              {cart.items.map((c) => {
                const meta = courseMeta(c.id);
                return (
                  <li key={c.id} className="cart-item">
                    <Link to={`/courses/${c.id}`} className="cart-thumb" tabIndex={-1} aria-hidden="true"><img src={meta.image} alt="" width="120" height="68" /></Link>
                    <div className="cart-info">
                      <Link to={`/courses/${c.id}`} className="cart-title">{c.title}</Link>
                      <span className="small muted">By {meta.instructor.name}</span>
                      <span className="cart-rating"><Badge kind={meta.badge} /> <Rating courseId={c.id} /></span>
                      <span className="small muted">{formatDuration(c.durationMin)} total · {c.lessonCount} lectures · {c.level}</span>
                    </div>
                    <div className="cart-links">
                      <button type="button" className="link-button" onClick={() => cart.remove(c.id)}>Remove</button>
                      <button type="button" className="link-button" onClick={() => cart.moveToWishlist(c)}>Move to Wishlist</button>
                    </div>
                    <div className="cart-price">
                      <strong>{formatPrice(meta.price)}</strong>
                      <s>{formatPrice(meta.listPrice)}</s>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
          <aside className="cart-summary" aria-label="Order total">
            <span className="total-label">Total:</span>
            <strong className="total-amount">{formatPrice(cart.totals.total)}</strong>
            <s className="total-was">{formatPrice(cart.totals.original)}</s>
            <span className="total-off">{cart.totals.discountPercent}% off</span>
            <button type="button" className="button primary block large" onClick={() => navigate(user ? '/checkout' : '/login', { state: { from: '/checkout' } })}>
              Proceed to Checkout →
            </button>
            {!user && <p className="small muted">You’ll be asked to log in first.</p>}
            <div className="promotions">
              <h2>Promotions</h2>
              <form className="coupon" onSubmit={(e) => { e.preventDefault(); setCouponNote(coupon ? `“${coupon}” is not a valid coupon.` : null); }}>
                <input type="text" aria-label="Coupon code" placeholder="Enter Coupon" value={coupon} onChange={(e) => setCoupon(e.target.value)} />
                <button type="submit" className="button primary">Apply</button>
              </form>
              {couponNote && <p className="small error-text" role="status">{couponNote}</p>}
            </div>
          </aside>
        </div>
      )}

      {cart.wishlist.length > 0 && (
        <section className="rail">
          <h2>Recently wishlisted</h2>
          <ul className="cart-list compact">
            {cart.wishlist.map((c) => (
              <li key={c.id} className="cart-item">
                <Link to={`/courses/${c.id}`} className="cart-thumb" tabIndex={-1} aria-hidden="true"><img src={courseMeta(c.id).image} alt="" width="120" height="68" /></Link>
                <div className="cart-info">
                  <Link to={`/courses/${c.id}`} className="cart-title">{c.title}</Link>
                  <span className="small muted">By {courseMeta(c.id).instructor.name}</span>
                </div>
                <div className="cart-links">
                  {!cart.inCart(c.id) && <button type="button" className="link-button" onClick={() => { cart.add(c); cart.toggleWishlist(c); }}>Move to Cart</button>}
                  <button type="button" className="link-button" onClick={() => cart.toggleWishlist(c)}>Remove</button>
                </div>
                <div className="cart-price"><strong>{formatPrice(courseMeta(c.id).price)}</strong></div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {more.length > 0 && (
        <section className="rail">
          <h2>You might also like</h2>
          <Carousel label="You might also like">{more.map((c) => <CourseCard key={c.id} course={c} />)}</Carousel>
        </section>
      )}
    </div>
  );
}

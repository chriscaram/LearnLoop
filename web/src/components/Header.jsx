import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { CATEGORIES } from '../data/catalog.js';
import { useCart } from '../lib/cart.jsx';
import { useSession } from '../lib/session.jsx';
import { Bell } from './Bell.jsx';
import { Avatar } from './course.jsx';
import { CartIcon, HeartIcon, SearchIcon } from './icons.jsx';

function SearchBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const [q, setQ] = useState(() => new URLSearchParams(location.search).get('q') ?? '');
  return (
    <form className="search-bar" role="search" onSubmit={(e) => { e.preventDefault(); navigate(q.trim() ? `/courses?q=${encodeURIComponent(q.trim())}` : '/courses'); }}>
      <button type="submit" className="search-submit" aria-label="Search"><SearchIcon /></button>
      <input type="search" aria-label="Search for anything" placeholder="Search for anything" value={q} onChange={(e) => setQ(e.target.value)} />
    </form>
  );
}

function ExploreMenu() {
  return (
    <div className="hover-menu explore">
      <Link to="/courses" className="nav-text">Explore</Link>
      <div className="hover-panel">
        <ul>
          {CATEGORIES.map((c) => (
            <li key={c.name}><Link to={`/courses?category=${c.name}`}>{c.name}<span aria-hidden="true">›</span></Link></li>
          ))}
          <li><Link to="/courses">All courses<span aria-hidden="true">›</span></Link></li>
        </ul>
      </div>
    </div>
  );
}

function UserMenu({ user, onLogout }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const isStaff = user.role === 'staff';
  const item = (to, label) => <Link to={to} role="menuitem" onClick={() => setOpen(false)}>{label}</Link>;
  return (
    <div className="user-menu" ref={ref}>
      <button type="button" className="avatar-button" aria-haspopup="true" aria-expanded={open} aria-label="Account menu" onClick={() => setOpen((o) => !o)}>
        <Avatar name={user.name} size={32} />
      </button>
      {open && (
        <div className="dropdown user-dropdown" role="menu">
          <div className="user-dropdown-head">
            <Avatar name={user.name} size={56} />
            <div>
              <strong>{user.name}</strong>
              <span className="muted small">{user.email}</span>
            </div>
          </div>
          <div className="menu-group">
            {isStaff ? item('/admin', 'Admin') : item('/my-learning', 'My learning')}
            {item('/cart', 'My cart')}
            {item('/my-learning?tab=wishlist', 'Wishlist')}
          </div>
          {!isStaff && <div className="menu-group">{item('/notifications', 'Notifications')}{item('/subscription', 'Subscription')}{item('/help', 'Help and support')}</div>}
          <div className="menu-group">
            <button type="button" role="menuitem" onClick={() => { setOpen(false); onLogout(); }}>Log out</button>
          </div>
        </div>
      )}
    </div>
  );
}

export function Header() {
  const { user, logout } = useSession();
  const { items } = useCart();
  const navigate = useNavigate();
  const isStaff = user?.role === 'staff';
  return (
    <header className="site-header">
      <div className="header-inner">
        <NavLink to={isStaff ? '/admin' : user ? '/' : '/courses'} className="logo" aria-label="LearnLoop home">
          <img src="/favicon.svg" alt="" width="30" height="30" />
          <span>learnloop</span>
        </NavLink>
        <ExploreMenu />
        <SearchBar />
        <nav className="header-links" aria-label="Main">
          <Link to="/subscription" className="nav-text hide-md">Plans &amp; Pricing</Link>
          {isStaff && <NavLink to="/admin" className="nav-text">Admin</NavLink>}
          {user && !isStaff && <NavLink to="/my-learning" className="nav-text">My learning</NavLink>}
        </nav>
        <div className="header-actions">
          {user && !isStaff && (
            <Link to="/my-learning?tab=wishlist" className="icon-button" aria-label="Wishlist"><HeartIcon /></Link>
          )}
          <Link to="/cart" className="icon-button" aria-label={items.length ? `Cart, ${items.length} items` : 'Cart'}>
            <CartIcon />
            {items.length > 0 && <span className="badge cart-badge">{items.length}</span>}
          </Link>
          {user ? (
            <>
              <Bell />
              <UserMenu user={user} onLogout={async () => { await logout(); navigate('/login'); }} />
            </>
          ) : (
            <>
              <NavLink to="/login" className="button outline">Log in</NavLink>
              <NavLink to="/login" className="button dark">Sign up</NavLink>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

export function CategoryStrip() {
  return (
    <nav className="category-strip" aria-label="Categories">
      {CATEGORIES.map((c) => <Link key={c.name} to={`/courses?category=${c.name}`}>{c.name}</Link>)}
      {CATEGORIES.flatMap((c) => c.topics.slice(0, 2)).map(([t]) => <Link key={t} to={`/courses?q=${encodeURIComponent(t)}`}>{t}</Link>)}
    </nav>
  );
}

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="footer-top">
        <div className="footer-inner">
          <p className="footer-pitch">Top companies choose <strong>LearnLoop Business</strong> to build in-demand career skills.</p>
          <ul className="footer-logos" aria-label="Customers">
            {['Northwind', 'Contoso', 'Fabrikam', 'Tailspin', 'Litware'].map((n) => <li key={n}>{n}</li>)}
          </ul>
        </div>
      </div>
      <div className="footer-inner footer-cols">
        <div>
          <h2>About</h2>
          <ul><li><Link to="/courses">Courses</Link></li><li><Link to="/subscription">Plans &amp; Pricing</Link></li><li><a href="#main">Careers</a></li><li><a href="#main">Blog</a></li></ul>
        </div>
        <div>
          <h2>Discover LearnLoop</h2>
          <ul><li><a href="#main">Teach on LearnLoop</a></li><li><a href="#main">Get the app</a></li><li><Link to="/help">Help and support</Link></li><li><a href="#main">Affiliate</a></li></ul>
        </div>
        <div>
          <h2>LearnLoop for Business</h2>
          <ul><li><a href="#main">LearnLoop Business</a></li><li><a href="#main">Request a demo</a></li></ul>
        </div>
        <div>
          <h2>Legal &amp; Accessibility</h2>
          <ul><li><a href="#main">Accessibility statement</a></li><li><a href="#main">Privacy policy</a></li><li><a href="#main">Terms</a></li></ul>
        </div>
      </div>
      <div className="footer-inner footer-bottom">
        <span className="logo light"><img src="/favicon.svg" alt="" width="26" height="26" /> learnloop</span>
        <span>© 2026 LearnLoop, Inc. Demo application, all data is fictional.</span>
      </div>
    </footer>
  );
}

import { NavLink, useNavigate } from 'react-router-dom';
import { useSession } from '../lib/session.jsx';
import { Bell } from './Bell.jsx';

export function Header() {
  const { user, logout } = useSession();
  const navigate = useNavigate();
  const isStaff = user?.role === 'staff';
  return (
    <header className="site-header">
      <div className="container header-inner">
        <NavLink to={isStaff ? '/admin' : '/'} className="logo" aria-label="LearnLoop home">
          <img src="/favicon.svg" alt="" width="28" height="28" />
          <span>LearnLoop</span>
        </NavLink>
        {user && (
          <nav className="main-nav" aria-label="Main">
            {!isStaff && <NavLink to="/" end>Dashboard</NavLink>}
            <NavLink to="/courses">Courses</NavLink>
            {!isStaff && <NavLink to="/subscription">Subscription</NavLink>}
            {isStaff && <NavLink to="/admin">Admin</NavLink>}
          </nav>
        )}
        <div className="header-actions">
          {user ? (
            <>
              <Bell />
              <span className="user-name" title={user.email}>{user.name}</span>
              <button type="button" className="button ghost small" onClick={async () => { await logout(); navigate('/login'); }}>Sign out</button>
            </>
          ) : (
            <NavLink to="/login" className="button small">Sign in</NavLink>
          )}
        </div>
      </div>
    </header>
  );
}

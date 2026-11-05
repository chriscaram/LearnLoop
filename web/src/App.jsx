import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Header } from './components/Header.jsx';
import { Loading } from './components/ui.jsx';
import { useSession } from './lib/session.jsx';
import { LoginPage } from './pages/Login.jsx';
import { DashboardPage } from './pages/Dashboard.jsx';
import { CoursesPage } from './pages/Courses.jsx';
import { CourseDetailPage } from './pages/CourseDetail.jsx';
import { LessonPage } from './pages/Lesson.jsx';
import { SubscriptionPage } from './pages/Subscription.jsx';
import { NotificationsPage } from './pages/Notifications.jsx';
import { AdminPage } from './pages/Admin.jsx';

function RequireUser({ children, role }) {
  const { user } = useSession();
  const location = useLocation();
  if (user === undefined) return <Loading />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (role && user.role !== role) return <Navigate to="/" replace />;
  return children;
}

function Home() {
  const { user } = useSession();
  if (user?.role === 'staff') return <Navigate to="/admin" replace />;
  return <DashboardPage />;
}

export function App() {
  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      <Header />
      <main id="main" className="container main">
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<RequireUser><Home /></RequireUser>} />
          <Route path="/courses" element={<CoursesPage />} />
          <Route path="/courses/:courseId" element={<CourseDetailPage />} />
          <Route path="/lessons/:lessonId" element={<RequireUser><LessonPage /></RequireUser>} />
          <Route path="/subscription" element={<RequireUser><SubscriptionPage /></RequireUser>} />
          <Route path="/notifications" element={<RequireUser><NotificationsPage /></RequireUser>} />
          <Route path="/admin" element={<RequireUser role="staff"><AdminPage /></RequireUser>} />
          <Route path="*" element={<p>Page not found.</p>} />
        </Routes>
      </main>
      <footer className="site-footer">
        <div className="container muted small">LearnLoop. Courses in data, cloud, leadership and design.</div>
      </footer>
    </>
  );
}

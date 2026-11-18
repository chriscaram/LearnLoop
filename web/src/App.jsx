import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { CategoryStrip, Footer, Header } from './components/Header.jsx';
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
import { AgentOversightPage } from './pages/AgentOversight.jsx';
import { CartPage } from './pages/Cart.jsx';
import { CheckoutPage } from './pages/Checkout.jsx';
import { MyLearningPage } from './pages/MyLearning.jsx';
import { HelpPage } from './pages/Help.jsx';

function RequireUser({ children, role }) {
  const { user } = useSession();
  const location = useLocation();
  if (user === undefined) return <Page><Loading /></Page>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (role && user.role !== role) return <Navigate to="/" replace />;
  return children;
}

/** Centred content column for pages that do not lay out full-width bands. */
const Page = ({ children }) => <div className="container page">{children}</div>;

function Home() {
  const { user } = useSession();
  if (user === undefined) return <Page><Loading /></Page>;
  if (user?.role === 'staff') return <Navigate to="/admin" replace />;
  return <DashboardPage />;
}

export function App() {
  const { pathname } = useLocation();
  const showStrip = pathname === '/' || pathname === '/courses';
  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      <Header />
      {showStrip && <CategoryStrip />}
      <main id="main" className="main">
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<Home />} />
          <Route path="/courses" element={<CoursesPage />} />
          <Route path="/courses/:courseId" element={<CourseDetailPage />} />
          <Route path="/cart" element={<CartPage />} />
          <Route path="/checkout" element={<RequireUser><CheckoutPage /></RequireUser>} />
          <Route path="/my-learning" element={<RequireUser><MyLearningPage /></RequireUser>} />
          <Route path="/lessons/:lessonId" element={<RequireUser><Page><LessonPage /></Page></RequireUser>} />
          <Route path="/subscription" element={<RequireUser><SubscriptionPage /></RequireUser>} />
          <Route path="/notifications" element={<RequireUser><Page><NotificationsPage /></Page></RequireUser>} />
          <Route path="/help" element={<RequireUser><Page><HelpPage /></Page></RequireUser>} />
          <Route path="/admin" element={<RequireUser role="staff"><Page><AdminPage /></Page></RequireUser>} />
          <Route path="/admin/agent-oversight" element={<RequireUser role="staff"><Page><AgentOversightPage /></Page></RequireUser>} />
          <Route path="*" element={<Page><h1>Page not found</h1><p>We can’t find the page you’re looking for.</p></Page>} />
        </Routes>
      </main>
      <Footer />
    </>
  );
}
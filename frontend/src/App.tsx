import {
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  type Location as RouterLocation,
} from 'react-router-dom'
import { AuthProvider } from './auth/AuthProvider'
import { useAuth } from './auth/useAuth'
import HomePage from './pages/HomePage'
import LoginPage from './pages/LoginPage'
import ProfilePage from './pages/ProfilePage'
import TrainingDayPage from './pages/TrainingDayPage'
import WorkoutPage from './pages/WorkoutPage'
import './App.css'

function Loading() {
  return (
    <main className="app">
      <h1>GymHelper</h1>
      <p className="subtitle">Loading…</p>
    </main>
  )
}

/**
 * Gate for signed-in routes. While the session check is in flight we render a
 * placeholder rather than the login page, otherwise a refresh on /profile would
 * flash the login form before the session resolves. Anonymous visitors are sent
 * to /login, remembering where they were headed.
 */
function RequireAuth() {
  const { user, checking } = useAuth()
  const location = useLocation()

  if (checking) return <Loading />
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />
  return <Outlet />
}

/** /login is only for signed-out visitors; signed-in ones go on to their destination. */
function RequireAnonymous() {
  const { user, checking } = useAuth()
  const location = useLocation()

  if (checking) return <Loading />
  if (user) {
    const from = (location.state as { from?: RouterLocation } | null)?.from
    return <Navigate to={from?.pathname ?? '/'} replace />
  }
  return <Outlet />
}

function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route element={<RequireAnonymous />}>
          <Route path="/login" element={<LoginPage />} />
        </Route>

        <Route element={<RequireAuth />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/days/:slug" element={<TrainingDayPage />} />
          {/* The id in the URL is what makes a reload mid-workout resume it. */}
          <Route path="/workout/:id" element={<WorkoutPage />} />
          <Route path="/profile" element={<ProfilePage />} />
        </Route>

        {/* Unknown URL: fall back to the home route, which itself gates on auth. */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  )
}

export default App

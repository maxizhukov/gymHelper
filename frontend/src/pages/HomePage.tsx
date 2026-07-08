import { Link } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'

export default function HomePage() {
  const { user } = useAuth()
  if (!user) return null

  return (
    <main className="app">
      <h1>GymHelper</h1>
      <div className="card status-ok">
        <p className="label">Signed in as</p>
        <p className="message">{user.username}</p>
      </div>

      <nav className="home-nav">
        {/* Navigation, so a real link — Base UI's Button would impose button semantics. */}
        <Link className="nav-button" to="/profile">
          Profile settings
        </Link>
      </nav>
    </main>
  )
}

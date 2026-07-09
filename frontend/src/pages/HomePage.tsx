import { Link } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { TRAINING_DAYS } from '../training-days'

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

      <section className="training-days" aria-labelledby="training-days-heading">
        <h2 id="training-days-heading">Training days</h2>
        <ul className="training-day-list">
          {TRAINING_DAYS.map(({ slug, day, focus }) => (
            <li key={slug}>
              {/* Navigation, so a real link — Base UI's Button would impose button semantics. */}
              <Link className="card training-day-card" to={`/days/${slug}`}>
                <p className="label">{day}</p>
                <p className="message">{focus}</p>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <nav className="home-nav">
        <Link className="nav-button" to="/profile">
          Profile settings
        </Link>
      </nav>
    </main>
  )
}

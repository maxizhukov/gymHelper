import { Link } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { useTrainingDays } from '../training-days'

export default function HomePage() {
  const { user } = useAuth()
  const trainingDays = useTrainingDays()
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

        {trainingDays.status === 'loading' && <p className="subtitle">Loading…</p>}

        {trainingDays.status === 'error' && (
          <p className="error" role="alert">
            {trainingDays.message}
          </p>
        )}

        {trainingDays.status === 'ready' && trainingDays.data.length === 0 && (
          <p className="subtitle">No training days planned yet.</p>
        )}

        {trainingDays.status === 'ready' && trainingDays.data.length > 0 && (
          <ul className="training-day-list">
            {trainingDays.data.map(({ slug, day, focus }) => (
              <li key={slug}>
                {/* Navigation, so a real link — Base UI's Button would impose button semantics. */}
                <Link className="card training-day-card" to={`/days/${slug}`}>
                  <p className="label">{day}</p>
                  <p className="message">{focus}</p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <nav className="home-nav">
        <Link className="nav-button" to="/profile">
          Profile settings
        </Link>
      </nav>
    </main>
  )
}

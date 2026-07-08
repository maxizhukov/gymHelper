import { Link } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'

const TRAINING_DAYS = [
  { day: 'Monday', focus: 'Грудь и трицепс' },
  { day: 'Wednesday', focus: 'Спина и бицепс' },
  { day: 'Friday', focus: 'Ноги и плечи' },
]

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
          {TRAINING_DAYS.map(({ day, focus }) => (
            <li key={day} className="card training-day-card">
              <p className="label">{day}</p>
              <p className="message">{focus}</p>
            </li>
          ))}
        </ul>
      </section>

      <nav className="home-nav">
        {/* Navigation, so a real link — Base UI's Button would impose button semantics. */}
        <Link className="nav-button" to="/profile">
          Profile settings
        </Link>
      </nav>
    </main>
  )
}

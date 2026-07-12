import { Tabs } from '@base-ui/react/tabs'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { useTrainingDays } from '../training-days'
import { useActiveWorkout } from '../workout'
import FoodPanel from './FoodPanel'
import StatsPanel from './StatsPanel'

export default function HomePage() {
  const { user } = useAuth()
  const trainingDays = useTrainingDays()
  const activeWorkout = useActiveWorkout()
  // Controlled, so the stats panel mounts — and so fetches — only once the tab
  // is actually opened. Training is what the home screen is for; stats are what
  // you read afterwards.
  const [tab, setTab] = useState('training')
  if (!user) return null

  // An unfinished workout is the only thing worth doing on this screen, so it
  // goes above everything else and one tap picks it back up.
  const active = activeWorkout.status === 'ready' ? activeWorkout.data : null

  return (
    <main className="app">
      <h1>GymHelper</h1>

      {active && (
        <Link
          className="workout-action workout-resume"
          to={`/workout/${active.id}`}
        >
          Resume {active.dayName} workout
        </Link>
      )}

      <div className="card status-ok">
        <p className="label">Signed in as</p>
        <p className="message">{user.username}</p>
      </div>

      <Tabs.Root
        className="home-tabs"
        value={tab}
        onValueChange={(value) => setTab(String(value))}
      >
        <Tabs.List className="tab-list">
          <Tabs.Tab className="tab" value="training">
            Training
          </Tabs.Tab>
          <Tabs.Tab className="tab" value="stats">
            Stats
          </Tabs.Tab>
          <Tabs.Tab className="tab" value="food">
            Food
          </Tabs.Tab>
          <Tabs.Indicator className="tab-indicator" />
        </Tabs.List>

        <Tabs.Panel className="tab-panel" value="training">
          <section
            className="training-days"
            aria-labelledby="training-days-heading"
          >
            <h2 id="training-days-heading">Training days</h2>

            {trainingDays.status === 'loading' && (
              <p className="subtitle">Loading…</p>
            )}

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
        </Tabs.Panel>

        <Tabs.Panel className="tab-panel" value="stats">
          {tab === 'stats' && <StatsPanel />}
        </Tabs.Panel>

        <Tabs.Panel className="tab-panel" value="food">
          {tab === 'food' && <FoodPanel />}
        </Tabs.Panel>
      </Tabs.Root>

      <nav className="home-nav">
        <Link className="nav-button" to="/profile">
          Profile settings
        </Link>
      </nav>
    </main>
  )
}

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { useTrainingDays } from '../training-days'
import { useActiveWorkout } from '../workout'
import ExercisesPanel from './ExercisesPanel'
import FoodPanel from './FoodPanel'
import StatsPanel from './StatsPanel'
import TrainingBuilderPanel from './TrainingBuilderPanel'

/** The four main sections reachable from the home screen. */
type Section = 'builder' | 'exercises' | 'food' | 'stats'

const SECTIONS: { view: Section; icon: string; title: string; blurb: string }[] = [
  { view: 'builder', icon: '🏗️', title: 'Training Builder', blurb: 'Build and edit plans' },
  { view: 'exercises', icon: '📚', title: 'Exercise Library', blurb: 'Browse all movements' },
  { view: 'food', icon: '🍎', title: 'Food Tracker', blurb: 'Log meals and macros' },
  { view: 'stats', icon: '📈', title: 'Progress', blurb: 'Stats and history' },
]

const SECTION_TITLES: Record<Section, string> = {
  builder: 'Training Builder',
  exercises: 'Exercise Library',
  food: 'Food Tracker',
  stats: 'Progress',
}

export default function HomePage() {
  const { user } = useAuth()
  const trainingDays = useTrainingDays()
  const activeWorkout = useActiveWorkout()
  // 'home' is the clean hub of cards; opening a card swaps in that one section,
  // so a phone only ever shows one thing at a time instead of a crowded tab row.
  const [view, setView] = useState<'home' | Section>('home')
  if (!user) return null

  // An unfinished workout is the single most important action, so it becomes the
  // one bright primary button at the top of the hub.
  const active = activeWorkout.status === 'ready' ? activeWorkout.data : null

  if (view !== 'home') {
    return (
      <main className="app">
        <button type="button" className="back-link" onClick={() => setView('home')}>
          ← Home
        </button>
        <h1 className="home-section-title">{SECTION_TITLES[view]}</h1>
        {view === 'builder' && <TrainingBuilderPanel />}
        {view === 'exercises' && <ExercisesPanel />}
        {view === 'food' && <FoodPanel />}
        {view === 'stats' && <StatsPanel />}
      </main>
    )
  }

  return (
    <main className="app">
      <h1>GymHelper</h1>

      {/* One clear primary action: resume if a workout is live, otherwise start one. */}
      {active ? (
        <Link
          className="workout-action workout-resume"
          to={`/workout/${active.id}`}
        >
          Resume {active.dayName} workout
        </Link>
      ) : (
        <section className="home-start" aria-labelledby="home-start-heading">
          <h2 id="home-start-heading" className="home-eyebrow">
            Start a workout
          </h2>

          {trainingDays.status === 'loading' && (
            <p className="subtitle">Loading…</p>
          )}

          {trainingDays.status === 'error' && (
            <p className="error" role="alert">
              {trainingDays.message}
            </p>
          )}

          {trainingDays.status === 'ready' && trainingDays.data.length === 0 && (
            <button
              type="button"
              className="card home-start-empty"
              onClick={() => setView('builder')}
            >
              <span className="label">No training days yet</span>
              <span className="message">Open the Training Builder to plan one →</span>
            </button>
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
      )}

      <nav className="home-cards" aria-label="Main sections">
        {SECTIONS.map((section) => (
          <button
            key={section.view}
            type="button"
            className="card home-card"
            onClick={() => setView(section.view)}
          >
            <span className="home-card-icon" aria-hidden="true">
              {section.icon}
            </span>
            <span className="home-card-title">{section.title}</span>
            <span className="home-card-blurb">{section.blurb}</span>
          </button>
        ))}
      </nav>

      <nav className="home-secondary">
        <Link className="home-secondary-link" to="/profile">
          Profile &amp; settings
        </Link>
      </nav>
    </main>
  )
}

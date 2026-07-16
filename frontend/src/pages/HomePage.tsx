import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { useTemplate, useTemplates } from '../training-builder'
import { startWorkoutFromTemplateDay, useActiveWorkout } from '../workout'
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

      {/* One clear primary action: resume if a workout is live, otherwise start
          one from a Training Builder plan. */}
      {active ? (
        <Link
          className="workout-action workout-resume"
          to={`/workout/${active.id}`}
        >
          Continue {active.dayName} workout
        </Link>
      ) : (
        <StartTraining onOpenBuilder={() => setView('builder')} />
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

/**
 * The "Start training" flow, shown when there is no workout to resume. It reads
 * the user's Training Builder plans from the database and walks them through
 * plan → day → start. Every state has a clear next step: no plans, an empty
 * plan, or an empty day each point at the Training Builder rather than dead-end.
 */
function StartTraining({ onOpenBuilder }: { onOpenBuilder: () => void }) {
  const { state: templates } = useTemplates()
  const [selectedTemplateId, setSelectedTemplateId] = useState<number | null>(null)

  // Once the plans arrive, open the first one so a day is only ever a tap away.
  useEffect(() => {
    if (templates.status !== 'ready') return
    setSelectedTemplateId((current) => {
      if (current !== null && templates.data.some((t) => t.id === current)) {
        return current
      }
      return templates.data[0]?.id ?? null
    })
  }, [templates])

  return (
    <section className="home-start" aria-labelledby="home-start-heading">
      <h2 id="home-start-heading" className="home-eyebrow">
        Start training
      </h2>

      {templates.status === 'loading' && <p className="subtitle">Loading…</p>}

      {templates.status === 'error' && (
        <p className="error" role="alert">
          {templates.message}
        </p>
      )}

      {templates.status === 'ready' && templates.data.length === 0 && (
        <button
          type="button"
          className="card home-start-empty"
          onClick={onOpenBuilder}
        >
          <span className="label">No training plans yet</span>
          <span className="message">
            Create your first plan in the Training Builder →
          </span>
        </button>
      )}

      {templates.status === 'ready' && templates.data.length > 0 && (
        <>
          {templates.data.length > 1 && (
            <ul className="home-plan-list" aria-label="Your plans">
              {templates.data.map((template) => (
                <li key={template.id}>
                  <button
                    type="button"
                    className={`home-plan-chip${
                      template.id === selectedTemplateId
                        ? ' home-plan-chip-selected'
                        : ''
                    }`}
                    aria-pressed={template.id === selectedTemplateId}
                    onClick={() => setSelectedTemplateId(template.id)}
                  >
                    {template.name}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {selectedTemplateId !== null && (
            <PlanDays
              key={selectedTemplateId}
              templateId={selectedTemplateId}
              onOpenBuilder={onOpenBuilder}
            />
          )}
        </>
      )}
    </section>
  )
}

/**
 * The days of one plan, and the button that starts the chosen one. Selecting a
 * day previews how many exercises it holds; an empty day cannot be started and
 * instead points at the Training Builder to add exercises.
 */
function PlanDays({
  templateId,
  onOpenBuilder,
}: {
  templateId: number
  onOpenBuilder: () => void
}) {
  const navigate = useNavigate()
  const { state } = useTemplate(templateId)
  const [selectedDayId, setSelectedDayId] = useState<number | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')

  const days = state.status === 'ready' ? state.data.days : []

  // Default to the first day whenever the plan (or its days) changes.
  useEffect(() => {
    setSelectedDayId((current) => {
      if (current !== null && days.some((d) => d.id === current)) return current
      return days[0]?.id ?? null
    })
  }, [days])

  if (state.status === 'loading') return <p className="subtitle">Loading…</p>
  if (state.status === 'not-found') return null
  if (state.status === 'error') {
    return (
      <p className="error" role="alert">
        {state.message}
      </p>
    )
  }

  if (days.length === 0) {
    return (
      <button
        type="button"
        className="card home-start-empty"
        onClick={onOpenBuilder}
      >
        <span className="label">This plan has no days yet</span>
        <span className="message">Add a training day in the Builder →</span>
      </button>
    )
  }

  const selectedDay = days.find((d) => d.id === selectedDayId) ?? null

  async function handleStart() {
    if (!selectedDay || selectedDay.exercises.length === 0) return
    setStarting(true)
    try {
      const result = await startWorkoutFromTemplateDay(selectedDay.id)
      void navigate(`/workout/${result.workout.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the workout.')
      setStarting(false)
    }
  }

  return (
    <>
      <ul className="training-day-list home-day-list">
        {days.map((day) => (
          <li key={day.id}>
            <button
              type="button"
              className={`card training-day-card home-day-card${
                day.id === selectedDayId ? ' home-day-selected' : ''
              }`}
              aria-pressed={day.id === selectedDayId}
              onClick={() => setSelectedDayId(day.id)}
            >
              <span className="label">{day.name}</span>
              <span className="message">
                {day.exercises.length === 0
                  ? 'No exercises yet'
                  : `${day.exercises.length} exercise${
                      day.exercises.length === 1 ? '' : 's'
                    }`}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {selectedDay && selectedDay.exercises.length === 0 ? (
        <button
          type="button"
          className="card home-start-empty"
          onClick={onOpenBuilder}
        >
          <span className="label">No exercises on this day</span>
          <span className="message">Add exercises in the Builder →</span>
        </button>
      ) : (
        <button
          type="button"
          className="workout-action"
          disabled={starting || !selectedDay}
          onClick={() => void handleStart()}
        >
          {starting
            ? 'Starting…'
            : selectedDay
              ? `Start ${selectedDay.name}`
              : 'Start training'}
        </button>
      )}
    </>
  )
}

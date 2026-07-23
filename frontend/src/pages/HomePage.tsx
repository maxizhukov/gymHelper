import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Loadable } from '../api'
import { useAuth } from '../auth/useAuth'
import { fetchToday, type DayLog } from '../food'
import {
  useTemplate,
  useTemplates,
  type TemplateDay,
  type TemplateSummary,
} from '../training-builder'
import { useActiveWorkout } from '../workout'
import BackHeader from '../components/BackHeader'
import TabBar, { type Tab } from '../components/TabBar'
import { BookIcon, DumbbellIcon, PlayIcon } from '../components/icons'
import ExercisesPanel from './ExercisesPanel'
import FoodPanel from './FoodPanel'
import { ProfileContent } from './ProfilePage'
import StatsPanel from './StatsPanel'
import TrainingBuilderPanel from './TrainingBuilderPanel'
import WorkoutPreview from './WorkoutPreview'

/** Screens pushed on top of a section root; they hide the tab bar. */
type Pushed = 'builder' | 'exercises' | 'preview'

/**
 * The signed-in app shell. It recreates the design's navigation model: a
 * liquid-glass bottom tab bar across the five section roots (Home, Train, Food,
 * Progress, Profile), with pushed views — the workout preview, Training Builder
 * and Exercise Library — swapping the tab bar for a back header. All screen
 * state lives here so the dashboard and the Train tab share one plan/day
 * selection; every panel still reads its own data from the backend.
 */
export default function HomePage() {
  const { user } = useAuth()
  const activeWorkout = useActiveWorkout()
  const [tab, setTab] = useState<Tab>('home')
  const [pushed, setPushed] = useState<Pushed | null>(null)

  // One plan/day selection, shared by the dashboard hero and the Train tab.
  const { state: templates } = useTemplates()
  const [templateId, setTemplateId] = useState<number | null>(null)
  useEffect(() => {
    if (templates.status !== 'ready') return
    setTemplateId((current) =>
      current !== null && templates.data.some((t) => t.id === current)
        ? current
        : (templates.data[0]?.id ?? null),
    )
  }, [templates])

  const { state: template } = useTemplate(templateId)
  const days = template.status === 'ready' ? template.data.days : []
  const templateName = template.status === 'ready' ? template.data.name : ''
  const [dayId, setDayId] = useState<number | null>(null)
  useEffect(() => {
    setDayId((current) =>
      current !== null && days.some((d) => d.id === current)
        ? current
        : (days[0]?.id ?? null),
    )
  }, [days])
  const selectedDay = days.find((d) => d.id === dayId) ?? null

  if (!user) return null

  const active =
    activeWorkout.status === 'ready' ? activeWorkout.data : null

  const openPreview = () => setPushed('preview')
  const openBuilder = () => setPushed('builder')
  const openExercises = () => setPushed('exercises')

  // ── Pushed views: back header, no tab bar ────────────────────────────────
  if (pushed === 'builder') {
    return (
      <PushedScreen title="Training Builder" onBack={() => setPushed(null)}>
        <TrainingBuilderPanel />
      </PushedScreen>
    )
  }
  if (pushed === 'exercises') {
    return (
      <PushedScreen title="Exercise Library" onBack={() => setPushed(null)}>
        <ExercisesPanel />
      </PushedScreen>
    )
  }
  if (pushed === 'preview' && selectedDay) {
    return (
      <PushedScreen title="Preview" onBack={() => setPushed(null)}>
        <WorkoutPreview
          templateName={templateName}
          day={selectedDay}
          onBack={() => setPushed(null)}
          onEditInBuilder={openBuilder}
        />
      </PushedScreen>
    )
  }

  // ── Section roots: tab content + bottom tab bar ──────────────────────────
  return (
    <div className="screen">
      <div className="screen-scroll with-tabbar">
        {tab === 'home' && (
          <Dashboard
            username={user.username}
            active={active}
            templatesReady={templates.status === 'ready'}
            hasTemplates={templates.status === 'ready' && templates.data.length > 0}
            selectedDay={selectedDay}
            days={days}
            dayId={dayId}
            onSelectDay={setDayId}
            onStart={openPreview}
            onOpenBuilder={openBuilder}
            onOpenExercises={openExercises}
            onOpenFood={() => setTab('food')}
            onOpenProfile={() => setTab('profile')}
          />
        )}

        {tab === 'train' && (
          <TrainTab
            templates={templates}
            templateId={templateId}
            onSelectTemplate={setTemplateId}
            days={days}
            dayId={dayId}
            selectedDay={selectedDay}
            onSelectDay={setDayId}
            active={active}
            onStart={openPreview}
            onOpenBuilder={openBuilder}
          />
        )}

        {tab === 'food' && (
          <>
            <div className="page-head">
              <h1 className="page-title">Food</h1>
            </div>
            <FoodPanel />
          </>
        )}

        {tab === 'progress' && (
          <>
            <div className="page-head">
              <h1 className="page-title">Progress</h1>
            </div>
            <StatsPanel />
          </>
        )}

        {tab === 'profile' && <ProfileContent />}
      </div>

      <TabBar active={tab} onSelect={setTab} />
    </div>
  )
}

/** Full-height column with a back header and a scrolling content region. */
function PushedScreen({
  title,
  onBack,
  children,
}: {
  title: string
  onBack: () => void
  children: React.ReactNode
}) {
  return (
    <div className="screen">
      <BackHeader title={title} onBack={onBack} />
      <div className="screen-scroll has-header">{children}</div>
    </div>
  )
}

/* ── Home dashboard ─────────────────────────────────────────────────────── */

type ActiveWorkout = { id: number; dayName: string }

function Dashboard({
  username,
  active,
  templatesReady,
  hasTemplates,
  selectedDay,
  days,
  dayId,
  onSelectDay,
  onStart,
  onOpenBuilder,
  onOpenExercises,
  onOpenFood,
  onOpenProfile,
}: {
  username: string
  active: ActiveWorkout | null
  templatesReady: boolean
  hasTemplates: boolean
  selectedDay: TemplateDay | null
  days: TemplateDay[]
  dayId: number | null
  onSelectDay: (id: number) => void
  onStart: () => void
  onOpenBuilder: () => void
  onOpenExercises: () => void
  onOpenFood: () => void
  onOpenProfile: () => void
}) {
  const now = new Date()
  const dateLabel = now.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  })
  const hour = now.getHours()
  const partOfDay =
    hour < 12 ? 'Morning' : hour < 18 ? 'Afternoon' : 'Evening'
  const name = username.charAt(0).toUpperCase() + username.slice(1)

  return (
    <div className="dash">
      <header className="dash-greet">
        <div>
          <div className="dash-date">{dateLabel}</div>
          <h1 className="dash-hello">
            {partOfDay}, {name}
          </h1>
        </div>
        <button
          type="button"
          className="dash-avatar"
          onClick={onOpenProfile}
          aria-label="Profile"
        >
          {name.charAt(0)}
        </button>
      </header>

      <NutritionCard onOpen={onOpenFood} />

      {active ? (
        <Link className="hero-card" to={`/workout/${active.id}`}>
          <div className="hero-main">
            <div className="hero-eyebrow">In progress</div>
            <div className="hero-title">{active.dayName}</div>
            <div className="hero-sub">Tap to continue your workout</div>
          </div>
          <span className="hero-start">
            <PlayIcon size={12} />
            Resume
          </span>
        </Link>
      ) : hasTemplates && selectedDay ? (
        <div className="hero-card">
          <div className="hero-main">
            <div className="hero-eyebrow">Selected workout</div>
            <div className="hero-title">{selectedDay.name}</div>
            <div className="hero-sub">
              {selectedDay.exercises.length === 0
                ? 'No exercises yet'
                : `${selectedDay.exercises.length} exercise${
                    selectedDay.exercises.length === 1 ? '' : 's'
                  }`}
            </div>
          </div>
          <button
            type="button"
            className="hero-start"
            onClick={onStart}
            disabled={selectedDay.exercises.length === 0}
          >
            <PlayIcon size={12} />
            Start
          </button>
        </div>
      ) : templatesReady ? (
        <button type="button" className="hero-card hero-card-empty" onClick={onOpenBuilder}>
          <div className="hero-main">
            <div className="hero-eyebrow">Get started</div>
            <div className="hero-title">No training plans yet</div>
            <div className="hero-sub">Create your first plan in the Training Builder →</div>
          </div>
        </button>
      ) : null}

      {days.length > 0 && (
        <section>
          <div className="section-eyebrow">Your split</div>
          <ul className="split-list">
            {days.map((day) => (
              <li key={day.id}>
                <button
                  type="button"
                  className={`split-row${day.id === dayId ? ' is-active' : ''}`}
                  aria-pressed={day.id === dayId}
                  onClick={() => onSelectDay(day.id)}
                >
                  <span className="split-dot" aria-hidden="true" />
                  <span className="split-main">
                    <span className="split-name">{day.name}</span>
                    <span className="split-sub">
                      {day.exercises.length === 0
                        ? 'No exercises'
                        : `${day.exercises.length} exercise${
                            day.exercises.length === 1 ? '' : 's'
                          }`}
                    </span>
                  </span>
                  <span className="split-count">{day.exercises.length}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="qa-grid">
        <button type="button" className="qa-card" onClick={onOpenBuilder}>
          <span className="qa-icon indigo">
            <DumbbellIcon size={22} />
          </span>
          <span className="qa-title">Training Builder</span>
          <span className="qa-sub">Build and edit plans</span>
        </button>
        <button type="button" className="qa-card" onClick={onOpenExercises}>
          <span className="qa-icon cyan">
            <BookIcon size={22} />
          </span>
          <span className="qa-title">Exercise Library</span>
          <span className="qa-sub">Browse all movements</span>
        </button>
      </div>
    </div>
  )
}

/**
 * Today's nutrition summary on the dashboard, read live from the food log so
 * the card mirrors the real diary. It is a shortcut into the Food tab.
 */
function NutritionCard({ onOpen }: { onOpen: () => void }) {
  const [day, setDay] = useState<DayLog | null>(null)
  useEffect(() => {
    let alive = true
    void fetchToday()
      .then((d) => {
        if (alive) setDay(d)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const kcal = day ? Math.round(day.totals.calories_kcal ?? 0) : 0
  const kcalGoal = day ? Math.round(day.targets.calories_kcal ?? 0) : 0
  const pct = kcalGoal > 0 ? Math.min(100, (kcal / kcalGoal) * 100) : 0

  const macro = (key: 'protein_g' | 'carbs_g' | 'fat_g') => ({
    value: day ? Math.round(day.totals[key] ?? 0) : 0,
    goal: day ? Math.round(day.targets[key] ?? 0) : 0,
  })
  const protein = macro('protein_g')
  const carbs = macro('carbs_g')
  const fat = macro('fat_g')

  return (
    <button type="button" className="nutri-card" onClick={onOpen}>
      <div className="nutri-head">
        <span className="overline">Today's nutrition</span>
        <span className="nutri-kcal">
          {kcal.toLocaleString()}
          <span> / {kcalGoal.toLocaleString()} kcal</span>
        </span>
      </div>
      <div className="nutri-bar">
        <div className="nutri-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="nutri-macros">
        <div>
          <div className="macro-head">
            <span className="macro-dot protein" />
            <span className="macro-label">Protein</span>
          </div>
          <div className="macro-val">
            {protein.value}
            <span>/{protein.goal}g</span>
          </div>
        </div>
        <div>
          <div className="macro-head">
            <span className="macro-dot carbs" />
            <span className="macro-label">Carbs</span>
          </div>
          <div className="macro-val">
            {carbs.value}
            <span>/{carbs.goal}g</span>
          </div>
        </div>
        <div>
          <div className="macro-head">
            <span className="macro-dot fat" />
            <span className="macro-label">Fat</span>
          </div>
          <div className="macro-val">
            {fat.value}
            <span>/{fat.goal}g</span>
          </div>
        </div>
      </div>
    </button>
  )
}

/* ── Train tab ──────────────────────────────────────────────────────────── */

/**
 * The Train tab: choose a plan and a day, then preview it. Starting a workout
 * happens only inside the preview, so this screen never writes to the database.
 */
function TrainTab({
  templates,
  templateId,
  onSelectTemplate,
  days,
  dayId,
  selectedDay,
  onSelectDay,
  active,
  onStart,
  onOpenBuilder,
}: {
  templates: Loadable<TemplateSummary[]>
  templateId: number | null
  onSelectTemplate: (id: number) => void
  days: TemplateDay[]
  dayId: number | null
  selectedDay: TemplateDay | null
  onSelectDay: (id: number) => void
  active: ActiveWorkout | null
  onStart: () => void
  onOpenBuilder: () => void
}) {
  return (
    <div className="dash">
      <div className="page-head">
        <h1 className="page-title">Train</h1>
        <p className="page-sub">Pick a day and preview before you start.</p>
      </div>

      {active && (
        <Link className="hero-card" to={`/workout/${active.id}`}>
          <div className="hero-main">
            <div className="hero-eyebrow">In progress</div>
            <div className="hero-title">{active.dayName}</div>
            <div className="hero-sub">Tap to continue your workout</div>
          </div>
          <span className="hero-start">
            <PlayIcon size={12} />
            Resume
          </span>
        </Link>
      )}

      {templates.status === 'loading' && <p className="subtitle">Loading…</p>}
      {templates.status === 'error' && (
        <p className="error" role="alert">
          {templates.message}
        </p>
      )}

      {templates.status === 'ready' && templates.data.length === 0 && (
        <button type="button" className="hero-card hero-card-empty" onClick={onOpenBuilder}>
          <div className="hero-main">
            <div className="hero-eyebrow">Get started</div>
            <div className="hero-title">No training plans yet</div>
            <div className="hero-sub">Create your first plan in the Training Builder →</div>
          </div>
        </button>
      )}

      {templates.status === 'ready' && templates.data.length > 1 && (
        <ul className="home-plan-list" aria-label="Your plans">
          {templates.data.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                className={`home-plan-chip${
                  t.id === templateId ? ' home-plan-chip-selected' : ''
                }`}
                aria-pressed={t.id === templateId}
                onClick={() => onSelectTemplate(t.id)}
              >
                {t.name}
              </button>
            </li>
          ))}
        </ul>
      )}

      {days.length > 0 && (
        <section>
          <div className="section-eyebrow">Days</div>
          <ul className="split-list">
            {days.map((day) => (
              <li key={day.id}>
                <button
                  type="button"
                  className={`split-row${day.id === dayId ? ' is-active' : ''}`}
                  aria-pressed={day.id === dayId}
                  onClick={() => onSelectDay(day.id)}
                >
                  <span className="split-dot" aria-hidden="true" />
                  <span className="split-main">
                    <span className="split-name">{day.name}</span>
                    <span className="split-sub">
                      {day.exercises.length === 0
                        ? 'No exercises'
                        : `${day.exercises.length} exercise${
                            day.exercises.length === 1 ? '' : 's'
                          }`}
                    </span>
                  </span>
                  <span className="split-count">{day.exercises.length}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {selectedDay && (
        <button
          type="button"
          className="btn-primary"
          disabled={selectedDay.exercises.length === 0}
          onClick={onStart}
        >
          {selectedDay.exercises.length === 0
            ? 'No exercises on this day'
            : `Preview ${selectedDay.name}`}
        </button>
      )}
    </div>
  )
}

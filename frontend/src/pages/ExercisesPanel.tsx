import { useEffect, useMemo, useState } from 'react'
import { useExerciseLibrary, type LibraryExercise } from '../exercise-library'
import { ExerciseHistoryModal } from './ExerciseHistory'

/**
 * Turns a YouTube URL (watch, youtu.be, shorts, or already-embed form) into an
 * embeddable URL. Returns null when the URL isn't a recognizable YouTube link,
 * so the detail view can fall back to a plain link instead of a broken iframe.
 */
function youTubeEmbedUrl(url: string | null): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.replace(/^www\./, '')
    let id: string | null = null
    if (host === 'youtu.be') {
      id = parsed.pathname.slice(1)
    } else if (host === 'youtube.com' || host === 'm.youtube.com') {
      if (parsed.pathname === '/watch') {
        id = parsed.searchParams.get('v')
      } else if (parsed.pathname.startsWith('/embed/')) {
        id = parsed.pathname.slice('/embed/'.length)
      } else if (parsed.pathname.startsWith('/shorts/')) {
        id = parsed.pathname.slice('/shorts/'.length)
      }
    }
    if (!id) return null
    id = id.split('/')[0]
    return /^[\w-]{6,}$/.test(id) ? `https://www.youtube.com/embed/${id}` : null
  } catch {
    return null
  }
}

/** A group of exercises sharing a category and muscle group, kept in order. */
type ExerciseGroup = {
  key: string
  category: string
  muscleGroup: string
  exercises: LibraryExercise[]
}

/**
 * Groups the already-sorted library (category → muscle group → name) into
 * headed sections without disturbing the server's ordering. Rows arrive sorted,
 * so a new group begins whenever the category or muscle group changes.
 */
function groupExercises(exercises: LibraryExercise[]): ExerciseGroup[] {
  const groups: ExerciseGroup[] = []
  for (const exercise of exercises) {
    const category = exercise.category ?? 'Uncategorized'
    const muscleGroup = exercise.muscleGroup ?? 'Other'
    const last = groups[groups.length - 1]
    if (!last || last.category !== category || last.muscleGroup !== muscleGroup) {
      groups.push({
        key: `${category}—${muscleGroup}`,
        category,
        muscleGroup,
        exercises: [exercise],
      })
    } else {
      last.exercises.push(exercise)
    }
  }
  return groups
}

/** The muscle-group / category tags shown on the card summary. */
function summaryLine(exercise: LibraryExercise): string {
  return [exercise.category, exercise.muscleGroup]
    .filter((part): part is string => Boolean(part))
    .join(' · ')
}

/** The detail body revealed when a card is expanded. */
function ExerciseDetail({ exercise }: { exercise: LibraryExercise }) {
  const [historyOpen, setHistoryOpen] = useState(false)
  const embedUrl = youTubeEmbedUrl(exercise.videoUrl)
  const details = [
    exercise.equipment,
    exercise.movementPattern,
    exercise.difficulty,
  ].filter((detail): detail is string => Boolean(detail))

  return (
    <div className="exercise-detail">
      {details.length > 0 && (
        <p className="message exercise-detail-tags">{details.join(' · ')}</p>
      )}
      {exercise.descriptionRu && (
        <p className="exercise-detail-description">{exercise.descriptionRu}</p>
      )}
      {embedUrl && (
        <div className="exercise-video">
          <iframe
            src={embedUrl}
            title={`${exercise.name} video`}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            loading="lazy"
          />
        </div>
      )}
      <div className="exercise-detail-actions">
        <button
          type="button"
          className="nav-button exercise-detail-history"
          onClick={() => setHistoryOpen(true)}
        >
          History
        </button>
        {exercise.sourceUrl && (
          <a
            className="exercise-source"
            href={exercise.sourceUrl}
            target="_blank"
            rel="noreferrer"
          >
            Source
          </a>
        )}
      </div>
      <ExerciseHistoryModal
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        exerciseName={exercise.name}
        exerciseLibraryId={exercise.id}
      />
    </div>
  )
}

/** One exercise card: a thumbnail-led summary that expands to full details. */
function ExerciseRow({ exercise }: { exercise: LibraryExercise }) {
  const [expanded, setExpanded] = useState(false)
  const summary = summaryLine(exercise)

  return (
    <li className="card exercise-card">
      <button
        type="button"
        className="exercise-card-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {exercise.thumbnailUrl && (
          <img
            className="exercise-thumbnail"
            src={exercise.thumbnailUrl}
            alt=""
            loading="lazy"
          />
        )}
        <span className="exercise-card-heading">
          <span className="label">{exercise.name}</span>
          {summary && <span className="message">{summary}</span>}
          {(exercise.usedInPlans || exercise.usedInWorkouts) && (
            <span className="exercise-badges">
              {exercise.usedInPlans && (
                <span className="exercise-badge exercise-badge-plan">In plan</span>
              )}
              {exercise.usedInWorkouts && (
                <span className="exercise-badge exercise-badge-used">
                  Used before
                </span>
              )}
            </span>
          )}
        </span>
      </button>
      {expanded && <ExerciseDetail exercise={exercise} />}
    </li>
  )
}

/** How many rows are shown before "Show more"; each press reveals another page. */
const PAGE_SIZE = 50

/** Which usage bucket the quick-filter chips select. */
type UsageFilter = 'all' | 'plans' | 'history'

/** The category order the app prefers; anything else is appended alphabetically. */
const CATEGORY_ORDER = [
  'Back and Neck',
  'Legs and Glutes',
  'Chest',
  'Arms',
  'Shoulders',
  'Abs and Obliques',
  'Legs',
  'Specific',
]

/** Distinct, non-empty values of one field, ordered by `order` then alphabetically. */
function distinct(
  exercises: LibraryExercise[],
  pick: (exercise: LibraryExercise) => string | null,
  order: string[] = [],
): string[] {
  const values = new Set<string>()
  for (const exercise of exercises) {
    const value = pick(exercise)
    if (value) values.add(value)
  }
  return [...values].sort((a, b) => {
    const ia = order.indexOf(a)
    const ib = order.indexOf(b)
    if (ia !== -1 || ib !== -1) {
      return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib)
    }
    return a.localeCompare(b)
  })
}

/**
 * The Exercises tab. The catalogue of movements lives in Postgres and is read
 * from `/api/exercises` with per-user usage metadata; this component searches,
 * filters, and pages the sorted list so a ~400-row library never lands as one
 * wall of DOM. It is read-only — later these connect to training plans so an
 * exercise in a workout can be swapped for another from here.
 */
export default function ExercisesPanel() {
  const library = useExerciseLibrary()

  const [query, setQuery] = useState('')
  const [usage, setUsage] = useState<UsageFilter>('all')
  const [category, setCategory] = useState('')
  const [muscleGroup, setMuscleGroup] = useState('')
  const [visible, setVisible] = useState(PAGE_SIZE)

  const all = library.status === 'ready' ? library.data : []

  // Chip totals come straight from the usage flags the server annotated.
  const counts = useMemo(
    () => ({
      all: all.length,
      plans: all.filter((exercise) => exercise.usedInPlans).length,
      history: all.filter((exercise) => exercise.usedInWorkouts).length,
    }),
    [all],
  )

  const categories = useMemo(
    () => distinct(all, (exercise) => exercise.category, CATEGORY_ORDER),
    [all],
  )
  // Muscle-group options follow the chosen category so the two stay coherent.
  const muscleGroups = useMemo(
    () =>
      distinct(
        category ? all.filter((e) => e.category === category) : all,
        (exercise) => exercise.muscleGroup,
      ),
    [all, category],
  )

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return all.filter((exercise) => {
      if (usage === 'plans' && !exercise.usedInPlans) return false
      if (usage === 'history' && !exercise.usedInWorkouts) return false
      if (category && exercise.category !== category) return false
      if (muscleGroup && exercise.muscleGroup !== muscleGroup) return false
      if (!needle) return true
      return [
        exercise.name,
        exercise.category,
        exercise.muscleGroup,
        exercise.descriptionRu,
      ]
        .filter((part): part is string => Boolean(part))
        .some((part) => part.toLowerCase().includes(needle))
    })
  }, [all, query, usage, category, muscleGroup])

  // Any filter change starts the page over, so "Show more" never carries a stale
  // offset from the previous, larger result set.
  useEffect(() => {
    setVisible(PAGE_SIZE)
  }, [query, usage, category, muscleGroup])

  const hasFilters =
    query.trim() !== '' || usage !== 'all' || category !== '' || muscleGroup !== ''

  function clearFilters() {
    setQuery('')
    setUsage('all')
    setCategory('')
    setMuscleGroup('')
  }

  if (library.status === 'loading') return <p className="subtitle">Loading…</p>
  if (library.status === 'error') {
    return (
      <p className="error" role="alert">
        {library.message}
      </p>
    )
  }
  if (library.status === 'not-found') return null

  if (all.length === 0) {
    return (
      <div className="card stats-empty">
        <p className="label">No exercises yet</p>
        <p className="message">The exercise library is empty.</p>
      </div>
    )
  }

  const shown = filtered.slice(0, visible)
  const groups = groupExercises(shown)

  return (
    <div className="exercise-library">
      <div className="exercise-toolbar">
        <input
          className="builder-input exercise-search"
          type="search"
          placeholder="Search exercises…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />

        <div className="exercise-chips" role="group" aria-label="Usage filter">
          <button
            type="button"
            className={`exercise-chip${usage === 'all' ? ' is-active' : ''}`}
            aria-pressed={usage === 'all'}
            onClick={() => setUsage('all')}
          >
            All <span className="exercise-chip-count">{counts.all}</span>
          </button>
          <button
            type="button"
            className={`exercise-chip${usage === 'plans' ? ' is-active' : ''}`}
            aria-pressed={usage === 'plans'}
            onClick={() => setUsage('plans')}
          >
            In my plans{' '}
            <span className="exercise-chip-count">{counts.plans}</span>
          </button>
          <button
            type="button"
            className={`exercise-chip${usage === 'history' ? ' is-active' : ''}`}
            aria-pressed={usage === 'history'}
            onClick={() => setUsage('history')}
          >
            Used before{' '}
            <span className="exercise-chip-count">{counts.history}</span>
          </button>
        </div>

        <div className="exercise-selects">
          <select
            className="builder-input"
            aria-label="Filter by category"
            value={category}
            onChange={(event) => {
              setCategory(event.target.value)
              setMuscleGroup('')
            }}
          >
            <option value="">All categories</option>
            {categories.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <select
            className="builder-input"
            aria-label="Filter by muscle group"
            value={muscleGroup}
            onChange={(event) => setMuscleGroup(event.target.value)}
          >
            <option value="">All muscles</option>
            {muscleGroups.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>

        <div className="exercise-result-row">
          <p className="exercise-result-count message">
            {filtered.length === all.length
              ? `${filtered.length} exercises`
              : `${filtered.length} of ${all.length} exercises`}
          </p>
          {hasFilters && (
            <button
              type="button"
              className="exercise-clear-inline"
              onClick={clearFilters}
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="card stats-empty exercise-empty">
          <p className="label">No exercises found</p>
          <p className="message">Try a different search or clear the filters.</p>
          <button
            type="button"
            className="nav-button exercise-clear"
            onClick={clearFilters}
          >
            Clear filters
          </button>
        </div>
      ) : (
        <>
          {groups.map((group) => (
            <section
              key={group.key}
              className="exercise-group"
              aria-label={`${group.category} — ${group.muscleGroup}`}
            >
              <h3 className="exercise-group-heading">
                {group.category} · {group.muscleGroup}
              </h3>
              <ul className="exercise-list">
                {group.exercises.map((exercise) => (
                  <ExerciseRow key={exercise.id} exercise={exercise} />
                ))}
              </ul>
            </section>
          ))}

          {filtered.length > shown.length && (
            <button
              type="button"
              className="nav-button exercise-showmore"
              onClick={() => setVisible((value) => value + PAGE_SIZE)}
            >
              Show more ({filtered.length - shown.length} more)
            </button>
          )}
        </>
      )}
    </div>
  )
}

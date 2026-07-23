import { useState } from 'react'
import { Collapsible } from '@base-ui/react/collapsible'
import { useNavigate } from 'react-router-dom'
import { useExerciseDetail } from '../exercise-library'
import type { TemplateDay, TemplateDayExercise } from '../training-builder'
import { startWorkoutFromTemplateDay } from '../workout'
import { ExerciseInfoDetail, hasExerciseInfo } from './ExerciseInfo'

/**
 * The read-only "Today's workout" preview. Selecting a day opens this screen so
 * the user can read the whole plan — every exercise, in order, with its details
 * — before anything is committed. Nothing here writes to the database: a workout
 * session is created only when "Start workout" is pressed, and only then.
 *
 * The Start button owns the create call, disables itself while the request is in
 * flight, and navigates to the workout it created — so a double-tap cannot open
 * a second session. An empty day cannot be started at all; it points back at the
 * Builder to add exercises instead.
 */
export default function WorkoutPreview({
  templateName,
  day,
  onBack,
  onEditInBuilder,
}: {
  templateName: string
  day: TemplateDay
  /** Return to the day picker ("Change day"). */
  onBack: () => void
  /** Optional jump to the Training Builder to edit this plan. */
  onEditInBuilder?: () => void
}) {
  const navigate = useNavigate()
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const empty = day.exercises.length === 0

  async function handleStart() {
    // Guard the create call: an empty day has nothing to start, and a request
    // already in flight must not be fired a second time by a double-tap.
    if (empty || starting) return
    setStarting(true)
    setError('')
    try {
      const result = await startWorkoutFromTemplateDay(day.id)
      void navigate(`/workout/${result.workout.id}`)
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not start the workout.',
      )
      setStarting(false)
    }
  }

  return (
    <section className="workout-preview" aria-label="Today’s workout preview">
      <header className="workout-preview-header">
        <p className="home-eyebrow">
          Today’s workout{templateName ? ` · ${templateName}` : ''}
        </p>
        <h2 className="workout-preview-plan">{day.name}</h2>
        <p className="workout-preview-day">
          {day.exercises.length} exercise{day.exercises.length === 1 ? '' : 's'}
        </p>
      </header>

      {empty ? (
        <div className="card home-start-empty workout-preview-empty">
          <span className="label">This day has no exercises yet</span>
          {onEditInBuilder ? (
            <button
              type="button"
              className="nav-button workout-preview-empty-action"
              onClick={onEditInBuilder}
            >
              Add exercises in the Builder →
            </button>
          ) : (
            <span className="message">Add exercises in the Builder first.</span>
          )}
        </div>
      ) : (
        <ol className="workout-preview-list">
          {day.exercises.map((exercise, index) => (
            <PreviewExerciseRow
              key={exercise.id}
              exercise={exercise}
              number={index + 1}
            />
          ))}
        </ol>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="workout-preview-actions">
        {!empty && (
          <button
            type="button"
            className="btn-primary"
            disabled={starting}
            onClick={() => void handleStart()}
          >
            {starting ? 'Starting…' : 'Start workout'}
          </button>
        )}
        <button
          type="button"
          className="btn-glass workout-preview-back"
          disabled={starting}
          onClick={onBack}
        >
          ← Change day
        </button>
        {onEditInBuilder && !empty && (
          <button
            type="button"
            className="home-secondary-link workout-preview-edit"
            disabled={starting}
            onClick={onEditInBuilder}
          >
            Edit in Builder
          </button>
        )}
      </div>
    </section>
  )
}

/**
 * One exercise as it reads in the preview: a number, a thumbnail, its name and
 * category / muscle group, and a compact collapsible with the full details. The
 * library detail is fetched (and cached) here, which also warms the cache the
 * workout screen reads from moments later.
 */
function PreviewExerciseRow({
  exercise,
  number,
}: {
  exercise: TemplateDayExercise
  number: number
}) {
  const state = useExerciseDetail(exercise.exerciseLibraryId)
  const detail = state.status === 'ready' ? state.data : null
  const meta = [exercise.category, exercise.muscleGroup]
    .filter((part): part is string => Boolean(part))
    .join(' · ')

  return (
    <li className="card workout-preview-item">
      <div className="workout-preview-row">
        <span className="workout-preview-number" aria-hidden="true">
          {number}
        </span>
        {detail?.thumbnailUrl ? (
          <img
            className="workout-preview-thumb"
            src={detail.thumbnailUrl}
            alt=""
            loading="lazy"
          />
        ) : (
          <span
            className="workout-preview-thumb workout-preview-thumb-empty"
            aria-hidden="true"
          />
        )}
        <span className="workout-preview-info">
          <span className="workout-preview-name">{exercise.name}</span>
          {meta && <span className="workout-preview-meta">{meta}</span>}
        </span>
      </div>

      {/* Details fold away until asked for, so the list stays scannable. Shown
          only when the library has something extra to say about the movement. */}
      {detail && hasExerciseInfo(detail) && (
        <Collapsible.Root className="exercise-info workout-preview-collapsible">
          <Collapsible.Trigger className="exercise-info-trigger">
            <span className="exercise-info-chevron" aria-hidden="true" />
            <span className="exercise-info-title">Details</span>
          </Collapsible.Trigger>
          <Collapsible.Panel className="exercise-info-panel">
            <ExerciseInfoDetail exercise={detail} />
          </Collapsible.Panel>
        </Collapsible.Root>
      )}
    </li>
  )
}

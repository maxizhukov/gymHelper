import { useMemo, useState } from 'react'
import { Collapsible } from '@base-ui/react/collapsible'
import { useNavigate } from 'react-router-dom'
import { useExerciseDetail } from '../exercise-library'
import {
  reorderExercises,
  type TemplateDay,
  type TemplateDayExercise,
  type TemplateDayExerciseAlternative,
} from '../training-builder'
import { startWorkoutFromTemplateDay, type SlotSelection } from '../workout'
import { ExerciseInfoDetail, hasExerciseInfo } from './ExerciseInfo'

/**
 * The read-only "Today's workout" preview. Selecting a day opens this screen so
 * the user can read the whole plan — every exercise, in order, with its details
 * — before anything is committed. Nothing here writes to the database: a workout
 * session is created only when "Start workout" is pressed, and only then.
 *
 * Slots that offer alternatives can be rotated here before starting: the user
 * picks the actual movement for each such slot this session, defaulting to the
 * slot's main exercise. The chosen movements are sent with "Start workout", and
 * only then does the backend create the session using them.
 *
 * The exercise order can also be rearranged here with the same up/down move
 * used in the Training Builder. Each move persists immediately via the day's
 * reorder endpoint, so the plan itself is updated (not just this session).
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

  // The chosen library movement per slot, keyed by the slot's exercise id.
  // Defaults to each slot's main exercise; only slots with alternatives can be
  // changed. Re-keyed if the day itself changes.
  const [chosen, setChosen] = useState<Record<number, number>>(() =>
    Object.fromEntries(
      day.exercises.map((exercise) => [exercise.id, exercise.exerciseLibraryId]),
    ),
  )

  const chosenFor = (exercise: TemplateDayExercise): number =>
    chosen[exercise.id] ?? exercise.exerciseLibraryId

  // The exercise order shown and started from. Starts as the day's saved
  // order; each up/down move updates it locally and persists it to the day
  // via the same reorder endpoint the Builder uses, so the plan itself keeps
  // the new order (not just this session).
  const [order, setOrder] = useState<TemplateDayExercise[]>(() => day.exercises)
  const [reorderError, setReorderError] = useState('')

  async function move(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= order.length) return
    const next = [...order]
    ;[next[index], next[target]] = [next[target], next[index]]
    setOrder(next)
    try {
      await reorderExercises(day.id, next.map((exercise) => exercise.id))
      setReorderError('')
    } catch (err) {
      setOrder(order)
      setReorderError(
        err instanceof Error ? err.message : 'Could not reorder exercises.',
      )
    }
  }

  async function handleStart() {
    // Guard the create call: an empty day has nothing to start, and a request
    // already in flight must not be fired a second time by a double-tap.
    if (empty || starting) return
    setStarting(true)
    setError('')
    try {
      // Only send slots that were actually rotated off their main exercise; a
      // slot left on its default needs no selection (the backend defaults it).
      const selections: SlotSelection[] = order
        .filter((exercise) => chosenFor(exercise) !== exercise.exerciseLibraryId)
        .map((exercise) => ({
          templateDayExerciseId: exercise.id,
          exerciseLibraryId: chosenFor(exercise),
        }))
      const result = await startWorkoutFromTemplateDay(day.id, selections)
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
          {order.map((exercise, index) => (
            <PreviewExerciseRow
              key={exercise.id}
              exercise={exercise}
              number={index + 1}
              chosenLibraryId={chosenFor(exercise)}
              onChoose={(libraryId) =>
                setChosen((current) => ({ ...current, [exercise.id]: libraryId }))
              }
              first={index === 0}
              last={index === order.length - 1}
              onMoveUp={() => void move(index, -1)}
              onMoveDown={() => void move(index, 1)}
            />
          ))}
        </ol>
      )}

      {reorderError && (
        <p className="error" role="alert">
          {reorderError}
        </p>
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
 * category / muscle group, and a compact collapsible with the full details. When
 * the slot offers alternatives, a chooser lets the user pick the movement to
 * perform this session; the row's name, thumbnail, and details follow the choice.
 * The library detail is fetched (and cached) for the chosen movement, which also
 * warms the cache the workout screen reads from moments later.
 */
function PreviewExerciseRow({
  exercise,
  number,
  chosenLibraryId,
  onChoose,
  first,
  last,
  onMoveUp,
  onMoveDown,
}: {
  exercise: TemplateDayExercise
  number: number
  chosenLibraryId: number
  onChoose: (libraryId: number) => void
  first: boolean
  last: boolean
  onMoveUp: () => void
  onMoveDown: () => void
}) {
  const state = useExerciseDetail(chosenLibraryId)
  const detail = state.status === 'ready' ? state.data : null
  const hasAlternatives = exercise.alternatives.length > 0

  // Every movement the slot can be: its main exercise first, then its
  // alternatives in order. Used both for the chooser and to resolve the chosen
  // movement's name / meta when it is not the main.
  const options = useMemo(
    () => [
      {
        libraryId: exercise.exerciseLibraryId,
        name: exercise.name,
        category: exercise.category,
        muscleGroup: exercise.muscleGroup,
        isMain: true,
      },
      ...exercise.alternatives.map((alt: TemplateDayExerciseAlternative) => ({
        libraryId: alt.exerciseLibraryId,
        name: alt.name,
        category: alt.category,
        muscleGroup: alt.muscleGroup,
        isMain: false,
      })),
    ],
    [exercise],
  )
  const chosen = options.find((o) => o.libraryId === chosenLibraryId) ?? options[0]
  const meta = [chosen.category, chosen.muscleGroup]
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
          <span className="workout-preview-name">{chosen.name}</span>
          {meta && <span className="workout-preview-meta">{meta}</span>}
          {hasAlternatives && !chosen.isMain && (
            <span className="workout-preview-swapped">
              instead of {exercise.name}
            </span>
          )}
        </span>
        <span className="workout-preview-move" role="group" aria-label={`Reorder ${exercise.name}`}>
          <button
            type="button"
            className="builder-icon"
            aria-label={`Move ${exercise.name} up`}
            disabled={first}
            onClick={onMoveUp}
          >
            ↑
          </button>
          <button
            type="button"
            className="builder-icon"
            aria-label={`Move ${exercise.name} down`}
            disabled={last}
            onClick={onMoveDown}
          >
            ↓
          </button>
        </span>
      </div>

      {/* The substitution chooser: shown only when the slot offers alternatives.
          One pill per option, the main first, the chosen one highlighted. */}
      {hasAlternatives && (
        <div
          className="workout-preview-alts"
          role="group"
          aria-label={`Choose exercise for ${exercise.name}`}
        >
          {options.map((option) => (
            <button
              key={option.libraryId}
              type="button"
              className={`workout-preview-alt${
                option.libraryId === chosenLibraryId
                  ? ' workout-preview-alt-selected'
                  : ''
              }`}
              aria-pressed={option.libraryId === chosenLibraryId}
              onClick={() => onChoose(option.libraryId)}
            >
              {option.name}
              {option.isMain ? ' · main' : ''}
            </button>
          ))}
        </div>
      )}

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

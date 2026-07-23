import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@base-ui/react/button'
import { Collapsible } from '@base-ui/react/collapsible'
import { Dialog } from '@base-ui/react/dialog'
import { Field } from '@base-ui/react/field'
import { Form } from '@base-ui/react/form'
import { NumberField } from '@base-ui/react/number-field'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { useExerciseDetail } from '../exercise-library'
import { ExerciseInfoDetail, hasExerciseInfo } from './ExerciseInfo'
import {
  BODY_WEIGHT_MAX,
  BODY_WEIGHT_MIN,
  abandonWorkout,
  deferExercise,
  elapsedSeconds,
  finishSet,
  formatDuration,
  formatRelativeDay,
  formatSetWeights,
  formatShortDate,
  formatWeight,
  improvementOverLast,
  nextUp,
  restOverSeconds,
  restRemainingSeconds,
  saveBodyWeight,
  saveDraft,
  showMachineBusyButton,
  showMachineBusyButtonDuringRest,
  startNextSet,
  useExerciseHistory,
  useTicker,
  useWorkout,
  useWorkoutSummary,
  type AnchoredWorkout,
  type ExerciseHistory,
  type ExerciseMetric,
  type Improvement,
  type WorkoutAiSummary,
  type WorkoutAssessment,
  type WorkoutState,
} from '../workout'

/** What the assessment badge reads for each verdict. */
const ASSESSMENT_LABEL: Record<WorkoutAssessment, string> = {
  better: 'Better than last time',
  similar: 'On par with last time',
  worse: 'Down on last time',
  first: 'First session',
}

/** What the green marker says when today's numbers beat last time's. */
const IMPROVEMENT_LABEL: Record<Exclude<Improvement, 'none'>, string> = {
  weight: 'Heavier than last time',
  reps: 'More reps than last time',
  both: 'Heavier and more reps',
}

/**
 * How long to wait after a keystroke before writing the draft. Long enough not
 * to write on every digit of "1", "12", "125"; short enough that putting the
 * phone down mid-entry has already persisted it.
 */
const DRAFT_DEBOUNCE_MS = 400

/**
 * The workout screen. Every tap writes to the database and re-renders from the
 * state the server wrote back — nothing here decides what the workout looks
 * like. Reloading, or reopening the app after a crash, lands on exactly the
 * same screen because that screen is a function of the database.
 */
export default function WorkoutPage() {
  const { user } = useAuth()
  const { id } = useParams<{ id: string }>()
  const { state, replace } = useWorkout(id)

  if (!user) return null
  // An unknown or foreign workout id is not something the user can act on.
  if (state.status === 'not-found') return <Navigate to="/" replace />

  if (state.status === 'loading') {
    return (
      <main className="app">
        <p className="subtitle">Loading…</p>
      </main>
    )
  }

  if (state.status === 'error') {
    return (
      <main className="app">
        {/* Navigation, so a real link — Base UI's Button would impose button semantics. */}
        <Link className="back-link" to="/">
          Back
        </Link>
        <p className="error" role="alert">
          {state.message}
        </p>
      </main>
    )
  }

  // Remount on cursor change so the weight/reps inputs re-seed from the new set
  // rather than carrying the previous set's numbers forward as local state. The
  // exercise name is part of the key because reordering swaps the exercise under
  // a cursor that has not moved.
  const { workout } = state.data
  const cursorKey = `${workout.exerciseIndex}-${workout.exerciseName}-${workout.setNumber}-${workout.phase}`

  return <ActiveWorkout key={cursorKey} anchored={state.data} replace={replace} />
}

function ActiveWorkout({
  anchored,
  replace,
}: {
  anchored: AnchoredWorkout
  replace: (next: AnchoredWorkout) => void
}) {
  const navigate = useNavigate()
  const { workout } = anchored

  // Timers advance locally between responses; their values come from the server.
  useTicker(workout.phase !== 'completed')

  const [weight, setWeight] = useState<number | null>(workout.plannedWeight)
  const [reps, setReps] = useState<number | null>(
    workout.draftReps ?? workout.targetReps,
  )
  // Optional effort markers for this set. Not drafted — they are a quick tap at
  // the moment of logging, and reset with the component on the next set/exercise.
  const [warmup, setWarmup] = useState(false)
  const [rir, setRir] = useState<number | null>(null)
  const [rpe, setRpe] = useState<number | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [discardOpen, setDiscardOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const draftTimer = useRef<number | undefined>(undefined)

  // A pending draft write must not be dropped when the set is committed and
  // this component unmounts — cancel it, since finishSet persists the same
  // numbers anyway and the draft row is deleted alongside.
  useEffect(() => () => window.clearTimeout(draftTimer.current), [])

  /** Persists what has been typed, shortly after the user stops typing. */
  const scheduleDraft = useCallback(
    (next: { weight: number | null; reps: number | null }) => {
      window.clearTimeout(draftTimer.current)
      draftTimer.current = window.setTimeout(() => {
        // A failed draft write is not worth interrupting a workout over: the
        // value is still on screen and Finish set will persist it for real.
        void saveDraft(next).catch(() => {})
      }, DRAFT_DEBOUNCE_MS)
    },
    [],
  )

  const changeWeight = useCallback(
    (next: number | null) => {
      setWeight(next)
      scheduleDraft({ weight: next, reps })
    },
    [reps, scheduleDraft],
  )

  const changeReps = useCallback(
    (next: number | null) => {
      setReps(next)
      scheduleDraft({ weight, reps: next })
    },
    [weight, scheduleDraft],
  )

  /** Runs a mutation, replacing the screen with the state the server wrote. */
  const run = useCallback(
    async (action: () => Promise<AnchoredWorkout>) => {
      setBusy(true)
      setError('')
      try {
        replace(await action())
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not save that.')
      } finally {
        setBusy(false)
      }
    },
    [replace],
  )

  async function handleSaveSet() {
    // The server rejects a null weight; stop it here so the user sees why.
    if (weight === null || reps === null) {
      setError('Weight and reps are both required.')
      return
    }
    window.clearTimeout(draftTimer.current)
    setModalOpen(false)
    await run(() => finishSet(weight, reps, { rir, rpe, isWarmup: warmup }))
  }

  /**
   * Sends this exercise one place back and opens the one that takes its place.
   * One tap, no confirmation: the machine is busy and the user is standing in
   * front of it. Nothing is lost — the exercise comes back straight after.
   */
  async function handleDefer() {
    // A draft written after the swap would be filed against the exercise that
    // replaced this one, so drop what has been typed rather than misattribute it.
    window.clearTimeout(draftTimer.current)
    await run(deferExercise)
  }

  async function handleAbandon() {
    setDiscardOpen(false)
    setBusy(true)
    try {
      await abandonWorkout()
      void navigate('/', { replace: true })
    } catch (err) {
      setBusy(false)
      setError(err instanceof Error ? err.message : 'Could not discard.')
    }
  }

  if (workout.phase === 'completed') {
    return <WorkoutSummary workout={workout} />
  }

  const remaining = restRemainingSeconds(anchored)
  const overRest = restOverSeconds(anchored)
  const upNext = nextUp(workout)

  return (
    <main className="app workout">
      <header className="workout-header">
        <p className="label">{workout.dayName}</p>
        <div className="workout-elapsed">
          <p className="label">Total time</p>
          <p className="workout-clock" aria-label="Total training time">
            {formatDuration(elapsedSeconds(anchored))}
          </p>
        </div>
      </header>

      {/* Informational only: these exercises are queued at the end, not dropped. */}
      {workout.deferredCount > 0 && (
        <p className="workout-deferred">Deferred: {workout.deferredCount}</p>
      )}

      {workout.phase === 'rest' ? (
        <section className="workout-rest" aria-label="Rest">
          {/* Once the countdown runs out, the timer keeps going as an over-rest
              tally so a long break does not silently sit at 0:00. */}
          <p className="label">{overRest === null ? 'Rest' : 'Over-rest'}</p>
          {/* Announced politely so a screen reader is not interrupted every second. */}
          <p
            className={`rest-clock${overRest === null ? '' : ' rest-clock-over'}`}
            role="timer"
            aria-live="off"
          >
            {overRest === null
              ? formatDuration(remaining ?? 0)
              : `+${formatDuration(overRest)}`}
          </p>
          <p className="workout-next-up">
            Next: {upNext.exerciseNumber} / {workout.exerciseCount}{' '}
            {upNext.exerciseName} — set {upNext.setNumber} /{' '}
            {workout.setsPerExercise}
          </p>

          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}

          <Button
            type="button"
            className="workout-action"
            disabled={busy}
            onClick={() => void run(startNextSet)}
          >
            Start next set
          </Button>

          {/* This rest ends an exercise, so the next machine is the one being
              walked to — and the one that can turn out to be busy. */}
          {showMachineBusyButtonDuringRest(workout) && (
            <Button
              type="button"
              className="workout-secondary"
              disabled={busy}
              onClick={() => void handleDefer()}
            >
              Machine busy — do this later
            </Button>
          )}
        </section>
      ) : (
        <section className="workout-set" aria-label="Current set">
          <p className="workout-progress">
            Exercise {workout.exerciseIndex + 1} / {workout.exerciseCount}
          </p>
          <h1 className="workout-exercise">{workout.exerciseName}</h1>

          {/* How to do the movement, folded away until asked for — it belongs to
              the exercise, not to logging a set, so it never crowds the numbers.
              Legacy exercises carry no library id and so show nothing here. */}
          <ExerciseInfo exerciseLibraryId={workout.exerciseLibraryId} />

          <div className="workout-stats">
            <div className="workout-stat">
              <p className="label">Set</p>
              <p className="workout-stat-value">
                {workout.setNumber} / {workout.setsPerExercise}
              </p>
            </div>
            <div className="workout-stat">
              <p className="label">Target reps</p>
              <p className="workout-stat-value">{workout.targetReps}</p>
            </div>
          </div>

          {/* Collapsed by default: it answers "what weight today?" in one tap,
              and costs no vertical space until it is asked. */}
          <PreviousPerformance
            exerciseName={workout.exerciseName}
            exerciseLibraryId={workout.exerciseLibraryId}
            setNumber={workout.setNumber}
            weight={weight}
            reps={reps}
          />

          <Field.Root name="weight" className="field workout-weight">
            <Field.Label>Weight (kg)</Field.Label>
            <NumberField.Root
              value={weight}
              onValueChange={changeWeight}
              min={0}
              max={1000}
              step={0.5}
              disabled={busy}
            >
              <NumberField.Group className="number-field-group">
                <NumberField.Decrement
                  className="number-field-button"
                  aria-label="Decrease weight"
                >
                  −
                </NumberField.Decrement>
                <NumberField.Input inputMode="decimal" />
                <NumberField.Increment
                  className="number-field-button"
                  aria-label="Increase weight"
                >
                  +
                </NumberField.Increment>
              </NumberField.Group>
            </NumberField.Root>
          </Field.Root>

          {/* Optional and out of the way: most sets need none of this, so it
              stays folded until the user wants to log effort or a warmup. */}
          <details className="workout-details">
            <summary className="workout-details-summary">
              Effort (optional)
            </summary>
            <div className="workout-details-body">
              <label className="workout-warmup">
                <input
                  type="checkbox"
                  checked={warmup}
                  disabled={busy}
                  onChange={(event) => setWarmup(event.target.checked)}
                />
                Warm-up set
              </label>

              <Field.Root name="rir" className="field">
                <Field.Label>RIR (reps in reserve)</Field.Label>
                <NumberField.Root
                  value={rir}
                  onValueChange={setRir}
                  min={0}
                  max={50}
                  step={1}
                  disabled={busy}
                >
                  <NumberField.Group className="number-field-group">
                    <NumberField.Decrement
                      className="number-field-button"
                      aria-label="Decrease RIR"
                    >
                      −
                    </NumberField.Decrement>
                    <NumberField.Input inputMode="numeric" />
                    <NumberField.Increment
                      className="number-field-button"
                      aria-label="Increase RIR"
                    >
                      +
                    </NumberField.Increment>
                  </NumberField.Group>
                </NumberField.Root>
              </Field.Root>

              <Field.Root name="rpe" className="field">
                <Field.Label>RPE (0–10)</Field.Label>
                <NumberField.Root
                  value={rpe}
                  onValueChange={setRpe}
                  min={0}
                  max={10}
                  step={0.5}
                  disabled={busy}
                >
                  <NumberField.Group className="number-field-group">
                    <NumberField.Decrement
                      className="number-field-button"
                      aria-label="Decrease RPE"
                    >
                      −
                    </NumberField.Decrement>
                    <NumberField.Input inputMode="decimal" />
                    <NumberField.Increment
                      className="number-field-button"
                      aria-label="Increase RPE"
                    >
                      +
                    </NumberField.Increment>
                  </NumberField.Group>
                </NumberField.Root>
              </Field.Root>
            </div>
          </details>

          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}

          <Button
            type="button"
            className="workout-action"
            disabled={busy}
            onClick={() => setModalOpen(true)}
          >
            Finish set
          </Button>

          {/* While this exercise has no sets on it, wherever it sits in the queue. */}
          {showMachineBusyButton(workout) && (
            <Button
              type="button"
              className="workout-secondary"
              disabled={busy}
              onClick={() => void handleDefer()}
            >
              Machine busy — do this later
            </Button>
          )}
        </section>
      )}

      <FinishSetDialog
        open={modalOpen}
        onOpenChange={setModalOpen}
        weight={weight}
        reps={reps}
        onWeightChange={changeWeight}
        onRepsChange={changeReps}
        onSave={handleSaveSet}
        busy={busy}
      />

      <Button
        type="button"
        className="workout-discard"
        disabled={busy}
        onClick={() => setDiscardOpen(true)}
      >
        Discard workout
      </Button>

      <DiscardWorkoutDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        onConfirm={() => void handleAbandon()}
        busy={busy}
      />
    </main>
  )
}

/**
 * The collapsible "Technique" panel for the current exercise. Collapsed by
 * default and rendered only for library exercises — a legacy-plan exercise has
 * no row to read details from, so it shows nothing and the screen is unchanged.
 */
function ExerciseInfo({
  exerciseLibraryId,
}: {
  exerciseLibraryId: number | null
}) {
  if (exerciseLibraryId === null) return null
  return <ExerciseInfoPanel exerciseLibraryId={exerciseLibraryId} />
}

/**
 * Fetches the exercise's details and, if there are any, offers them behind a
 * compact trigger. An exercise the library knows nothing extra about contributes
 * no trigger at all — an empty panel is worse than no panel.
 */
function ExerciseInfoPanel({
  exerciseLibraryId,
}: {
  exerciseLibraryId: number
}) {
  const state = useExerciseDetail(exerciseLibraryId)
  const exercise = state.status === 'ready' ? state.data : null

  // Resolved but with nothing to show, or gone from the library: no trigger.
  if (state.status === 'not-found') return null
  if (exercise && !hasExerciseInfo(exercise)) return null

  return (
    <Collapsible.Root className="exercise-info">
      <Collapsible.Trigger className="exercise-info-trigger">
        {/* Drawn in CSS and rotated when open — hidden from screen readers,
            which already hear the trigger's expanded state. */}
        <span className="exercise-info-chevron" aria-hidden="true" />
        <span className="exercise-info-title">Technique</span>
      </Collapsible.Trigger>

      <Collapsible.Panel className="exercise-info-panel">
        {state.status === 'loading' && <p className="history-note">Loading…</p>}
        {state.status === 'error' && (
          <p className="error" role="alert">
            {state.message}
          </p>
        )}
        {exercise && <ExerciseInfoDetail exercise={exercise} />}
      </Collapsible.Panel>
    </Collapsible.Root>
  )
}

/**
 * What this exercise was last lifted at, inline and collapsed. Expanding it
 * navigates nowhere and opens nothing — the workout screen stays exactly where
 * it was, one tap away from the numbers that decide today's weight.
 *
 * Only this exercise's history is fetched, and only when the exercise changes.
 * The header carries the one fact worth reading without expanding — how long
 * ago the last session was — plus the green marker when today already beats it.
 */
function PreviousPerformance({
  exerciseName,
  exerciseLibraryId,
  setNumber,
  weight,
  reps,
}: {
  exerciseName: string
  exerciseLibraryId: number | null
  setNumber: number
  weight: number | null
  reps: number | null
}) {
  const state = useExerciseHistory(exerciseName, exerciseLibraryId)
  const history = state.status === 'ready' ? state.data : null
  const improvement = improvementOverLast(
    history?.last ?? null,
    setNumber,
    weight,
    reps,
  )

  return (
    <Collapsible.Root className="history">
      <Collapsible.Trigger className="history-trigger">
        {/* Drawn in CSS, rotated when open: an icon, so it is hidden from
            screen readers — the trigger already announces its expanded state. */}
        <span className="history-chevron" aria-hidden="true" />
        <span className="history-title">Previous Performance</span>
        <span className="history-note">{headerNote(state)}</span>
      </Collapsible.Trigger>

      {improvement !== 'none' && (
        <p className="history-improvement">{IMPROVEMENT_LABEL[improvement]}</p>
      )}

      <Collapsible.Panel className="history-panel">
        {state.status === 'loading' && <p className="history-note">Loading…</p>}
        {state.status === 'error' && (
          <p className="error" role="alert">
            {state.message}
          </p>
        )}
        {history && !history.last && (
          <p className="history-note">
            No completed workouts yet for this exercise.
          </p>
        )}
        {history?.last && <HistoryDetail history={history} last={history.last} />}
      </Collapsible.Panel>
    </Collapsible.Root>
  )
}

/** The header line, readable without expanding: when this lift was last done. */
function headerNote(state: ReturnType<typeof useExerciseHistory>): string {
  if (state.status === 'loading') return 'Loading…'
  if (state.status === 'error') return 'Unavailable'
  if (state.status === 'not-found' || !state.data.last) return 'No history'
  return formatRelativeDay(state.data.last.completedAt)
}

/**
 * Last workout in full, then the two summaries. Ordered by how much of the
 * decision each one carries: the last session's sets are what today's weight is
 * chosen against, and everything below it is context.
 */
function HistoryDetail({
  history,
  last,
}: {
  history: ExerciseHistory
  last: NonNullable<ExerciseHistory['last']>
}) {
  return (
    <>
      <section className="history-section">
        <p className="history-heading">
          Last workout
          <span className="history-note">
            {formatRelativeDay(last.completedAt)}
          </span>
        </p>
        <dl className="history-sets">
          {last.sets.map((set) => (
            <div key={set.setNumber} className="history-row">
              <dt>Set {set.setNumber}</dt>
              <dd>
                {formatWeight(set.weight)} kg × {set.reps}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {history.best && (
        <section className="history-section">
          <p className="history-heading">Best weight</p>
          <p className="history-best">
            {formatWeight(history.best.weight)} kg × {history.best.reps}
          </p>
        </section>
      )}

      {/* Weights only, one row per workout: enough to read a trend at a glance. */}
      {history.recent.length > 1 && (
        <section className="history-section">
          <p className="history-heading">Recent history</p>
          <dl className="history-sets">
            {history.recent.map((workout) => (
              <div key={workout.workoutId} className="history-row">
                <dt>{formatShortDate(workout.completedAt)}</dt>
                <dd>{formatSetWeights(workout.sets)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </>
  )
}

/**
 * Weight, reps, Save. Escape or a tap outside dismisses it; `Dialog.Close` is
 * the same escape for touch screen readers, which cannot press Escape.
 */
function FinishSetDialog({
  open,
  onOpenChange,
  weight,
  reps,
  onWeightChange,
  onRepsChange,
  onSave,
  busy,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  weight: number | null
  reps: number | null
  onWeightChange: (value: number | null) => void
  onRepsChange: (value: number | null) => void
  onSave: () => void
  busy: boolean
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Popup className="dialog-popup" aria-label="Finish set">
          <Form className="settings-form" onFormSubmit={onSave}>
            <Field.Root name="weight" className="field">
              <Field.Label>Weight (kg)</Field.Label>
              <NumberField.Root
                value={weight}
                onValueChange={onWeightChange}
                min={0}
                max={1000}
                step={0.5}
                required
              >
                <NumberField.Group className="number-field-group">
                  <NumberField.Decrement
                    className="number-field-button"
                    aria-label="Decrease weight"
                  >
                    −
                  </NumberField.Decrement>
                  <NumberField.Input autoFocus inputMode="decimal" />
                  <NumberField.Increment
                    className="number-field-button"
                    aria-label="Increase weight"
                  >
                    +
                  </NumberField.Increment>
                </NumberField.Group>
              </NumberField.Root>
              <Field.Error className="field-error" match="valueMissing">
                Weight is required.
              </Field.Error>
            </Field.Root>

            <Field.Root name="reps" className="field">
              <Field.Label>Reps</Field.Label>
              <NumberField.Root
                value={reps}
                onValueChange={onRepsChange}
                min={1}
                max={100}
                step={1}
                required
              >
                <NumberField.Group className="number-field-group">
                  <NumberField.Decrement
                    className="number-field-button"
                    aria-label="Decrease reps"
                  >
                    −
                  </NumberField.Decrement>
                  <NumberField.Input />
                  <NumberField.Increment
                    className="number-field-button"
                    aria-label="Increase reps"
                  >
                    +
                  </NumberField.Increment>
                </NumberField.Group>
              </NumberField.Root>
              <Field.Error className="field-error" match="valueMissing">
                Reps is required.
              </Field.Error>
            </Field.Root>

            <Button type="submit" disabled={busy}>
              Save
            </Button>
            <Dialog.Close className="dialog-close">Cancel</Dialog.Close>
          </Form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/**
 * Guards the destructive "Discard workout" action. Discarding throws away every
 * set recorded so far, so it must never fire from a single stray tap — the user
 * confirms here first. Escape or a tap outside cancels; `Dialog.Close` is the
 * same escape for touch screen readers, which cannot press Escape.
 */
function DiscardWorkoutDialog({
  open,
  onOpenChange,
  onConfirm,
  busy,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  busy: boolean
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Popup className="dialog-popup" aria-label="Discard workout">
          <p>Discard this workout? Every set recorded so far will be lost.</p>
          <Button
            type="button"
            className="workout-discard"
            disabled={busy}
            onClick={onConfirm}
          >
            Discard workout
          </Button>
          <Dialog.Close className="dialog-close">Cancel</Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/**
 * The one screen the workout ends on. Totals come from the database, and the
 * last thing it asks for is today's body weight — the final step of the workout
 * rather than a separate errand. Saving writes it to the workout that owns it
 * and closes the workout; skipping closes it having recorded nothing.
 *
 * Reopening a finished workout lands back here with the saved weight in the
 * input, so a number typed wrongly is corrected where it was entered.
 */
function WorkoutSummary({ workout }: { workout: WorkoutState }) {
  const navigate = useNavigate()
  const [bodyWeight, setBodyWeight] = useState<number | null>(
    workout.bodyWeightKg,
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  /**
   * Writes the weight, then leaves. The server re-checks the bounds, so what is
   * checked here is only what earns the user a reason rather than a rejection.
   */
  async function handleSave() {
    if (bodyWeight === null) {
      setError('Enter your body weight, or skip this step.')
      return
    }
    if (bodyWeight < BODY_WEIGHT_MIN || bodyWeight > BODY_WEIGHT_MAX) {
      setError(
        `Body weight must be between ${BODY_WEIGHT_MIN} and ${BODY_WEIGHT_MAX} kg.`,
      )
      return
    }

    setBusy(true)
    setError('')
    try {
      await saveBodyWeight(workout.id, bodyWeight)
      void navigate('/', { replace: true })
    } catch (err) {
      setBusy(false)
      setError(
        err instanceof Error ? err.message : 'Could not save your body weight.',
      )
    }
  }

  return (
    <main className="app">
      <h1>Workout Complete 🎉</h1>
      <p className="subtitle">{workout.dayName}</p>

      <dl className="workout-summary">
        <div className="card workout-summary-item">
          <dt className="label">Total duration</dt>
          <dd className="message">{formatDuration(workout.elapsedSeconds)}</dd>
        </div>
        <div className="card workout-summary-item">
          <dt className="label">Exercises completed</dt>
          <dd className="message">
            {workout.exercisesCompleted} / {workout.exerciseCount}
          </dd>
        </div>
        <div className="card workout-summary-item">
          <dt className="label">Sets completed</dt>
          <dd className="message">{workout.setsCompleted}</dd>
        </div>
        {/* Part of this workout's record, so it is read back with the rest of it. */}
        {workout.bodyWeightKg !== null && (
          <div className="card workout-summary-item">
            <dt className="label">Body weight</dt>
            <dd className="message">
              {formatWeight(workout.bodyWeightKg)} kg
            </dd>
          </div>
        )}
      </dl>

      {/* The AI coach's read on this session vs previous sessions of the same
          training day — text plus the numbers it was drawn from. */}
      <WorkoutAiSummaryPanel workoutId={workout.id} />

      <Form className="settings-form" onFormSubmit={handleSave}>
        <Field.Root name="bodyWeight" className="field">
          <Field.Label>What is your current body weight? (kg)</Field.Label>
          <NumberField.Root
            value={bodyWeight}
            onValueChange={setBodyWeight}
            min={BODY_WEIGHT_MIN}
            max={BODY_WEIGHT_MAX}
            step={0.1}
            disabled={busy}
          >
            <NumberField.Group className="number-field-group">
              <NumberField.Decrement
                className="number-field-button"
                aria-label="Decrease body weight"
              >
                −
              </NumberField.Decrement>
              <NumberField.Input />
              <NumberField.Increment
                className="number-field-button"
                aria-label="Increase body weight"
              >
                +
              </NumberField.Increment>
            </NumberField.Group>
          </NumberField.Root>
        </Field.Root>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <Button type="submit" className="workout-action" disabled={busy}>
          Save &amp; Finish
        </Button>
      </Form>

      {/* No scale to hand: finish the workout and record no weight for it.
          Navigation, so a real link — Base UI's Button would impose button semantics. */}
      <Link className="nav-button" to="/">
        {workout.bodyWeightKg === null ? 'Skip' : 'Done'}
      </Link>
    </main>
  )
}

/** A whole-number figure with thousands separators — volumes get large. */
function formatVolume(kg: number): string {
  return Math.round(kg).toLocaleString()
}

/**
 * The AI post-workout summary and the numbers behind it. Fetched lazily when the
 * summary screen renders; the server generates it in the background the moment
 * the workout completes, so this usually returns the cached copy at once.
 */
function WorkoutAiSummaryPanel({ workoutId }: { workoutId: number }) {
  const { state, regenerate } = useWorkoutSummary(workoutId)
  const [retrying, setRetrying] = useState(false)

  async function handleRetry() {
    setRetrying(true)
    try {
      await regenerate()
    } finally {
      setRetrying(false)
    }
  }

  return (
    <section className="ai-summary" aria-label="AI workout summary">
      <p className="ai-summary-kicker">AI Summary</p>

      {state.status === 'loading' && (
        <p className="history-note">Generating your summary…</p>
      )}

      {state.status === 'error' && (
        <>
          <p className="error" role="alert">
            {state.message}
          </p>
          <Button
            type="button"
            className="workout-secondary"
            disabled={retrying}
            onClick={() => void handleRetry()}
          >
            {retrying ? 'Retrying…' : 'Try again'}
          </Button>
        </>
      )}

      {state.status === 'ready' && (
        <AiSummaryBody
          summary={state.data}
          retrying={retrying}
          onRegenerate={() => void handleRetry()}
        />
      )}
    </section>
  )
}

/** The rendered summary: badge, narrative, and the visual comparison data. */
function AiSummaryBody({
  summary,
  retrying,
  onRegenerate,
}: {
  summary: WorkoutAiSummary
  retrying: boolean
  onRegenerate: () => void
}) {
  const { metrics } = summary

  return (
    <>
      <span className={`ai-badge ai-badge-${summary.assessment}`}>
        {ASSESSMENT_LABEL[summary.assessment]}
      </span>

      <h2 className="ai-summary-headline">{summary.headline}</h2>

      {/* The model reply may use short "- " bullet lines; render them as such. */}
      <SummaryText text={summary.summary} />

      {summary.status === 'unavailable' && (
        <p className="ai-summary-note">
          The AI coach note is unavailable right now — the numbers below are
          still your real results.
        </p>
      )}

      {/* Volume for the current session vs the previous same-day one. */}
      <VolumeCompare summary={summary} />

      {/* The ~1-month trend across the last few same-day sessions. */}
      {metrics.volumeTrend.length > 1 && (
        <VolumeTrend summary={summary} />
      )}

      {/* Per-exercise volume change vs the previous same-day session. */}
      {metrics.exercises.length > 0 && (
        <ExerciseTable exercises={metrics.exercises} />
      )}

      {summary.improvements.length > 0 && (
        <SummaryChips
          heading="Improved"
          items={summary.improvements}
          tone="up"
        />
      )}
      {summary.declines.length > 0 && (
        <SummaryChips
          heading="Watch"
          items={summary.declines}
          tone="down"
        />
      )}

      {summary.exerciseNotes.length > 0 && (
        <ul className="ai-summary-notes">
          {summary.exerciseNotes.map((note, index) => (
            <li key={index}>{note}</li>
          ))}
        </ul>
      )}

      {summary.trendNote && (
        <p className="ai-summary-trend-note">{summary.trendNote}</p>
      )}
      {summary.effortNote && (
        <p className="ai-summary-effort-note">{summary.effortNote}</p>
      )}

      {summary.recommendation && (
        <p className="ai-recommendation">
          <span className="ai-recommendation-label">Next time</span>
          {summary.recommendation}
        </p>
      )}

      <button
        type="button"
        className="ai-summary-regenerate"
        disabled={retrying}
        onClick={onRegenerate}
      >
        {retrying ? 'Regenerating…' : 'Regenerate'}
      </button>
    </>
  )
}

/** Renders the model's text, turning "- " lines into a bullet list. */
function SummaryText({ text }: { text: string }) {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  const bullets = lines.every((line) => line.startsWith('- '))
  if (bullets && lines.length > 1) {
    return (
      <ul className="ai-summary-text-list">
        {lines.map((line, index) => (
          <li key={index}>{line.replace(/^-\s+/, '')}</li>
        ))}
      </ul>
    )
  }
  return (
    <>
      {lines.map((line, index) => (
        <p key={index} className="ai-summary-text">
          {line.replace(/^-\s+/, '')}
        </p>
      ))}
    </>
  )
}

/** Current vs previous total volume, with the change between them. */
function VolumeCompare({ summary }: { summary: WorkoutAiSummary }) {
  const { current, previous } = summary.metrics
  const delta = previous ? Math.round(current.volume - previous.volume) : null
  const pct =
    previous && previous.volume > 0
      ? Math.round(((current.volume - previous.volume) / previous.volume) * 100)
      : null

  return (
    <div className="ai-volume">
      <div className="ai-volume-cell">
        <p className="label">This session</p>
        <p className="ai-volume-value">{formatVolume(current.volume)} kg</p>
      </div>
      <div className="ai-volume-cell">
        <p className="label">Previous</p>
        <p className="ai-volume-value">
          {previous ? `${formatVolume(previous.volume)} kg` : '—'}
        </p>
      </div>
      <div className="ai-volume-cell">
        <p className="label">Change</p>
        <p className={`ai-volume-value ${deltaClass(delta)}`}>
          {delta === null
            ? '—'
            : `${delta >= 0 ? '+' : ''}${formatVolume(delta)} kg${
                pct === null ? '' : ` (${pct >= 0 ? '+' : ''}${pct}%)`
              }`}
        </p>
      </div>
    </div>
  )
}

/** A small bar chart of total volume across the last few same-day sessions. */
function VolumeTrend({ summary }: { summary: WorkoutAiSummary }) {
  const points = summary.metrics.volumeTrend
  const max = Math.max(...points.map((point) => point.volume), 1)

  return (
    <div className="ai-trend">
      <p className="label">Volume trend (same day)</p>
      <div className="ai-trend-bars">
        {points.map((point, index) => {
          const isCurrent = index === points.length - 1
          const height = Math.max(4, Math.round((point.volume / max) * 100))
          return (
            <div className="ai-trend-bar" key={`${point.date}-${index}`}>
              <span className="ai-trend-amount">
                {formatVolume(point.volume)}
              </span>
              <span
                className={`ai-trend-fill${isCurrent ? ' ai-trend-fill-current' : ''}`}
                style={{ height: `${height}%` }}
              />
              <span className="ai-trend-date">
                {formatShortDate(point.date)}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Per-exercise volume this session vs the previous same-day one. */
function ExerciseTable({ exercises }: { exercises: ExerciseMetric[] }) {
  return (
    <div className="ai-exercises">
      <p className="label">Per-exercise volume</p>
      <table className="ai-exercise-table">
        <thead>
          <tr>
            <th>Exercise</th>
            <th>This</th>
            <th>Prev</th>
            <th>Δ</th>
          </tr>
        </thead>
        <tbody>
          {exercises.map((exercise) => (
            <tr key={exercise.name}>
              <td className="ai-exercise-name">{exercise.name}</td>
              <td>{formatVolume(exercise.currentVolume)}</td>
              <td>
                {exercise.previousVolume === null
                  ? '—'
                  : formatVolume(exercise.previousVolume)}
              </td>
              <td className={deltaClass(exercise.volumeDelta)}>
                {exercise.volumeDelta === null
                  ? 'new'
                  : `${exercise.volumeDelta >= 0 ? '+' : ''}${formatVolume(
                      exercise.volumeDelta,
                    )}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** A titled row of small chips — improved or declining exercises. */
function SummaryChips({
  heading,
  items,
  tone,
}: {
  heading: string
  items: string[]
  tone: 'up' | 'down'
}) {
  return (
    <div className="ai-chips">
      <p className="label">{heading}</p>
      <div className="ai-chip-row">
        {items.map((item, index) => (
          <span key={index} className={`ai-chip ai-chip-${tone}`}>
            {item}
          </span>
        ))}
      </div>
    </div>
  )
}

/** Green for a gain, red for a drop, muted for flat or unknown. */
function deltaClass(delta: number | null): string {
  if (delta === null || delta === 0) return 'ai-delta-flat'
  return delta > 0 ? 'ai-delta-up' : 'ai-delta-down'
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@base-ui/react/button'
import { Collapsible } from '@base-ui/react/collapsible'
import { Dialog } from '@base-ui/react/dialog'
import { Field } from '@base-ui/react/field'
import { Form } from '@base-ui/react/form'
import { NumberField } from '@base-ui/react/number-field'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
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
  restRemainingSeconds,
  saveBodyWeight,
  saveDraft,
  showMachineBusyButton,
  showMachineBusyButtonDuringRest,
  startNextSet,
  useExerciseHistory,
  useTicker,
  useWorkout,
  type AnchoredWorkout,
  type ExerciseHistory,
  type Improvement,
  type WorkoutState,
} from '../workout'

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
  const [modalOpen, setModalOpen] = useState(false)
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
    await run(() => finishSet(weight, reps))
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
          <p className="label">Rest</p>
          {/* Announced politely so a screen reader is not interrupted every second. */}
          <p className="rest-clock" role="timer" aria-live="off">
            {formatDuration(remaining ?? 0)}
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
        onClick={() => void handleAbandon()}
      >
        Discard workout
      </Button>
    </main>
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
  setNumber,
  weight,
  reps,
}: {
  exerciseName: string
  setNumber: number
  weight: number | null
  reps: number | null
}) {
  const state = useExerciseHistory(exerciseName)
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

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@base-ui/react/button'
import { Dialog } from '@base-ui/react/dialog'
import { Field } from '@base-ui/react/field'
import { Form } from '@base-ui/react/form'
import { NumberField } from '@base-ui/react/number-field'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import {
  abandonWorkout,
  elapsedSeconds,
  finishSet,
  formatDuration,
  nextUp,
  reorderExercise,
  restRemainingSeconds,
  saveDraft,
  startNextSet,
  useTicker,
  useWorkout,
  type AnchoredWorkout,
  type WorkoutExercise,
} from '../workout'

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
  const [reorderOpen, setReorderOpen] = useState(false)
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

  /** Swaps a later exercise into the current slot. */
  async function handleReorder(position: number) {
    // A draft written after the swap would be filed against the exercise that
    // replaced this one, so drop what has been typed rather than misattribute it.
    window.clearTimeout(draftTimer.current)
    setReorderOpen(false)
    await run(() => reorderExercise(position))
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
    return <WorkoutSummary anchored={anchored} />
  }

  const remaining = restRemainingSeconds(anchored)
  const upNext = nextUp(workout)

  // The exercises still ahead. Offered only on the first set, because once a set
  // is logged against this slot the server will not let it be swapped.
  const upcoming = workout.exercises.slice(workout.exerciseIndex + 1)
  const canReorder = workout.setNumber === 1 && upcoming.length > 0

  return (
    <main className="app workout">
      <header className="workout-header">
        <p className="label">{workout.dayName}</p>
        <p className="workout-clock" aria-label="Workout duration">
          {formatDuration(elapsedSeconds(anchored))}
        </p>
      </header>

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

          <Field.Root name="weight" className="field workout-weight">
            <Field.Label>Weight (kg)</Field.Label>
            <NumberField.Root
              value={weight}
              onValueChange={changeWeight}
              min={0}
              max={1000}
              step={2.5}
              disabled={busy}
            >
              <NumberField.Group className="number-field-group">
                <NumberField.Decrement
                  className="number-field-button"
                  aria-label="Decrease weight"
                >
                  −
                </NumberField.Decrement>
                <NumberField.Input />
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

          {canReorder && (
            <Button
              type="button"
              className="workout-secondary"
              disabled={busy}
              onClick={() => setReorderOpen(true)}
            >
              Machine taken? Do another exercise first
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

      <ReorderDialog
        open={reorderOpen}
        onOpenChange={setReorderOpen}
        upcoming={upcoming}
        onPick={(position) => void handleReorder(position)}
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
                step={2.5}
                required
              >
                <NumberField.Group className="number-field-group">
                  <NumberField.Decrement
                    className="number-field-button"
                    aria-label="Decrease weight"
                  >
                    −
                  </NumberField.Decrement>
                  <NumberField.Input autoFocus />
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
 * The exercises still to come. Picking one moves it to now; the exercises it
 * jumps over keep their order and follow it, so nothing is dropped.
 */
function ReorderDialog({
  open,
  onOpenChange,
  upcoming,
  onPick,
  busy,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  upcoming: WorkoutExercise[]
  onPick: (position: number) => void
  busy: boolean
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Popup
          className="dialog-popup"
          aria-label="Do another exercise first"
        >
          <p className="label">Do this exercise now</p>
          <ul className="reorder-list">
            {upcoming.map((exercise) => (
              <li key={exercise.position}>
                <Button
                  type="button"
                  className="reorder-option"
                  disabled={busy}
                  onClick={() => onPick(exercise.position)}
                >
                  {exercise.name}
                </Button>
              </li>
            ))}
          </ul>
          <Dialog.Close className="dialog-close">Cancel</Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** The one screen the workout ends on. Totals come from the database. */
function WorkoutSummary({ anchored }: { anchored: AnchoredWorkout }) {
  const { workout } = anchored

  return (
    <main className="app">
      <h1>Workout completed</h1>
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
      </dl>

      {/* Navigation, so a real link — Base UI's Button would impose button semantics. */}
      <Link className="nav-button" to="/">
        Done
      </Link>
    </main>
  )
}

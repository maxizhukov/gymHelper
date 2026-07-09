import { useCallback, useEffect, useState } from 'react'
import { errorMessage, isAbort, type Loadable } from './api'

/**
 * Data access for workouts. The workout lives in the database and every action
 * is written there before the response comes back — this module holds no copy
 * of it. What the screen renders is always the state the server last returned,
 * never a value the client computed and hoped was right.
 *
 * The session cookie is sent with every request; the server derives the acting
 * user from it, so no user or workout id is ever sent on a mutation.
 */

/** Where the workout screen is: logging a set, resting, or finished. */
export type WorkoutPhase = 'set' | 'rest' | 'completed'

export type WorkoutExercise = {
  position: number
  name: string
}

export type WorkoutState = {
  id: number
  daySlug: string
  dayName: string
  focus: string
  phase: WorkoutPhase

  startedAt: string
  completedAt: string | null
  /** Wall-clock seconds since the workout started, as of the response. */
  elapsedSeconds: number

  exercises: WorkoutExercise[]
  exerciseIndex: number
  exerciseCount: number
  exerciseName: string

  setNumber: number
  setsPerExercise: number
  targetReps: number

  plannedWeight: number | null
  draftReps: number | null

  restSeconds: number
  /** Seconds left on the rest timer as of the response, or null when not resting. */
  restRemainingSeconds: number | null

  setsCompleted: number
  exercisesCompleted: number
}

/**
 * A server state together with the moment it arrived. The screen ticks its
 * timers forward from `receivedAt` rather than tracking elapsed time itself, so
 * a reload or a resume always re-anchors to the database's clock.
 */
export type AnchoredWorkout = {
  workout: WorkoutState
  receivedAt: number
}

const LOAD_ERROR = 'Could not load the workout. Please try again.'
const ACTION_ERROR = 'Could not save that. Please try again.'

/** Anchors a freshly-received state to the local clock. */
function anchor(workout: WorkoutState): AnchoredWorkout {
  return { workout, receivedAt: Date.now() }
}

/** Posts to a workout endpoint and returns the state the server wrote. */
async function post(
  path: string,
  body?: unknown,
): Promise<AnchoredWorkout> {
  const res = await fetch(`/api/workout/${path}`, {
    method: 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(await errorMessage(res, ACTION_ERROR))
  }
  const data = (await res.json()) as { workout: WorkoutState }
  return anchor(data.workout)
}

/** Starts a workout for a training day. Rejects if one is already in progress. */
export function startWorkout(slug: string): Promise<AnchoredWorkout> {
  return post('start', { slug })
}

/**
 * Persists weight/reps as they are typed, before the set is committed. The
 * response is not applied to the screen — the inputs already show these values,
 * and this write exists so a crash mid-entry loses nothing.
 */
export async function saveDraft(draft: {
  weight: number | null
  reps: number | null
}): Promise<void> {
  await post('draft', draft)
}

/** Logs the current set. The server starts rest, or completes the workout. */
export function finishSet(weight: number, reps: number): Promise<AnchoredWorkout> {
  return post('sets', { weight, reps })
}

/** Ends rest and advances to the next set or exercise. */
export function startNextSet(): Promise<AnchoredWorkout> {
  return post('next')
}

/** Abandons the unfinished workout so a new one can be started. */
export async function abandonWorkout(): Promise<void> {
  const res = await fetch('/api/workout/abandon', {
    method: 'POST',
    credentials: 'include',
  })
  if (!res.ok) {
    throw new Error(await errorMessage(res, ACTION_ERROR))
  }
}

/**
 * The user's unfinished workout, if any. `null` data means there is nothing to
 * resume — not an error. Used by the home and training-day screens to decide
 * between offering "Start workout" and "Resume workout".
 */
export function useActiveWorkout(): Loadable<WorkoutState | null> {
  const [state, setState] = useState<Loadable<WorkoutState | null>>({
    status: 'loading',
  })

  useEffect(() => {
    const controller = new AbortController()

    void (async () => {
      try {
        const res = await fetch('/api/workout/active', {
          credentials: 'include',
          signal: controller.signal,
        })
        if (!res.ok) {
          setState({
            status: 'error',
            message: await errorMessage(res, LOAD_ERROR),
          })
          return
        }
        const data = (await res.json()) as { workout: WorkoutState | null }
        setState({ status: 'ready', data: data.workout })
      } catch (err) {
        if (isAbort(err)) return
        setState({ status: 'error', message: LOAD_ERROR })
      }
    })()

    return () => controller.abort()
  }, [])

  return state
}

/**
 * One workout by id, reconstructed from the database on mount — this is what
 * makes a reload mid-workout land exactly where the user left off. `replace`
 * hands the screen the state a mutation returned, so the two never disagree.
 */
export function useWorkout(id: string | undefined): {
  state: Loadable<AnchoredWorkout>
  replace: (next: AnchoredWorkout) => void
} {
  const [state, setState] = useState<Loadable<AnchoredWorkout>>({
    status: 'loading',
  })

  const replace = useCallback((next: AnchoredWorkout) => {
    setState({ status: 'ready', data: next })
  }, [])

  useEffect(() => {
    if (!id) {
      setState({ status: 'not-found' })
      return
    }

    const controller = new AbortController()
    setState({ status: 'loading' })

    void (async () => {
      try {
        const res = await fetch(`/api/workout/${encodeURIComponent(id)}`, {
          credentials: 'include',
          signal: controller.signal,
        })
        if (res.status === 404 || res.status === 400) {
          setState({ status: 'not-found' })
          return
        }
        if (!res.ok) {
          setState({
            status: 'error',
            message: await errorMessage(res, LOAD_ERROR),
          })
          return
        }
        const data = (await res.json()) as { workout: WorkoutState }
        setState({ status: 'ready', data: anchor(data.workout) })
      } catch (err) {
        if (isAbort(err)) return
        setState({ status: 'error', message: LOAD_ERROR })
      }
    })()

    return () => controller.abort()
  }, [id])

  return { state, replace }
}

/**
 * Re-renders roughly every 250ms so the timers advance smoothly. Returns a
 * changing value only to force the render; nothing derives meaning from it.
 * Idle when `running` is false, so a finished workout costs nothing.
 */
export function useTicker(running: boolean): void {
  const [, setTick] = useState(0)

  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setTick((t) => t + 1), 250)
    return () => clearInterval(id)
  }, [running])
}

/** Whole seconds since a state arrived. Never negative, even if the clock jumps. */
function secondsSince(receivedAt: number): number {
  return Math.max(0, Math.floor((Date.now() - receivedAt) / 1000))
}

/**
 * The global workout timer: the server's elapsed count, ticked forward locally
 * between responses. Frozen once the workout is complete.
 */
export function elapsedSeconds({ workout, receivedAt }: AnchoredWorkout): number {
  if (workout.phase === 'completed') return workout.elapsedSeconds
  return workout.elapsedSeconds + secondsSince(receivedAt)
}

/**
 * Seconds left on the rest timer, or null when not resting. Clamped at zero:
 * a finished countdown shows 00:00 and waits — it never advances the workout.
 */
export function restRemainingSeconds({
  workout,
  receivedAt,
}: AnchoredWorkout): number | null {
  if (workout.restRemainingSeconds === null) return null
  return Math.max(0, workout.restRemainingSeconds - secondsSince(receivedAt))
}

/** `M:SS`, widening to `H:MM:SS` once a workout passes the hour. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60

  const pad = (n: number) => String(n).padStart(2, '0')
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(secs)}`
  return `${minutes}:${pad(secs)}`
}

/**
 * Where "Start next set" will land: the next set of this exercise, or the first
 * set of the next one. Derived from the state the server sent, and shown during
 * rest so the next lift is never a surprise.
 */
export function nextUp(workout: WorkoutState): {
  exerciseName: string
  exerciseNumber: number
  setNumber: number
} {
  const movesOn = workout.setNumber >= workout.setsPerExercise
  const index = movesOn ? workout.exerciseIndex + 1 : workout.exerciseIndex
  return {
    exerciseName: workout.exercises[index]?.name ?? workout.exerciseName,
    exerciseNumber: index + 1,
    setNumber: movesOn ? 1 : workout.setNumber + 1,
  }
}

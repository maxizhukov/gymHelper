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
  /** The library movement this exercise is, or null for a legacy-plan one. */
  exerciseLibraryId: number | null
  /** True once the user has pushed this one back at least once. */
  deferred: boolean
  /** Sets logged against this exercise, counted by identity — so it reads zero
   *  again for an exercise that has not been started, wherever it sits now. */
  completedSets: number
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
  /** The library id of the current exercise, or null for a legacy-plan one. */
  exerciseLibraryId: number | null

  /** Deferred exercises still waiting later in the queue. Informational. */
  deferredCount: number

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

  /** What the user weighed at the end of this workout, kg. Null when skipped. */
  bodyWeightKg: number | null
}

/** One logged set of a past workout. */
export type HistorySet = {
  setNumber: number
  weight: number
  reps: number
}

/** One past workout's worth of sets for a single exercise. */
export type HistoryWorkout = {
  workoutId: number
  completedAt: string
  sets: HistorySet[]
}

/** What the Previous Performance panel renders. Aggregated by the server. */
export type ExerciseHistory = {
  exerciseName: string
  /** The most recent completed workout, also `recent[0]` when present. */
  last: HistoryWorkout | null
  /** Up to five completed workouts, newest first. */
  recent: HistoryWorkout[]
  /** The heaviest set ever logged, best reps breaking a tie. */
  best: { weight: number; reps: number } | null
}

/** The overall verdict of a post-workout summary, kept to a small closed set. */
export type WorkoutAssessment = 'better' | 'similar' | 'worse' | 'first'

/** The best set of an exercise, by estimated 1RM. */
export type BestSet = { weight: number; reps: number; e1rm: number }

/** One point on the volume trend: a past (or the current) same-day session. */
export type TrendPoint = {
  date: string
  volume: number
  totalReps: number
  bestE1rm: number
}

/** Per-exercise comparison of the current workout against the previous same day. */
export type ExerciseMetric = {
  name: string
  currentVolume: number
  currentReps: number
  currentBest: BestSet | null
  previousVolume: number | null
  previousBest: BestSet | null
  volumeDelta: number | null
}

/** The deterministic numbers behind the summary — the data the UI charts. */
export type WorkoutSummaryMetrics = {
  isFirstSession: boolean
  current: { volume: number; totalReps: number; bestE1rm: number; date: string }
  previous: {
    volume: number
    totalReps: number
    bestE1rm: number
    date: string
  } | null
  /** Oldest → newest, including the current session as the last point. */
  volumeTrend: TrendPoint[]
  exercises: ExerciseMetric[]
  effort: { hasData: boolean; avgRir: number | null; avgRpe: number | null }
}

/**
 * The AI post-workout summary. `status` is 'ready' when the model produced it
 * and 'unavailable' when the model could not be reached — in which case the
 * metrics are still real (computed server-side) and the text is a friendly
 * fallback the user can retry.
 */
export type WorkoutAiSummary = {
  status: 'ready' | 'unavailable'
  generatedAt: string | null
  assessment: WorkoutAssessment
  headline: string
  summary: string
  improvements: string[]
  declines: string[]
  exerciseNotes: string[]
  trendNote: string
  effortNote: string | null
  recommendation: string
  metrics: WorkoutSummaryMetrics
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
const HISTORY_ERROR = 'Could not load previous performance.'

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
 * Starts a workout from a Training Builder day. Rejects if one is already in
 * progress, or if the day has no active exercises.
 */
export function startWorkoutFromTemplateDay(
  dayId: number,
): Promise<AnchoredWorkout> {
  return post('start-template-day', { dayId })
}

/** Optional effort markers a set may carry. All optional; warmup defaults off. */
export type SetDetails = {
  rir?: number | null
  rpe?: number | null
  isWarmup?: boolean
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

/**
 * Logs the current set. The server starts rest, or completes the workout.
 * Optional RIR / RPE / warmup markers ride along when the user set them.
 */
export function finishSet(
  weight: number,
  reps: number,
  details: SetDetails = {},
): Promise<AnchoredWorkout> {
  return post('sets', {
    weight,
    reps,
    rir: details.rir ?? null,
    rpe: details.rpe ?? null,
    isWarmup: details.isWarmup ?? false,
  })
}

/** Ends rest and advances to the next set or exercise. */
export function startNextSet(): Promise<AnchoredWorkout> {
  return post('next')
}

/**
 * Whether to offer "Machine busy — do this later". One rule, and only one: the
 * current exercise has no sets on it yet. It therefore comes back at the start
 * of every exercise, including one returning from an earlier defer, and goes
 * away the moment that exercise's first set lands.
 *
 * Decided here rather than by the server: the screen already holds the current
 * exercise and its set count, so a server flag would only be a second opinion
 * about data the client already has. The server still validates the defer
 * itself — visibility is a rendering question, permission is not.
 *
 * A missing current exercise (a completed workout indexes past the queue) reads
 * as "no button", which is the safe way to be wrong.
 */
export function showMachineBusyButton(workout: WorkoutState): boolean {
  return workout.exercises[workout.exerciseIndex]?.completedSets === 0
}

/**
 * The same offer, on the rest screen that ends an exercise. That rest *is* the
 * walk to the next machine — it already announces which exercise is coming —
 * so it is where the user finds out the machine is busy, a screen before the
 * cursor moves. Withholding the button until "Start next set" is tapped puts it
 * one tap after the moment it is needed, which reads as it never showing at all.
 *
 * The exercise the rest leads into is the one that would be deferred, so it is
 * the one the rule is asked about. A rest between two sets of the same exercise
 * leads back to a machine already in use, and the last exercise has nothing
 * behind it to swap with — neither offers the button.
 */
export function showMachineBusyButtonDuringRest(workout: WorkoutState): boolean {
  if (workout.setNumber < workout.setsPerExercise) return false
  const upcoming = workout.exerciseIndex + 1
  if (upcoming >= workout.exerciseCount - 1) return false
  return workout.exercises[upcoming]?.completedSets === 0
}

/**
 * Pushes the current exercise behind the next available one and opens that one
 * instead — for when the machine you were about to use is occupied. Deferred,
 * not skipped: it comes straight back once that exercise is done, and the
 * workout cannot finish without it. The server refuses once it has sets on it.
 */
export function deferExercise(): Promise<AnchoredWorkout> {
  return post('defer')
}

/**
 * What a body weight may be, in kg. Zero and negatives fall below the floor, and
 * anything past the ceiling is a slipped decimal point rather than a person. The
 * server enforces the same bounds — these exist so the user is told why.
 */
export const BODY_WEIGHT_MIN = 20
export const BODY_WEIGHT_MAX = 400

/**
 * Records the body weight of a finished workout, or corrects one already saved.
 * The workout is named in the URL: it is finished, so there is no active session
 * for the server to resolve it from. `null` clears a value entered by mistake.
 */
export function saveBodyWeight(
  workoutId: number,
  bodyWeightKg: number | null,
): Promise<AnchoredWorkout> {
  return post(`${workoutId}/body-weight`, { bodyWeightKg })
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

const SUMMARY_ERROR = 'Could not load the workout summary.'

/**
 * The AI post-workout summary for a finished workout. Fetched once the workout
 * completes; the server generates it in the background at completion and this
 * endpoint returns the cached copy (or generates it on demand if the background
 * job has not landed yet). Reloading the summary screen re-fetches the same
 * cached summary rather than paying for a new generation.
 */
export function useWorkoutSummary(workoutId: number | null): {
  state: Loadable<WorkoutAiSummary>
  regenerate: () => Promise<void>
} {
  const [state, setState] = useState<Loadable<WorkoutAiSummary>>({
    status: 'loading',
  })

  useEffect(() => {
    if (workoutId === null) return
    const controller = new AbortController()
    setState({ status: 'loading' })

    void (async () => {
      try {
        const res = await fetch(`/api/workout/${workoutId}/summary`, {
          credentials: 'include',
          signal: controller.signal,
        })
        if (!res.ok) {
          setState({
            status: 'error',
            message: await errorMessage(res, SUMMARY_ERROR),
          })
          return
        }
        const data = (await res.json()) as { summary: WorkoutAiSummary }
        setState({ status: 'ready', data: data.summary })
      } catch (err) {
        if (isAbort(err)) return
        setState({ status: 'error', message: SUMMARY_ERROR })
      }
    })()

    return () => controller.abort()
  }, [workoutId])

  /** Forces a fresh generation — the manual "try again" path. */
  const regenerate = useCallback(async () => {
    if (workoutId === null) return
    setState({ status: 'loading' })
    try {
      const res = await fetch(
        `/api/workout/${workoutId}/summary/regenerate`,
        { method: 'POST', credentials: 'include' },
      )
      if (!res.ok) {
        setState({
          status: 'error',
          message: await errorMessage(res, SUMMARY_ERROR),
        })
        return
      }
      const data = (await res.json()) as { summary: WorkoutAiSummary }
      setState({ status: 'ready', data: data.summary })
    } catch {
      setState({ status: 'error', message: SUMMARY_ERROR })
    }
  }, [workoutId])

  return { state, regenerate }
}

/**
 * History already fetched for the signed-in user, by exercise name.
 *
 * The workout screen remounts on every set and every phase change, and refetching
 * the same five workouts four times per exercise is latency the user pays for
 * while standing at the rack. Safe to cache: the endpoint reports only *completed*
 * workouts, and the one in progress completes on the last set of the last
 * exercise — after which no panel is rendered. So nothing here can go stale
 * while one user is signed in.
 *
 * It is keyed by exercise name and not by user, so it MUST be emptied when the
 * signed-in user changes — otherwise the next user to sign in on this tab is
 * served the previous one's lifting history. `clearExerciseHistoryCache` is
 * called on login and logout for exactly that reason.
 */
const historyCache = new Map<string, ExerciseHistory>()

/** Drops every cached exercise history. Called whenever the session changes. */
export function clearExerciseHistoryCache(): void {
  historyCache.clear()
}

/**
 * The user's history on one exercise: last workout, the last five, best ever.
 * One exercise, one request — never the whole plan — and only when the panel's
 * exercise changes. The server does the aggregating.
 *
 * When the exercise carries a library id (a Training Builder workout), history
 * is resolved by that id, so it follows the movement even after it is removed
 * from a day and added back. A legacy-plan exercise has no library id and falls
 * back to matching by name. The cache is keyed by whichever was used, so the two
 * never collide.
 */
export function useExerciseHistory(
  exerciseName: string,
  exerciseLibraryId: number | null = null,
): Loadable<ExerciseHistory> {
  const cacheKey =
    exerciseLibraryId !== null ? `lib:${exerciseLibraryId}` : `name:${exerciseName}`
  const url =
    exerciseLibraryId !== null
      ? `/api/workout/exercise-history/${exerciseLibraryId}`
      : `/api/workout/history?name=${encodeURIComponent(exerciseName)}`

  const [state, setState] = useState<Loadable<ExerciseHistory>>(() => {
    const cached = historyCache.get(cacheKey)
    return cached ? { status: 'ready', data: cached } : { status: 'loading' }
  })

  useEffect(() => {
    const cached = historyCache.get(cacheKey)
    if (cached) {
      setState({ status: 'ready', data: cached })
      return
    }

    const controller = new AbortController()
    setState({ status: 'loading' })

    void (async () => {
      try {
        const res = await fetch(url, {
          credentials: 'include',
          signal: controller.signal,
        })
        if (!res.ok) {
          setState({
            status: 'error',
            message: await errorMessage(res, HISTORY_ERROR),
          })
          return
        }
        const data = (await res.json()) as { history: ExerciseHistory }
        historyCache.set(cacheKey, data.history)
        setState({ status: 'ready', data: data.history })
      } catch (err) {
        if (isAbort(err)) return
        setState({ status: 'error', message: HISTORY_ERROR })
      }
    })()

    return () => controller.abort()
  }, [cacheKey, url])

  return state
}

/** `72.5`, `75` — trailing zeros dropped, because a rack is not a spreadsheet. */
export function formatWeight(kg: number): string {
  return String(Math.round(kg * 100) / 100)
}

/** The weights of a workout's sets, in order: `75 / 75 / 70 / 70`. */
export function formatSetWeights(sets: HistorySet[]): string {
  return sets.map((set) => formatWeight(set.weight)).join(' / ')
}

/** `03 Jul`. Compact enough for a row label on a phone. */
export function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: '2-digit',
    month: 'short',
  })
}

/**
 * `Today`, `Yesterday`, `3 days ago`, and a plain date once a week has passed —
 * past that, "23 days ago" is a number to decode rather than a fact to glance at.
 * Counted in whole calendar days so a workout last night reads "Yesterday"
 * rather than "0 days ago".
 */
export function formatRelativeDay(iso: string, now: Date = new Date()): string {
  const midnight = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const then = new Date(iso)
  const days = Math.round((midnight(now) - midnight(then)) / 86_400_000)

  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days <= 6) return `${days} days ago`
  return formatShortDate(iso)
}

/** How today's set compares to the same set of the last workout. */
export type Improvement = 'none' | 'weight' | 'reps' | 'both'

/**
 * Whether what is typed beats what was lifted on this set last time.
 *
 * Heavier for at least the same reps is a win, and so are more reps at the same
 * weight. Everything else — heavier but for fewer reps, more reps but lighter —
 * is a trade rather than an improvement, and the panel says nothing about it.
 * Claiming a win the user has not had is worse than staying quiet.
 */
export function improvementOverLast(
  last: HistoryWorkout | null,
  setNumber: number,
  weight: number | null,
  reps: number | null,
): Improvement {
  if (!last || weight === null || reps === null) return 'none'
  const previous = last.sets.find((set) => set.setNumber === setNumber)
  if (!previous) return 'none'

  const heavier = weight > previous.weight
  const moreReps = reps > previous.reps

  if (heavier && moreReps) return 'both'
  if (heavier && reps >= previous.reps) return 'weight'
  if (weight === previous.weight && moreReps) return 'reps'
  return 'none'
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

/**
 * Seconds spent resting past the planned rest, or null when not resting or the
 * countdown has not run out yet. Derived from timestamps, so it stays accurate
 * after the tab was backgrounded — it is not a running interval tally.
 */
export function restOverSeconds({
  workout,
  receivedAt,
}: AnchoredWorkout): number | null {
  if (workout.restRemainingSeconds === null) return null
  const over = secondsSince(receivedAt) - workout.restRemainingSeconds
  return over > 0 ? over : null
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

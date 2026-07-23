import { useCallback, useEffect, useState } from 'react'
import { errorMessage, isAbort, type Loadable } from './api'

/**
 * Data access for the Stats tab. Every figure is computed by Postgres and served
 * by the backend — nothing here derives a statistic from local state, and no
 * total is cached in the browser. The session cookie goes with the request; the
 * server scopes the numbers to the user who asked for them.
 */

export type WeekSummary = {
  workouts: number
  seconds: number
  sets: number
  volumeKg: number
}

export type Consistency = {
  currentStreakDays: number
  workoutsThisMonth: number
  averageWorkoutsPerWeek: number
}

export type BodyWeightStats = {
  latestKg: number
  recordedAt: string
  /** Null until two measurements exist in the last 30 days. */
  changeKg: number | null
  changeSince: string | null
}

export type PersonalRecord = {
  exerciseName: string
  weightKg: number
  reps: number
  estimatedOneRepMaxKg: number
  achievedAt: string
}

export type RecentWorkout = {
  id: number
  dayName: string
  completedAt: string
  durationSeconds: number
  exerciseCount: number
  setCount: number
  volumeKg: number
  bodyWeightKg: number | null
}

export type StatsOverview = {
  week: WeekSummary
  consistency: Consistency
  /** Null when the user has never recorded a body weight. */
  bodyWeight: BodyWeightStats | null
  personalRecords: PersonalRecord[]
  recentWorkouts: RecentWorkout[]
}

const GENERIC_ERROR = 'Could not load your stats. Please try again.'

/** The stats overview, fetched from the backend on mount. */
export function useStatsOverview(): Loadable<StatsOverview> {
  const [state, setState] = useState<Loadable<StatsOverview>>({
    status: 'loading',
  })

  useEffect(() => {
    const controller = new AbortController()

    void (async () => {
      try {
        const res = await fetch('/api/stats/overview', {
          credentials: 'include',
          signal: controller.signal,
        })
        if (!res.ok) {
          setState({
            status: 'error',
            message: await errorMessage(res, GENERIC_ERROR),
          })
          return
        }
        const data = (await res.json()) as { stats: StatsOverview }
        setState({ status: 'ready', data: data.stats })
      } catch (err) {
        if (isAbort(err)) return
        setState({ status: 'error', message: GENERIC_ERROR })
      }
    })()

    return () => controller.abort()
  }, [])

  return state
}

/**
 * `45m`, `1h 20m`. Coarser than the workout clock on purpose: a week's training
 * time is a figure to glance at, and seconds would only add noise to it.
 */
export function formatTrainingTime(totalSeconds: number): string {
  const minutes = Math.max(0, Math.round(totalSeconds / 60))
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  if (hours === 0) return `${mins}m`
  return `${hours}h ${mins}m`
}

/** `7,680 kg`. Volume runs to five figures quickly; group it or it is unreadable. */
export function formatVolume(kg: number): string {
  return `${Math.round(kg).toLocaleString()} kg`
}

/** `+1.2`, `-2.3`, `0` — the sign is the whole point of a change. */
export function formatSignedKg(kg: number): string {
  const rounded = Math.round(kg * 10) / 10
  if (rounded > 0) return `+${rounded}`
  return String(rounded)
}

/** Which way a change points, for the arrow and its colour. */
export function trendOf(change: number): 'up' | 'down' | 'flat' {
  const rounded = Math.round(change * 10) / 10
  if (rounded > 0) return 'up'
  if (rounded < 0) return 'down'
  return 'flat'
}

/**
 * The AI general-progress summary. This analyses overall training across ALL
 * workouts in the selected window — unlike the post-workout summary, which
 * compares one finished session to earlier sessions of the same training day.
 */

export type ProgressPeriod = 'week' | 'month' | 'three_months' | 'all_time'

export type ProgressAssessment =
  | 'improving'
  | 'stable'
  | 'declining'
  | 'not_enough_data'

export type ProgressBestSet = {
  name: string
  weight: number
  reps: number
  e1rm: number
}

export type ExerciseProgress = {
  name: string
  volume: number
  sets: number
  reps: number
  bestE1rm: number
  sessions: number
  e1rmChange: number
}

export type MuscleGroupVolume = { name: string; volume: number; sets: number }

export type TrendBucket = { label: string; volume: number; workouts: number }

export type WorkoutVolume = { date: string; dayName: string; volume: number }

export type WindowTotals = { workouts: number; volume: number; reps: number }

/** The deterministic numbers behind the summary — the data the UI charts. */
export type ProgressMetrics = {
  period: ProgressPeriod
  periodLabel: string
  workouts: number
  totalVolume: number
  totalSets: number
  totalReps: number
  averageWorkoutsPerWeek: number
  daysTrained: { name: string; workouts: number }[]
  volumeTrend: TrendBucket[]
  volumeByWorkout: WorkoutVolume[]
  topExercises: ExerciseProgress[]
  muscleGroups: MuscleGroupVolume[]
  bestSets: ProgressBestSet[]
  previous: WindowTotals | null
}

export type ProgressSummary = {
  period: ProgressPeriod
  status: 'ready' | 'unavailable'
  generatedAt: string | null
  assessment: ProgressAssessment
  headline: string
  summary: string
  consistencyNote: string
  highlights: string[]
  weakSpots: string[]
  comparisonNote: string
  recommendations: string[]
  metrics: ProgressMetrics
}

export const PROGRESS_PERIODS: { value: ProgressPeriod; label: string }[] = [
  { value: 'week', label: 'Last week' },
  { value: 'month', label: 'Last month' },
  { value: 'three_months', label: 'Last 3 months' },
  { value: 'all_time', label: 'All time' },
]

const SUMMARY_ERROR = 'Could not generate AI summary. Your workout data is still saved.'

/**
 * The AI progress summary for a period, re-fetched whenever the period changes.
 * The server caches the narrative and only re-generates it when new training has
 * changed the numbers, so switching between periods is cheap.
 */
export function useProgressSummary(period: ProgressPeriod): {
  state: Loadable<ProgressSummary>
  regenerate: () => Promise<void>
} {
  const [state, setState] = useState<Loadable<ProgressSummary>>({
    status: 'loading',
  })

  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading' })

    void (async () => {
      try {
        const res = await fetch(`/api/stats/ai-summary?period=${period}`, {
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
        const data = (await res.json()) as { summary: ProgressSummary }
        setState({ status: 'ready', data: data.summary })
      } catch (err) {
        if (isAbort(err)) return
        setState({ status: 'error', message: SUMMARY_ERROR })
      }
    })()

    return () => controller.abort()
  }, [period])

  const regenerate = useCallback(async () => {
    setState({ status: 'loading' })
    try {
      const res = await fetch('/api/stats/ai-summary/regenerate', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period }),
      })
      if (!res.ok) {
        setState({
          status: 'error',
          message: await errorMessage(res, SUMMARY_ERROR),
        })
        return
      }
      const data = (await res.json()) as { summary: ProgressSummary }
      setState({ status: 'ready', data: data.summary })
    } catch {
      setState({ status: 'error', message: SUMMARY_ERROR })
    }
  }, [period])

  return { state, regenerate }
}

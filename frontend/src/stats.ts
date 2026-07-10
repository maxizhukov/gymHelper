import { useEffect, useState } from 'react'
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

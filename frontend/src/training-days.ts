import { useEffect, useState } from 'react'
import { errorMessage, isAbort, type Loadable } from './api'

/**
 * Data access for the training plan. The plan lives in the database and is
 * served by the backend — nothing here holds a copy of it. The session cookie
 * is sent with every request; the server decides what the user may see.
 */

/** A training day as shown in the list, without its exercises. */
export type TrainingDaySummary = {
  slug: string
  day: string
  focus: string
}

/**
 * A training day with its exercises. `exerciseGroups` preserves the order the
 * exercises are performed in: groups run top to bottom, and exercises within a
 * group do too. A group is one block of the workout (e.g. the chest presses,
 * then triceps).
 */
export type TrainingDay = TrainingDaySummary & {
  exerciseGroups: string[][]
}

const GENERIC_ERROR = 'Could not load the training plan. Please try again.'

/** The training days, fetched from the backend on mount. */
export function useTrainingDays(): Loadable<TrainingDaySummary[]> {
  const [state, setState] = useState<Loadable<TrainingDaySummary[]>>({
    status: 'loading',
  })

  useEffect(() => {
    const controller = new AbortController()

    void (async () => {
      try {
        const res = await fetch('/api/training-days', {
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
        const data = (await res.json()) as { days: TrainingDaySummary[] }
        setState({ status: 'ready', data: data.days })
      } catch (err) {
        if (isAbort(err)) return
        setState({ status: 'error', message: GENERIC_ERROR })
      }
    })()

    return () => controller.abort()
  }, [])

  return state
}

/** One training day with its exercises. An unknown slug yields 'not-found'. */
export function useTrainingDay(slug: string | undefined): Loadable<TrainingDay> {
  const [state, setState] = useState<Loadable<TrainingDay>>({
    status: 'loading',
  })

  useEffect(() => {
    if (!slug) {
      setState({ status: 'not-found' })
      return
    }

    const controller = new AbortController()
    setState({ status: 'loading' })

    void (async () => {
      try {
        const res = await fetch(
          `/api/training-days/${encodeURIComponent(slug)}`,
          { credentials: 'include', signal: controller.signal },
        )
        if (res.status === 404 || res.status === 400) {
          setState({ status: 'not-found' })
          return
        }
        if (!res.ok) {
          setState({
            status: 'error',
            message: await errorMessage(res, GENERIC_ERROR),
          })
          return
        }
        const data = (await res.json()) as { day: TrainingDay }
        setState({ status: 'ready', data: data.day })
      } catch (err) {
        if (isAbort(err)) return
        setState({ status: 'error', message: GENERIC_ERROR })
      }
    })()

    return () => controller.abort()
  }, [slug])

  return state
}

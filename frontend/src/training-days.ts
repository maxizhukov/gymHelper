import { useEffect, useState } from 'react'

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

/** What a page needs to render: still loading, failed, missing, or here. */
export type Loadable<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'not-found' }
  | { status: 'ready'; data: T }

const GENERIC_ERROR = 'Could not load the training plan. Please try again.'

/** Reads the error message the API sends, falling back to a generic one. */
async function errorMessage(res: Response): Promise<string> {
  const data = (await res.json().catch(() => null)) as {
    message?: string
  } | null
  return data?.message ?? GENERIC_ERROR
}

/** An aborted fetch is a unmount, not a failure — the caller ignores it. */
function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

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
          setState({ status: 'error', message: await errorMessage(res) })
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
          setState({ status: 'error', message: await errorMessage(res) })
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

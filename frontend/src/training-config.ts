import { useEffect, useState } from 'react'
import { errorMessage, isAbort, type Loadable } from './api'

/**
 * Data access for the signed-in user's training settings. The config lives in
 * the database, keyed by the session user — nothing here holds a copy of it and
 * no user id is ever sent, the server derives it from the session cookie.
 */

/** `restPeriod` is the pause between sets in seconds; `reps` per set. */
export type TrainingConfig = {
  restPeriod: number
  reps: number
}

const LOAD_ERROR = 'Could not load your training settings. Please try again.'
const SAVE_ERROR = 'Could not save your training settings. Please try again.'

/** The user's training settings, fetched from the backend on mount. */
export function useTrainingConfig(): Loadable<TrainingConfig> {
  const [state, setState] = useState<Loadable<TrainingConfig>>({
    status: 'loading',
  })

  useEffect(() => {
    const controller = new AbortController()

    void (async () => {
      try {
        const res = await fetch('/api/training-config', {
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
        const data = (await res.json()) as { config: TrainingConfig }
        setState({ status: 'ready', data: data.config })
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
 * Saves the settings and returns what the server stored. Throws with a
 * user-facing message when the request fails, so the caller can surface it.
 */
export async function saveTrainingConfig(
  config: TrainingConfig,
): Promise<TrainingConfig> {
  const res = await fetch('/api/training-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(config),
  })
  if (!res.ok) {
    throw new Error(await errorMessage(res, SAVE_ERROR))
  }
  const data = (await res.json()) as { config: TrainingConfig }
  return data.config
}

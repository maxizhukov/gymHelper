import { useEffect, useState } from 'react'
import { errorMessage, isAbort, type Loadable } from './api'

/**
 * Data access for the exercise library — the catalogue of movements the user can
 * browse. The list lives in the database and is served by the backend; nothing
 * here holds a copy of it. The session cookie is sent with every request; the
 * server decides what the user may see. Later this will connect to training
 * plans so a workout exercise can be swapped for another from here.
 */

/** One exercise as shown in the library list. */
export type LibraryExercise = {
  id: number
  name: string
  category: string | null
  muscleGroup: string | null
  equipment: string | null
  movementPattern: string | null
  difficulty: string | null
  descriptionRu: string | null
  sourceUrl: string | null
  videoUrl: string | null
  thumbnailUrl: string | null
  isActive: boolean
  sortOrder: number | null
}

const GENERIC_ERROR = 'Could not load the exercise library. Please try again.'

/** The exercise library, fetched from the backend on mount. */
export function useExerciseLibrary(): Loadable<LibraryExercise[]> {
  const [state, setState] = useState<Loadable<LibraryExercise[]>>({
    status: 'loading',
  })

  useEffect(() => {
    const controller = new AbortController()

    void (async () => {
      try {
        const res = await fetch('/api/exercises', {
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
        const data = (await res.json()) as { exercises: LibraryExercise[] }
        setState({ status: 'ready', data: data.exercises })
      } catch (err) {
        if (isAbort(err)) return
        setState({ status: 'error', message: GENERIC_ERROR })
      }
    })()

    return () => controller.abort()
  }, [])

  return state
}

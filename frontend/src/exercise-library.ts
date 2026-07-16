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
const DETAIL_ERROR = 'Could not load exercise details.'

/**
 * One exercise's details, kept for the life of the session. The workout screen
 * asks for the same movement repeatedly across its sets, so a resolved detail is
 * held here and returned without another request.
 */
const detailCache = new Map<number, LibraryExercise>()

/**
 * One exercise by id, for the collapsible info on the workout screen. Fetched
 * only when first needed and then cached, so expanding the panel a second time —
 * or moving through the sets of the same exercise — costs no request.
 */
export function useExerciseDetail(id: number): Loadable<LibraryExercise> {
  const [state, setState] = useState<Loadable<LibraryExercise>>(() => {
    const cached = detailCache.get(id)
    return cached ? { status: 'ready', data: cached } : { status: 'loading' }
  })

  useEffect(() => {
    const cached = detailCache.get(id)
    if (cached) {
      setState({ status: 'ready', data: cached })
      return
    }

    const controller = new AbortController()
    setState({ status: 'loading' })

    void (async () => {
      try {
        const res = await fetch(`/api/exercises/${id}`, {
          credentials: 'include',
          signal: controller.signal,
        })
        if (res.status === 404) {
          setState({ status: 'not-found' })
          return
        }
        if (!res.ok) {
          setState({
            status: 'error',
            message: await errorMessage(res, DETAIL_ERROR),
          })
          return
        }
        const data = (await res.json()) as { exercise: LibraryExercise }
        detailCache.set(id, data.exercise)
        setState({ status: 'ready', data: data.exercise })
      } catch (err) {
        if (isAbort(err)) return
        setState({ status: 'error', message: DETAIL_ERROR })
      }
    })()

    return () => controller.abort()
  }, [id])

  return state
}

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

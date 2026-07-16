import { useCallback, useEffect, useState } from 'react'
import { errorMessage, isAbort, type Loadable } from './api'

/**
 * Data access for the Training Builder — the user's repeatable templates, the
 * days inside them, and the library exercises placed on each day. Everything
 * lives in the database and is served by the backend; nothing here holds a copy.
 * The session cookie is sent with every request and the server re-checks that
 * the acting user owns whatever they touch.
 *
 * Mutations return the server's view of what changed, but the panel mostly
 * re-reads the whole template after each one — the database is the source of
 * truth, and re-reading keeps the screen from ever drifting from it.
 */

export type TemplateSummary = {
  id: number
  name: string
}

export type TemplateDayExercise = {
  id: number
  exerciseLibraryId: number
  name: string
  category: string | null
  muscleGroup: string | null
  position: number
}

export type TemplateDay = {
  id: number
  name: string
  exercises: TemplateDayExercise[]
}

export type TemplateDetail = TemplateSummary & {
  days: TemplateDay[]
}

const LIST_ERROR = 'Could not load your templates. Please try again.'
const DETAIL_ERROR = 'Could not load this template. Please try again.'
const ACTION_ERROR = 'Could not save that. Please try again.'

const JSON_HEADERS = { 'Content-Type': 'application/json' }

/** Sends a request and throws the server's message on a non-2xx response. */
async function send<T>(
  path: string,
  init: RequestInit,
): Promise<T> {
  const res = await fetch(`/api/training-templates${path}`, {
    credentials: 'include',
    ...init,
  })
  if (!res.ok) {
    throw new Error(await errorMessage(res, ACTION_ERROR))
  }
  // 204 responses carry no body.
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export async function createTemplate(name: string): Promise<TemplateSummary> {
  const data = await send<{ template: TemplateSummary }>('', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name }),
  })
  return data.template
}

export async function renameTemplate(
  id: number,
  name: string,
): Promise<TemplateSummary> {
  const data = await send<{ template: TemplateSummary }>(`/${id}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name }),
  })
  return data.template
}

export async function deleteTemplate(id: number): Promise<void> {
  await send<void>(`/${id}`, { method: 'DELETE' })
}

export async function createDay(
  templateId: number,
  name: string,
): Promise<TemplateDay> {
  const data = await send<{ day: TemplateDay }>(`/${templateId}/days`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name }),
  })
  return data.day
}

export async function renameDay(dayId: number, name: string): Promise<void> {
  await send<void>(`/days/${dayId}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name }),
  })
}

export async function deleteDay(dayId: number): Promise<void> {
  await send<void>(`/days/${dayId}`, { method: 'DELETE' })
}

export async function addExercise(
  dayId: number,
  exerciseLibraryId: number,
): Promise<TemplateDayExercise> {
  const data = await send<{ exercise: TemplateDayExercise }>(
    `/days/${dayId}/exercises`,
    {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ exerciseLibraryId }),
    },
  )
  return data.exercise
}

export async function removeExercise(
  dayId: number,
  exerciseId: number,
): Promise<void> {
  await send<void>(`/days/${dayId}/exercises/${exerciseId}`, {
    method: 'DELETE',
  })
}

export async function reorderExercises(
  dayId: number,
  orderedIds: number[],
): Promise<void> {
  await send<void>(`/days/${dayId}/order`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ orderedIds }),
  })
}

/** The user's templates, with a `reload` to re-fetch after a mutation. */
export function useTemplates(): {
  state: Loadable<TemplateSummary[]>
  reload: () => void
} {
  const [state, setState] = useState<Loadable<TemplateSummary[]>>({
    status: 'loading',
  })
  const [nonce, setNonce] = useState(0)
  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    const controller = new AbortController()

    void (async () => {
      try {
        const res = await fetch('/api/training-templates', {
          credentials: 'include',
          signal: controller.signal,
        })
        if (!res.ok) {
          setState({ status: 'error', message: await errorMessage(res, LIST_ERROR) })
          return
        }
        const data = (await res.json()) as { templates: TemplateSummary[] }
        setState({ status: 'ready', data: data.templates })
      } catch (err) {
        if (isAbort(err)) return
        setState({ status: 'error', message: LIST_ERROR })
      }
    })()

    return () => controller.abort()
  }, [nonce])

  return { state, reload }
}

/** One template with its days and exercises, with a `reload` after mutations. */
export function useTemplate(id: number | null): {
  state: Loadable<TemplateDetail>
  reload: () => void
} {
  const [state, setState] = useState<Loadable<TemplateDetail>>({
    status: 'loading',
  })
  const [nonce, setNonce] = useState(0)
  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    if (id === null) {
      setState({ status: 'not-found' })
      return
    }

    const controller = new AbortController()
    setState({ status: 'loading' })

    void (async () => {
      try {
        const res = await fetch(`/api/training-templates/${id}`, {
          credentials: 'include',
          signal: controller.signal,
        })
        if (res.status === 404 || res.status === 400) {
          setState({ status: 'not-found' })
          return
        }
        if (!res.ok) {
          setState({ status: 'error', message: await errorMessage(res, DETAIL_ERROR) })
          return
        }
        const data = (await res.json()) as { template: TemplateDetail }
        setState({ status: 'ready', data: data.template })
      } catch (err) {
        if (isAbort(err)) return
        setState({ status: 'error', message: DETAIL_ERROR })
      }
    })()

    return () => controller.abort()
  }, [id, nonce])

  return { state, reload }
}

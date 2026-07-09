/**
 * Shared plumbing for talking to the backend. Every request sends the session
 * cookie; the server decides what the user may see and change.
 */

/** What a page needs to render: still loading, failed, missing, or here. */
export type Loadable<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'not-found' }
  | { status: 'ready'; data: T }

/** Reads the error message the API sends, falling back to a generic one. */
export async function errorMessage(
  res: Response,
  fallback: string,
): Promise<string> {
  const data = (await res.json().catch(() => null)) as {
    message?: string
  } | null
  return data?.message ?? fallback
}

/** An aborted fetch is an unmount, not a failure — the caller ignores it. */
export function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { AuthContext, type AuthenticatedUser } from './auth-context'

/**
 * Holds the signed-in user for the whole route tree. The session itself lives in
 * an HttpOnly cookie the browser sends automatically — nothing sensitive is kept
 * in client storage, and the server stays the source of truth for who is signed in.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthenticatedUser | null>(null)
  const [checking, setChecking] = useState(true)

  // Restore the session on load by asking the server who we are, so a refresh on
  // any URL (not just "/") keeps the user signed in.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/auth/me', { credentials: 'include' })
        if (!cancelled && res.ok) {
          const data = (await res.json()) as { user: AuthenticatedUser }
          setUser(data.user)
        }
      } catch {
        // Network error — treat as signed out; the login route will show.
      } finally {
        if (!cancelled) setChecking(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const login = useCallback(async (username: string, password: string) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username, password }),
    })

    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as {
        message?: string
      } | null
      throw new Error(data?.message ?? 'Login failed. Please try again.')
    }

    const data = (await res.json()) as { user: AuthenticatedUser }
    setUser(data.user)
  }, [])

  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
      })
    } catch {
      // Even if the request fails, drop local state so the UI signs out.
    }
    setUser(null)
  }, [])

  const value = useMemo(
    () => ({ user, checking, login, logout }),
    [user, checking, login, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

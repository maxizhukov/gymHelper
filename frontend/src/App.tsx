import { useEffect, useState, type FormEvent } from 'react'
import './App.css'

type LoginState = 'idle' | 'submitting' | 'success' | 'error'
type View = 'home' | 'profile'
type ChangePwState = 'idle' | 'submitting' | 'success' | 'error'

interface AuthenticatedUser {
  id: number
  username: string
}

function App() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [user, setUser] = useState<AuthenticatedUser | null>(null)
  const [state, setState] = useState<LoginState>('idle')
  const [error, setError] = useState('')
  const [view, setView] = useState<View>('home')
  // While true, we're still asking the server whether a session cookie exists.
  const [checking, setChecking] = useState(true)

  // Restore the session on load by asking the server who we are. The session
  // lives in an HttpOnly cookie the browser sends automatically — nothing
  // sensitive is kept in client storage.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/auth/me', { credentials: 'include' })
        if (!cancelled && res.ok) {
          const data = (await res.json()) as { user: AuthenticatedUser }
          setUser(data.user)
          setState('success')
        }
      } catch {
        // Network error — treat as signed out; the login form will show.
      } finally {
        if (!cancelled) setChecking(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setState('submitting')
    setError('')

    try {
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
      setState('success')
      setPassword('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed.')
      setState('error')
    }
  }

  async function handleLogout() {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
      })
    } catch {
      // Even if the request fails, drop local state so the UI signs out.
    }
    setUser(null)
    setState('idle')
    setView('home')
    setUsername('')
    setPassword('')
    setError('')
  }

  if (checking) {
    return (
      <main className="app">
        <h1>🏋️ GymHelper</h1>
        <p className="subtitle">Loading…</p>
      </main>
    )
  }

  if (state === 'success' && user) {
    if (view === 'profile') {
      return (
        <ProfileSettings
          user={user}
          onBack={() => setView('home')}
          onLogout={handleLogout}
        />
      )
    }

    return (
      <main className="app">
        <h1>🏋️ GymHelper</h1>
        <div className="card status-ok">
          <p className="label">Signed in as</p>
          <p className="message">{user.username}</p>
        </div>

        <nav className="home-nav">
          <button
            type="button"
            className="nav-button"
            onClick={() => setView('profile')}
          >
            ⚙️ Profile settings
          </button>
        </nav>
      </main>
    )
  }

  return (
    <main className="app">
      <h1>🏋️ GymHelper</h1>
      <p className="subtitle">Sign in to your account</p>

      <form className="card login-form" onSubmit={handleSubmit}>
        <label className="field">
          <span>Username</span>
          <input
            type="text"
            name="username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </label>

        <label className="field">
          <span>Password</span>
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>

        {state === 'error' && <p className="error">{error}</p>}

        <button type="submit" disabled={state === 'submitting'}>
          {state === 'submitting' ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  )
}

interface ProfileSettingsProps {
  user: AuthenticatedUser
  onBack: () => void
  onLogout: () => void
}

function ProfileSettings({ user, onBack, onLogout }: ProfileSettingsProps) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [pwState, setPwState] = useState<ChangePwState>('idle')
  const [message, setMessage] = useState('')

  async function handleChangePassword(event: FormEvent) {
    event.preventDefault()

    // Only rule: the new password must have at least one character.
    if (newPassword.length < 1) {
      setPwState('error')
      setMessage('New password must have at least 1 character.')
      return
    }

    setPwState('submitting')
    setMessage('')

    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          currentPassword,
          newPassword,
        }),
      })

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          message?: string
        } | null
        throw new Error(
          data?.message ?? 'Could not change password. Please try again.',
        )
      }

      setPwState('success')
      setMessage('Password changed successfully.')
      setCurrentPassword('')
      setNewPassword('')
    } catch (err) {
      setPwState('error')
      setMessage(
        err instanceof Error ? err.message : 'Could not change password.',
      )
    }
  }

  return (
    <main className="app">
      <button type="button" className="back-link" onClick={onBack}>
        ← Back
      </button>
      <h1>Profile settings</h1>
      <p className="subtitle">Signed in as {user.username}</p>

      <form className="card login-form" onSubmit={handleChangePassword}>
        <p className="label">Change password</p>

        <label className="field">
          <span>Current password</span>
          <input
            type="password"
            name="currentPassword"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
          />
        </label>

        <label className="field">
          <span>New password</span>
          <input
            type="password"
            name="newPassword"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
          />
        </label>

        {pwState === 'error' && <p className="error">{message}</p>}
        {pwState === 'success' && <p className="success">{message}</p>}

        <button type="submit" disabled={pwState === 'submitting'}>
          {pwState === 'submitting' ? 'Saving…' : 'Change password'}
        </button>
      </form>

      <button type="button" className="logout-button" onClick={onLogout}>
        Log out
      </button>
    </main>
  )
}

export default App

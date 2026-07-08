import { useState, type FormEvent } from 'react'
import './App.css'

type LoginState = 'idle' | 'submitting' | 'success' | 'error'
type View = 'home' | 'profile'
type ChangePwState = 'idle' | 'submitting' | 'success' | 'error'

interface AuthenticatedUser {
  id: number
  username: string
}

// Key under which the signed-in user is persisted so the session survives a
// page refresh. Only the (non-secret) user identity is stored — never the
// password. The backend is stateless and issues no token, so remembering who
// is signed in is done entirely client-side.
const AUTH_STORAGE_KEY = 'gymhelper.auth.user'

function loadStoredUser(): AuthenticatedUser | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<AuthenticatedUser>
    if (typeof parsed?.id === 'number' && typeof parsed?.username === 'string') {
      return { id: parsed.id, username: parsed.username }
    }
  } catch {
    // Corrupt or unavailable storage — fall back to signed-out.
  }
  return null
}

function App() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [user, setUser] = useState<AuthenticatedUser | null>(loadStoredUser)
  const [state, setState] = useState<LoginState>(() =>
    user ? 'success' : 'idle',
  )
  const [error, setError] = useState('')
  const [view, setView] = useState<View>('home')

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setState('submitting')
    setError('')

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          message?: string
        } | null
        throw new Error(data?.message ?? 'Login failed. Please try again.')
      }

      const data = (await res.json()) as { user: AuthenticatedUser }
      try {
        localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(data.user))
      } catch {
        // Persisting is best-effort; a full/blocked storage still allows login.
      }
      setUser(data.user)
      setState('success')
      setPassword('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed.')
      setState('error')
    }
  }

  function handleLogout() {
    try {
      localStorage.removeItem(AUTH_STORAGE_KEY)
    } catch {
      // Ignore storage errors on logout.
    }
    setUser(null)
    setState('idle')
    setView('home')
    setUsername('')
    setPassword('')
    setError('')
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
        body: JSON.stringify({
          username: user.username,
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

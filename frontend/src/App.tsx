import { useState, type FormEvent } from 'react'
import './App.css'

type LoginState = 'idle' | 'submitting' | 'success' | 'error'

interface AuthenticatedUser {
  id: number
  username: string
}

function App() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [state, setState] = useState<LoginState>('idle')
  const [error, setError] = useState('')
  const [user, setUser] = useState<AuthenticatedUser | null>(null)

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
      setUser(data.user)
      setState('success')
      setPassword('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed.')
      setState('error')
    }
  }

  if (state === 'success' && user) {
    return (
      <main className="app">
        <h1>🏋️ GymHelper</h1>
        <div className="card status-ok">
          <p className="label">Signed in as</p>
          <p className="message">{user.username}</p>
        </div>
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

export default App

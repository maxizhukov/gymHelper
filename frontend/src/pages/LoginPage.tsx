import { useState } from 'react'
import { Button } from '@base-ui/react/button'
import { Field } from '@base-ui/react/field'
import { Form } from '@base-ui/react/form'
import { Input } from '@base-ui/react/input'
import { useAuth } from '../auth/useAuth'

type LoginState = 'idle' | 'submitting' | 'error'

export default function LoginPage() {
  const { login } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [state, setState] = useState<LoginState>('idle')
  const [error, setError] = useState('')

  async function handleSubmit() {
    setState('submitting')
    setError('')

    try {
      await login(username, password)
      // On success the route guard swaps this page out for the destination.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed.')
      setState('error')
    }
  }

  return (
    <main className="app">
      <h1>GymHelper</h1>
      <p className="subtitle">Sign in to your account</p>

      <Form className="card login-form" onFormSubmit={handleSubmit}>
        <Field.Root name="username" className="field">
          <Field.Label>Username</Field.Label>
          <Input
            type="text"
            autoComplete="username"
            value={username}
            onValueChange={setUsername}
            required
          />
          <Field.Error className="field-error" match="valueMissing">
            Username is required.
          </Field.Error>
        </Field.Root>

        <Field.Root name="password" className="field">
          <Field.Label>Password</Field.Label>
          <Input
            type="password"
            autoComplete="current-password"
            value={password}
            onValueChange={setPassword}
            required
          />
          <Field.Error className="field-error" match="valueMissing">
            Password is required.
          </Field.Error>
        </Field.Root>

        {state === 'error' && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <Button type="submit" disabled={state === 'submitting'}>
          {state === 'submitting' ? 'Signing in…' : 'Sign in'}
        </Button>
      </Form>
    </main>
  )
}

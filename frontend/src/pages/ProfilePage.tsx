import { useState } from 'react'
import { Button } from '@base-ui/react/button'
import { Field } from '@base-ui/react/field'
import { Form } from '@base-ui/react/form'
import { Input } from '@base-ui/react/input'
import { Separator } from '@base-ui/react/separator'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'

type ChangePwState = 'idle' | 'submitting' | 'success' | 'error'

export default function ProfilePage() {
  const { user, logout } = useAuth()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [pwState, setPwState] = useState<ChangePwState>('idle')
  const [message, setMessage] = useState('')

  if (!user) return null

  async function handleChangePassword() {
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
      {/* Navigation, so a real link — Base UI's Button would impose button semantics. */}
      <Link className="back-link" to="/">
        Back
      </Link>
      <h1>Profile settings</h1>
      <p className="subtitle">Signed in as {user.username}</p>

      <Form className="card login-form" onFormSubmit={handleChangePassword}>
        <p className="label">Change password</p>

        <Field.Root name="currentPassword" className="field">
          <Field.Label>Current password</Field.Label>
          <Input
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onValueChange={setCurrentPassword}
            required
          />
          <Field.Error className="field-error" match="valueMissing">
            Current password is required.
          </Field.Error>
        </Field.Root>

        <Field.Root name="newPassword" className="field">
          <Field.Label>New password</Field.Label>
          <Input
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onValueChange={setNewPassword}
            required
          />
          <Field.Error className="field-error" match="valueMissing">
            New password is required.
          </Field.Error>
        </Field.Root>

        {pwState === 'error' && (
          <p className="error" role="alert">
            {message}
          </p>
        )}
        {pwState === 'success' && (
          <p className="success" role="status">
            {message}
          </p>
        )}

        <Button type="submit" disabled={pwState === 'submitting'}>
          {pwState === 'submitting' ? 'Saving…' : 'Change password'}
        </Button>
      </Form>

      <Separator className="separator" />

      {/* Clearing the user sends the route guard back to /login. */}
      <Button type="button" className="logout-button" onClick={logout}>
        Log out
      </Button>
    </main>
  )
}

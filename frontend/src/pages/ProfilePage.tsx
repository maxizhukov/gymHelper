import { useEffect, useState } from 'react'
import { Button } from '@base-ui/react/button'
import { Field } from '@base-ui/react/field'
import { Form } from '@base-ui/react/form'
import { Input } from '@base-ui/react/input'
import { NumberField } from '@base-ui/react/number-field'
import { Separator } from '@base-ui/react/separator'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { saveTrainingConfig, useTrainingConfig } from '../training-config'
import BackHeader from '../components/BackHeader'

type ChangePwState = 'idle' | 'submitting' | 'success' | 'error'
type ConfigState = 'idle' | 'submitting' | 'success' | 'error'

/**
 * Profile settings body, without any screen chrome, so it can sit as the
 * Profile tab inside the app shell and as a standalone routed screen.
 */
export function ProfileContent() {
  const { user, logout } = useAuth()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [pwState, setPwState] = useState<ChangePwState>('idle')
  const [message, setMessage] = useState('')

  const config = useTrainingConfig()
  // Null is what NumberField reports for an empty input, so the form fields
  // start empty and are filled in once the saved config arrives.
  const [restPeriod, setRestPeriod] = useState<number | null>(null)
  const [reps, setReps] = useState<number | null>(null)
  const [setsPerExercise, setSetsPerExercise] = useState<number | null>(null)
  const [configState, setConfigState] = useState<ConfigState>('idle')
  const [configMessage, setConfigMessage] = useState('')

  useEffect(() => {
    if (config.status !== 'ready') return
    setRestPeriod(config.data.restPeriod)
    setReps(config.data.reps)
    setSetsPerExercise(config.data.setsPerExercise)
  }, [config])

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

  async function handleSaveConfig() {
    // The browser blocks an empty required field, but a null here would still
    // serialize as JSON `null` and be rejected by the server — stop it first.
    if (restPeriod === null || reps === null || setsPerExercise === null) {
      setConfigState('error')
      setConfigMessage('All settings are required.')
      return
    }

    setConfigState('submitting')
    setConfigMessage('')

    try {
      // Trust the response over what was typed: the server is the source of truth.
      const saved = await saveTrainingConfig({
        restPeriod,
        reps,
        setsPerExercise,
      })
      setRestPeriod(saved.restPeriod)
      setReps(saved.reps)
      setSetsPerExercise(saved.setsPerExercise)
      setConfigState('success')
      setConfigMessage('Training settings saved.')
    } catch (err) {
      setConfigState('error')
      setConfigMessage(
        err instanceof Error ? err.message : 'Could not save settings.',
      )
    }
  }

  return (
    <div className="dash">
      <div className="page-head">
        <h1 className="page-title">Profile</h1>
        <p className="page-sub">Signed in as {user.username}</p>
      </div>

      {config.status === 'loading' && (
        <div className="card">
          <p className="label">Training settings</p>
          <p className="subtitle">Loading…</p>
        </div>
      )}

      {config.status === 'error' && (
        <div className="card status-error">
          <p className="label">Training settings</p>
          <p className="error" role="alert">
            {config.message}
          </p>
        </div>
      )}

      {config.status === 'ready' && (
        <Form className="card settings-form" onFormSubmit={handleSaveConfig}>
          <p className="label">Training settings</p>

          <Field.Root name="restPeriod" className="field">
            <Field.Label>Rest period (seconds)</Field.Label>
            <NumberField.Root
              value={restPeriod}
              onValueChange={setRestPeriod}
              min={0}
              max={3600}
              step={5}
              required
            >
              <NumberField.Group className="number-field-group">
                <NumberField.Decrement
                  className="number-field-button"
                  aria-label="Decrease rest period"
                >
                  −
                </NumberField.Decrement>
                <NumberField.Input />
                <NumberField.Increment
                  className="number-field-button"
                  aria-label="Increase rest period"
                >
                  +
                </NumberField.Increment>
              </NumberField.Group>
            </NumberField.Root>
            <Field.Error className="field-error" match="valueMissing">
              Rest period is required.
            </Field.Error>
          </Field.Root>

          <Field.Root name="reps" className="field">
            <Field.Label>Reps per set</Field.Label>
            <NumberField.Root
              value={reps}
              onValueChange={setReps}
              min={1}
              max={100}
              step={1}
              required
            >
              <NumberField.Group className="number-field-group">
                <NumberField.Decrement
                  className="number-field-button"
                  aria-label="Decrease reps"
                >
                  −
                </NumberField.Decrement>
                <NumberField.Input />
                <NumberField.Increment
                  className="number-field-button"
                  aria-label="Increase reps"
                >
                  +
                </NumberField.Increment>
              </NumberField.Group>
            </NumberField.Root>
            <Field.Error className="field-error" match="valueMissing">
              Reps is required.
            </Field.Error>
          </Field.Root>

          <Field.Root name="setsPerExercise" className="field">
            <Field.Label>Sets per exercise</Field.Label>
            <NumberField.Root
              value={setsPerExercise}
              onValueChange={setSetsPerExercise}
              min={1}
              max={20}
              step={1}
              required
            >
              <NumberField.Group className="number-field-group">
                <NumberField.Decrement
                  className="number-field-button"
                  aria-label="Decrease sets per exercise"
                >
                  −
                </NumberField.Decrement>
                <NumberField.Input />
                <NumberField.Increment
                  className="number-field-button"
                  aria-label="Increase sets per exercise"
                >
                  +
                </NumberField.Increment>
              </NumberField.Group>
            </NumberField.Root>
            <Field.Error className="field-error" match="valueMissing">
              Sets per exercise is required.
            </Field.Error>
          </Field.Root>

          {configState === 'error' && (
            <p className="error" role="alert">
              {configMessage}
            </p>
          )}
          {configState === 'success' && (
            <p className="success" role="status">
              {configMessage}
            </p>
          )}

          <Button type="submit" disabled={configState === 'submitting'}>
            {configState === 'submitting' ? 'Saving…' : 'Save settings'}
          </Button>
        </Form>
      )}

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

      <p className="auth-version" style={{ textAlign: 'center' }}>
        v{__APP_VERSION__}
      </p>
    </div>
  )
}

/** Standalone routed Profile screen (`/profile`), with a back header to Home. */
export default function ProfilePage() {
  const navigate = useNavigate()
  return (
    <div className="screen">
      <BackHeader title="Profile" onBack={() => void navigate('/')} />
      <div className="screen-scroll has-header">
        <ProfileContent />
      </div>
    </div>
  )
}

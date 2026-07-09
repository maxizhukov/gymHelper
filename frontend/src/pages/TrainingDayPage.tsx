import { useState } from 'react'
import { Button } from '@base-ui/react/button'
import { Separator } from '@base-ui/react/separator'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { useTrainingDay } from '../training-days'
import { startWorkout, useActiveWorkout } from '../workout'

export default function TrainingDayPage() {
  const { user } = useAuth()
  const { slug } = useParams<{ slug: string }>()
  const trainingDay = useTrainingDay(slug)
  const activeWorkout = useActiveWorkout()
  const navigate = useNavigate()
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState('')

  if (!user) return null
  // An unknown day in the URL is not an error the user can act on — send them home.
  if (trainingDay.status === 'not-found') return <Navigate to="/" replace />

  if (trainingDay.status === 'loading') {
    return (
      <main className="app">
        {/* Navigation, so a real link — Base UI's Button would impose button semantics. */}
        <Link className="back-link" to="/">
          Back
        </Link>
        <p className="subtitle">Loading…</p>
      </main>
    )
  }

  if (trainingDay.status === 'error') {
    return (
      <main className="app">
        <Link className="back-link" to="/">
          Back
        </Link>
        <p className="error" role="alert">
          {trainingDay.message}
        </p>
      </main>
    )
  }

  const { day, focus, exerciseGroups } = trainingDay.data

  async function handleStart() {
    if (!slug) return
    setStarting(true)
    setStartError('')
    try {
      // The server creates the session and stamps the start time; we navigate to
      // the id it assigned, so reloading that URL restores the same workout.
      const { workout } = await startWorkout(slug)
      void navigate(`/workout/${workout.id}`)
    } catch (err) {
      setStarting(false)
      setStartError(
        err instanceof Error ? err.message : 'Could not start the workout.',
      )
    }
  }

  // An unfinished workout blocks starting another (the server enforces it), so
  // offer to resume: this day's workout, or whichever one is actually running.
  const active = activeWorkout.status === 'ready' ? activeWorkout.data : null
  const resumable = active && active.daySlug === slug ? active : null
  const otherActive = active && active.daySlug !== slug ? active : null

  // Numbering runs across the whole workout, so each group starts where the
  // previous one ended rather than restarting at 1.
  let numberedFrom = 1

  return (
    <main className="app">
      <Link className="back-link" to="/">
        Back
      </Link>
      <h1>{day}</h1>
      <p className="subtitle">{focus}</p>

      {/* Held back until the active-workout check lands, so the button never
          flips from "Start" to "Resume" under a thumb already moving. */}
      {exerciseGroups.length > 0 && activeWorkout.status === 'ready' && (
        <div className="workout-start">
          {resumable && (
            <Link className="workout-action" to={`/workout/${resumable.id}`}>
              Resume workout
            </Link>
          )}

          {otherActive && (
            <>
              <p className="workout-start-note">
                A {otherActive.dayName} workout is still in progress.
              </p>
              <Link
                className="workout-action"
                to={`/workout/${otherActive.id}`}
              >
                Resume {otherActive.dayName} workout
              </Link>
            </>
          )}

          {!active && (
            <Button
              type="button"
              className="workout-action"
              disabled={starting}
              onClick={() => void handleStart()}
            >
              {starting ? 'Starting…' : 'Start workout'}
            </Button>
          )}

          {startError && (
            <p className="error" role="alert">
              {startError}
            </p>
          )}
        </div>
      )}

      {exerciseGroups.length === 0 ? (
        <p className="subtitle">No exercises planned for this day yet.</p>
      ) : (
        <section className="exercise-groups" aria-label="Exercises">
          {exerciseGroups.map((exercises, groupIndex) => {
            const start = numberedFrom
            numberedFrom += exercises.length

            return (
              <div key={start} className="exercise-group">
                {groupIndex > 0 && <Separator className="separator" />}
                <ol className="exercise-list" start={start}>
                  {exercises.map((exercise) => (
                    <li key={exercise} className="exercise-item">
                      {exercise}
                    </li>
                  ))}
                </ol>
              </div>
            )
          })}
        </section>
      )}
    </main>
  )
}

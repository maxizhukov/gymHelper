import { Separator } from '@base-ui/react/separator'
import { Link, Navigate, useParams } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { useTrainingDay } from '../training-days'

export default function TrainingDayPage() {
  const { user } = useAuth()
  const { slug } = useParams<{ slug: string }>()
  const trainingDay = useTrainingDay(slug)

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

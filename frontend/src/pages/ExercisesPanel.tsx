import { useExerciseLibrary, type LibraryExercise } from '../exercise-library'

/** A group of exercises sharing a category and muscle group, kept in order. */
type ExerciseGroup = {
  key: string
  category: string
  muscleGroup: string
  exercises: LibraryExercise[]
}

/**
 * Groups the already-sorted library (category → muscle group → name) into
 * headed sections without disturbing the server's ordering. Rows arrive sorted,
 * so a new group begins whenever the category or muscle group changes.
 */
function groupExercises(exercises: LibraryExercise[]): ExerciseGroup[] {
  const groups: ExerciseGroup[] = []
  for (const exercise of exercises) {
    const category = exercise.category ?? 'Uncategorized'
    const muscleGroup = exercise.muscleGroup ?? 'Other'
    const last = groups[groups.length - 1]
    if (!last || last.category !== category || last.muscleGroup !== muscleGroup) {
      groups.push({
        key: `${category}—${muscleGroup}`,
        category,
        muscleGroup,
        exercises: [exercise],
      })
    } else {
      last.exercises.push(exercise)
    }
  }
  return groups
}

/** One exercise card: its name and the details we have for it. */
function ExerciseRow({ exercise }: { exercise: LibraryExercise }) {
  const details = [
    exercise.equipment,
    exercise.movementPattern,
    exercise.difficulty,
  ].filter((detail): detail is string => Boolean(detail))

  return (
    <li className="card exercise-card">
      <p className="label">{exercise.name}</p>
      {details.length > 0 && (
        <p className="message">{details.join(' · ')}</p>
      )}
    </li>
  )
}

/**
 * The Exercises tab. The catalogue of movements lives in Postgres and is read
 * from `/api/exercises`; this component only groups and renders the sorted list.
 * For now it is read-only — later these will connect to training plans so an
 * exercise in a workout can be swapped for another from here.
 */
export default function ExercisesPanel() {
  const library = useExerciseLibrary()

  if (library.status === 'loading') return <p className="subtitle">Loading…</p>
  if (library.status === 'error') {
    return (
      <p className="error" role="alert">
        {library.message}
      </p>
    )
  }
  if (library.status === 'not-found') return null

  if (library.data.length === 0) {
    return (
      <div className="card stats-empty">
        <p className="label">No exercises yet</p>
        <p className="message">The exercise library is empty.</p>
      </div>
    )
  }

  const groups = groupExercises(library.data)

  return (
    <div className="exercise-library">
      {groups.map((group) => (
        <section
          key={group.key}
          className="exercise-group"
          aria-label={`${group.category} — ${group.muscleGroup}`}
        >
          <h3 className="exercise-group-heading">
            {group.category} · {group.muscleGroup}
          </h3>
          <ul className="exercise-list">
            {group.exercises.map((exercise) => (
              <ExerciseRow key={exercise.id} exercise={exercise} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

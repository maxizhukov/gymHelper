import { useState } from 'react'
import { useExerciseLibrary, type LibraryExercise } from '../exercise-library'

/**
 * Turns a YouTube URL (watch, youtu.be, shorts, or already-embed form) into an
 * embeddable URL. Returns null when the URL isn't a recognizable YouTube link,
 * so the detail view can fall back to a plain link instead of a broken iframe.
 */
function youTubeEmbedUrl(url: string | null): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.replace(/^www\./, '')
    let id: string | null = null
    if (host === 'youtu.be') {
      id = parsed.pathname.slice(1)
    } else if (host === 'youtube.com' || host === 'm.youtube.com') {
      if (parsed.pathname === '/watch') {
        id = parsed.searchParams.get('v')
      } else if (parsed.pathname.startsWith('/embed/')) {
        id = parsed.pathname.slice('/embed/'.length)
      } else if (parsed.pathname.startsWith('/shorts/')) {
        id = parsed.pathname.slice('/shorts/'.length)
      }
    }
    if (!id) return null
    id = id.split('/')[0]
    return /^[\w-]{6,}$/.test(id) ? `https://www.youtube.com/embed/${id}` : null
  } catch {
    return null
  }
}

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

/** The muscle-group / category tags shown on the card summary. */
function summaryLine(exercise: LibraryExercise): string {
  return [exercise.category, exercise.muscleGroup]
    .filter((part): part is string => Boolean(part))
    .join(' · ')
}

/** The detail body revealed when a card is expanded. */
function ExerciseDetail({ exercise }: { exercise: LibraryExercise }) {
  const embedUrl = youTubeEmbedUrl(exercise.videoUrl)
  const details = [
    exercise.equipment,
    exercise.movementPattern,
    exercise.difficulty,
  ].filter((detail): detail is string => Boolean(detail))

  return (
    <div className="exercise-detail">
      {details.length > 0 && (
        <p className="message exercise-detail-tags">{details.join(' · ')}</p>
      )}
      {exercise.descriptionRu && (
        <p className="exercise-detail-description">{exercise.descriptionRu}</p>
      )}
      {embedUrl && (
        <div className="exercise-video">
          <iframe
            src={embedUrl}
            title={`${exercise.name} video`}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            loading="lazy"
          />
        </div>
      )}
      {exercise.sourceUrl && (
        <a
          className="exercise-source"
          href={exercise.sourceUrl}
          target="_blank"
          rel="noreferrer"
        >
          Source
        </a>
      )}
    </div>
  )
}

/** One exercise card: a thumbnail-led summary that expands to full details. */
function ExerciseRow({ exercise }: { exercise: LibraryExercise }) {
  const [expanded, setExpanded] = useState(false)
  const summary = summaryLine(exercise)

  return (
    <li className="card exercise-card">
      <button
        type="button"
        className="exercise-card-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {exercise.thumbnailUrl && (
          <img
            className="exercise-thumbnail"
            src={exercise.thumbnailUrl}
            alt=""
            loading="lazy"
          />
        )}
        <span className="exercise-card-heading">
          <span className="label">{exercise.name}</span>
          {summary && <span className="message">{summary}</span>}
        </span>
      </button>
      {expanded && <ExerciseDetail exercise={exercise} />}
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

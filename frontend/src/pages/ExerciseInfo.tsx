import { useState } from 'react'
import { Button } from '@base-ui/react/button'
import type { LibraryExercise } from '../exercise-library'

/**
 * The compact, collapsible details of one library exercise — a preview image,
 * the technique note, the video, and a source link. Shared by the workout screen
 * (as "Technique") and the pre-workout preview (as "Details"), so both render an
 * exercise's information exactly the same way.
 *
 * The video player is not mounted until "Watch video" is tapped, so an opened
 * panel that is only read costs no video load.
 */
export function ExerciseInfoDetail({ exercise }: { exercise: LibraryExercise }) {
  const [showVideo, setShowVideo] = useState(false)
  const embedUrl = exercise.videoUrl ? youtubeEmbedUrl(exercise.videoUrl) : null

  return (
    <>
      {exercise.thumbnailUrl && (
        <img
          className="exercise-info-thumb"
          src={exercise.thumbnailUrl}
          alt=""
          loading="lazy"
        />
      )}

      {exercise.descriptionRu && (
        <p className="exercise-info-description">{exercise.descriptionRu}</p>
      )}

      {exercise.videoUrl && showVideo && embedUrl && (
        <div className="exercise-info-video">
          <iframe
            src={embedUrl}
            title="Exercise video"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        </div>
      )}

      {exercise.videoUrl &&
        !(showVideo && embedUrl) &&
        (embedUrl ? (
          <Button
            type="button"
            className="exercise-info-watch"
            onClick={() => setShowVideo(true)}
          >
            Watch video
          </Button>
        ) : (
          // Not a recognisable YouTube link: hand it off to a new tab rather
          // than trying to embed something that will not play inline.
          <a
            className="exercise-info-watch"
            href={exercise.videoUrl}
            target="_blank"
            rel="noreferrer"
          >
            Watch video
          </a>
        ))}

      {exercise.sourceUrl && (
        <a
          className="exercise-info-source"
          href={exercise.sourceUrl}
          target="_blank"
          rel="noreferrer"
        >
          Source
        </a>
      )}
    </>
  )
}

/** Whether an exercise carries anything worth expanding the panel to read. */
export function hasExerciseInfo(exercise: LibraryExercise): boolean {
  return Boolean(
    exercise.descriptionRu ||
      exercise.thumbnailUrl ||
      exercise.videoUrl ||
      exercise.sourceUrl,
  )
}

/**
 * A YouTube watch/share URL in its embeddable form, or null when the link is not
 * a recognisable YouTube one — the caller then offers a plain link instead.
 */
function youtubeEmbedUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.replace(/^www\./, '')
    if (host === 'youtu.be') {
      const id = parsed.pathname.slice(1)
      return id ? `https://www.youtube.com/embed/${id}` : null
    }
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      const id = parsed.searchParams.get('v')
      return id ? `https://www.youtube.com/embed/${id}` : null
    }
    return null
  } catch {
    return null
  }
}

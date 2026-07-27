import { useState } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { formatTrainingTime, formatVolume } from '../stats'
import {
  formatShortDate,
  formatWeight,
  useCompletedWorkoutDetail,
  useCompletedWorkouts,
  type CompletedWorkoutDetail,
  type CompletedWorkoutDetailExercise,
  type CompletedWorkoutDetailSet,
  type CompletedWorkoutListItem,
  type WorkoutAiSummary,
  type WorkoutAssessment,
} from '../workout'

/** What the AI assessment badge reads for each verdict. */
const ASSESSMENT_LABEL: Record<WorkoutAssessment, string> = {
  better: 'Better than last time',
  similar: 'On par with last time',
  worse: 'Down on last time',
  first: 'First session',
}

/**
 * The Training History screen: every completed workout, newest first, each with
 * its totals and the AI highlights that were saved after it finished. The list
 * only reads saved summaries — it never generates one — so opening it costs no
 * OpenAI call. Tapping a workout opens its full detail, where a summary can be
 * (re)generated explicitly.
 */
export default function TrainingHistoryPanel() {
  const state = useCompletedWorkouts()
  const [openId, setOpenId] = useState<number | null>(null)

  return (
    <div className="dash">
      <div className="page-head">
        <h1 className="page-title">Training History</h1>
        <p className="page-sub">Your completed workouts and their AI highlights.</p>
      </div>

      {state.status === 'loading' && <p className="subtitle">Loading…</p>}
      {state.status === 'error' && (
        <p className="error" role="alert">
          {state.message}
        </p>
      )}

      {state.status === 'ready' && state.data.length === 0 && (
        <div className="card stats-empty">
          <p className="label">No completed trainings yet</p>
          <p className="message">Finish a workout to see it here.</p>
        </div>
      )}

      {state.status === 'ready' && state.data.length > 0 && (
        <ul className="history-list" aria-label="Completed workouts">
          {state.data.map((workout) => (
            <li key={workout.id}>
              <HistoryCard workout={workout} onOpen={() => setOpenId(workout.id)} />
            </li>
          ))}
        </ul>
      )}

      <WorkoutHistoryDetailModal
        workoutId={openId}
        onClose={() => setOpenId(null)}
      />
    </div>
  )
}

/** One compact card in the history list: totals plus a small AI highlight. */
function HistoryCard({
  workout,
  onOpen,
}: {
  workout: CompletedWorkoutListItem
  onOpen: () => void
}) {
  return (
    <button type="button" className="history-card" onClick={onOpen}>
      <div className="history-card-head">
        <div className="history-card-heading">
          <p className="history-card-day">{workout.dayName}</p>
          {workout.planName && (
            <p className="history-card-plan">{workout.planName}</p>
          )}
        </div>
        <span className="history-card-date">
          {formatShortDate(workout.completedAt)}
        </span>
      </div>

      <div className="history-card-stats">
        <span>
          {workout.exerciseCount} exercise
          {workout.exerciseCount === 1 ? '' : 's'}
        </span>
        <span>
          {workout.setCount} set{workout.setCount === 1 ? '' : 's'}
        </span>
        {workout.totalVolume > 0 && <span>{formatVolume(workout.totalVolume)}</span>}
        {workout.durationSeconds !== null && (
          <span>{formatTrainingTime(workout.durationSeconds)}</span>
        )}
      </div>

      {workout.aiSummary ? (
        <div className="history-card-ai">
          <div className="history-card-ai-head">
            <span className="history-card-ai-kicker">AI highlights</span>
            <span className={`ai-badge ai-badge-${workout.aiSummary.assessment}`}>
              {ASSESSMENT_LABEL[workout.aiSummary.assessment]}
            </span>
          </div>
          <p className="history-card-ai-headline">
            {workout.aiSummary.headline}
          </p>
          {workout.aiSummary.summary && (
            <p className="history-card-ai-summary">{workout.aiSummary.summary}</p>
          )}
        </div>
      ) : (
        <p className="history-card-ai-empty">
          No AI summary saved for this workout
        </p>
      )}
    </button>
  )
}

/**
 * The full detail of one completed workout, in a bottom-sheet modal: its totals,
 * the saved AI summary (or an offer to generate one), and every exercise with the
 * sets logged against it. History is fetched only while the sheet is open.
 */
function WorkoutHistoryDetailModal({
  workoutId,
  onClose,
}: {
  workoutId: number | null
  onClose: () => void
}) {
  const { state, regenerate } = useCompletedWorkoutDetail(workoutId)

  const title =
    state.status === 'ready' ? state.data.detail.dayName : 'Workout'

  return (
    <Dialog.Root
      open={workoutId !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Popup
          className="dialog-popup exercise-history-modal"
          aria-label={`Workout: ${title}`}
        >
          <div className="exercise-history-head">
            <div className="exercise-history-heading">
              <p className="label">Training history</p>
              <h2 className="exercise-history-title">{title}</h2>
            </div>
            <Dialog.Close
              className="exercise-history-close"
              aria-label="Close workout"
            >
              ✕
            </Dialog.Close>
          </div>

          <div className="exercise-history-body">
            {state.status === 'loading' && (
              <p className="history-note">Loading…</p>
            )}
            {state.status === 'error' && (
              <p className="error" role="alert">
                {state.message}
              </p>
            )}
            {state.status === 'not-found' && (
              <p className="history-note">This workout could not be found.</p>
            )}
            {state.status === 'ready' && (
              <DetailContent
                detail={state.data.detail}
                summary={state.data.summary}
                regenerate={regenerate}
              />
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** The detail body: totals, the AI summary, then the exercises and their sets. */
function DetailContent({
  detail,
  summary,
  regenerate,
}: {
  detail: CompletedWorkoutDetail
  summary: WorkoutAiSummary | null
  regenerate: () => Promise<void>
}) {
  return (
    <>
      <dl className="exercise-history-summary">
        <div className="exercise-history-stat">
          <dt className="label">Date</dt>
          <dd className="exercise-history-stat-value">
            {formatShortDate(detail.completedAt)}
          </dd>
        </div>
        <div className="exercise-history-stat">
          <dt className="label">Duration</dt>
          <dd className="exercise-history-stat-value">
            {detail.durationSeconds !== null
              ? formatTrainingTime(detail.durationSeconds)
              : '—'}
          </dd>
        </div>
        <div className="exercise-history-stat">
          <dt className="label">Volume</dt>
          <dd className="exercise-history-stat-value">
            {formatVolume(detail.totalVolume)}
          </dd>
        </div>
        <div className="exercise-history-stat">
          <dt className="label">Sets</dt>
          <dd className="exercise-history-stat-value">
            {detail.exerciseCount} ex · {detail.setCount} sets
          </dd>
        </div>
      </dl>

      <SavedSummary summary={summary} regenerate={regenerate} />

      <section className="exercise-history-sessions" aria-label="Exercises">
        <p className="history-heading">Exercises</p>
        <ul className="exercise-history-list">
          {detail.exercises.map((exercise, index) => (
            <ExerciseRow key={index} exercise={exercise} />
          ))}
        </ul>
      </section>
    </>
  )
}

/**
 * The saved AI summary, or — when none was saved — a note plus a single button
 * that generates one on request. Both the button and the "Regenerate" control
 * call the explicit regenerate endpoint; nothing here generates automatically.
 */
function SavedSummary({
  summary,
  regenerate,
}: {
  summary: WorkoutAiSummary | null
  regenerate: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function handleRegenerate() {
    setBusy(true)
    setError('')
    try {
      await regenerate()
    } catch {
      setError('Could not generate the summary. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  if (!summary) {
    return (
      <section className="ai-summary" aria-label="AI summary">
        <p className="ai-summary-kicker">AI Summary</p>
        <p className="history-note">No AI summary saved for this workout.</p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button
          type="button"
          className="ai-summary-regenerate"
          disabled={busy}
          onClick={() => void handleRegenerate()}
        >
          {busy ? 'Generating…' : 'Generate summary'}
        </button>
      </section>
    )
  }

  return (
    <section className="ai-summary" aria-label="AI summary">
      <p className="ai-summary-kicker">AI Summary</p>

      <span className={`ai-badge ai-badge-${summary.assessment}`}>
        {ASSESSMENT_LABEL[summary.assessment]}
      </span>

      <h2 className="ai-summary-headline">{summary.headline}</h2>
      <p className="ai-summary-text">{summary.summary}</p>

      {summary.status === 'unavailable' && (
        <p className="ai-summary-note">
          The AI coach note is unavailable right now — the numbers above are
          still your real results.
        </p>
      )}

      {summary.improvements.length > 0 && (
        <SummaryChips heading="Improved" items={summary.improvements} tone="up" />
      )}
      {summary.declines.length > 0 && (
        <SummaryChips heading="Watch" items={summary.declines} tone="down" />
      )}

      {summary.exerciseNotes.length > 0 && (
        <ul className="ai-summary-notes">
          {summary.exerciseNotes.map((note, index) => (
            <li key={index}>{note}</li>
          ))}
        </ul>
      )}

      {summary.trendNote && (
        <p className="ai-summary-trend-note">{summary.trendNote}</p>
      )}
      {summary.effortNote && (
        <p className="ai-summary-effort-note">{summary.effortNote}</p>
      )}

      {summary.recommendation && (
        <p className="ai-recommendation">
          <span className="ai-recommendation-label">Next time</span>
          {summary.recommendation}
        </p>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <button
        type="button"
        className="ai-summary-regenerate"
        disabled={busy}
        onClick={() => void handleRegenerate()}
      >
        {busy ? 'Regenerating…' : 'Regenerate summary'}
      </button>
    </section>
  )
}

/** One exercise: its name, its sets as chips, and its work-set volume. */
function ExerciseRow({
  exercise,
}: {
  exercise: CompletedWorkoutDetailExercise
}) {
  return (
    <li className="card exercise-history-session">
      <div className="exercise-history-session-head">
        <span className="exercise-history-session-date">{exercise.name}</span>
      </div>

      <div className="exercise-history-chips">
        {exercise.sets.map((set) => (
          <SetChip key={set.setNumber} set={set} />
        ))}
      </div>

      {exercise.totalVolume > 0 && (
        <div className="exercise-history-session-foot">
          <span>
            Volume{' '}
            <strong>
              {Math.round(exercise.totalVolume).toLocaleString()} kg
            </strong>
          </span>
        </div>
      )}
    </li>
  )
}

/** One set as a chip: weight × reps, warmups dimmed, effort in the tooltip. */
function SetChip({ set }: { set: CompletedWorkoutDetailSet }) {
  const effort = [
    set.rir !== null ? `RIR ${set.rir}` : null,
    set.rpe !== null ? `RPE ${set.rpe}` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <span
      className={`exercise-history-chip${
        set.isWarmup ? ' exercise-history-chip-warmup' : ''
      }`}
      title={effort || undefined}
    >
      {formatWeight(set.weight)}×{set.reps}
      {set.isWarmup && <span className="exercise-history-chip-tag">warm</span>}
    </span>
  )
}

/** A titled row of small chips — improvements or things to watch. */
function SummaryChips({
  heading,
  items,
  tone,
}: {
  heading: string
  items: string[]
  tone: 'up' | 'down'
}) {
  return (
    <div className="ai-chips">
      <p className="label">{heading}</p>
      <div className="ai-chip-row">
        {items.map((item, index) => (
          <span className={`ai-chip ai-chip-${tone}`} key={index}>
            {item}
          </span>
        ))}
      </div>
    </div>
  )
}

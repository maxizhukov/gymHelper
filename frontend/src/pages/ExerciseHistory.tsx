import { Dialog } from '@base-ui/react/dialog'
import {
  formatE1rm,
  formatRelativeDay,
  formatShortDate,
  formatWeight,
  useFullExerciseHistory,
  type FullExerciseHistory,
  type FullHistorySession,
  type FullHistorySet,
} from '../workout'

/**
 * The reusable exercise-history view, shown as a bottom-sheet modal. It opens
 * outside an active workout — from the Exercise Library, the Training Builder,
 * and a past workout's detail — and reads the same server-aggregated history
 * the Previous Performance panel does, but in full: every past session with its
 * sets, volume, best set and estimated 1RM, plus a compact volume trend.
 *
 * It resolves by `exerciseLibraryId` when there is one, and falls back to the
 * exercise name otherwise, so a legacy-plan reference still renders. History is
 * fetched only while the sheet is open, so a closed one costs no request.
 */
export function ExerciseHistoryModal({
  open,
  onOpenChange,
  exerciseName,
  exerciseLibraryId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  exerciseName: string
  exerciseLibraryId: number | null
}) {
  const state = useFullExerciseHistory(exerciseName, exerciseLibraryId, open)
  const title =
    state.status === 'ready' && state.data.exerciseName
      ? state.data.exerciseName
      : exerciseName

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Popup
          className="dialog-popup exercise-history-modal"
          aria-label={`History: ${exerciseName}`}
        >
          <div className="exercise-history-head">
            <div className="exercise-history-heading">
              <p className="label">Exercise history</p>
              <h2 className="exercise-history-title">{title}</h2>
            </div>
            <Dialog.Close
              className="exercise-history-close"
              aria-label="Close history"
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
            {(state.status === 'not-found' ||
              (state.status === 'ready' && state.data.sessions.length === 0)) && (
              <p className="history-note exercise-history-empty">
                No history yet for this exercise.
              </p>
            )}
            {state.status === 'ready' && state.data.sessions.length > 0 && (
              <HistoryContent history={state.data} />
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** The summary, the trend chart, and the scrollable session list. */
function HistoryContent({ history }: { history: FullExerciseHistory }) {
  return (
    <>
      <dl className="exercise-history-summary">
        <div className="exercise-history-stat">
          <dt className="label">Times trained</dt>
          <dd className="exercise-history-stat-value">{history.timesTrained}</dd>
        </div>
        <div className="exercise-history-stat">
          <dt className="label">Last trained</dt>
          <dd className="exercise-history-stat-value">
            {history.lastTrainedAt
              ? formatRelativeDay(history.lastTrainedAt)
              : '—'}
          </dd>
        </div>
        <div className="exercise-history-stat">
          <dt className="label">Best weight</dt>
          <dd className="exercise-history-stat-value">
            {history.bestWeight
              ? `${formatWeight(history.bestWeight.weight)} kg × ${history.bestWeight.reps}`
              : '—'}
          </dd>
        </div>
        <div className="exercise-history-stat">
          <dt className="label">Best est. 1RM</dt>
          <dd className="exercise-history-stat-value">
            {history.bestE1rm !== null ? `${formatE1rm(history.bestE1rm)} kg` : '—'}
          </dd>
        </div>
      </dl>

      {/* Volume over time, one bar per session — a trend at a glance. Shown only
          once there is more than one session to compare. */}
      {history.trend.length > 1 && <VolumeTrend history={history} />}

      <section
        className="exercise-history-sessions"
        aria-label="Session history"
      >
        <p className="history-heading">Session history</p>
        <ul className="exercise-history-list">
          {history.sessions.map((session) => (
            <SessionRow key={session.workoutId} session={session} />
          ))}
        </ul>
      </section>
    </>
  )
}

/** A compact bar chart of total volume across the returned sessions. */
function VolumeTrend({ history }: { history: FullExerciseHistory }) {
  const points = history.trend
  const max = Math.max(...points.map((point) => point.totalVolume), 1)

  return (
    <div className="ai-trend exercise-history-trend">
      <p className="label">Volume trend</p>
      <div className="ai-trend-bars">
        {points.map((point, index) => {
          const isLatest = index === points.length - 1
          const height = Math.max(4, Math.round((point.totalVolume / max) * 100))
          return (
            <div className="ai-trend-bar" key={`${point.date}-${index}`}>
              <span className="ai-trend-amount">
                {Math.round(point.totalVolume).toLocaleString()}
              </span>
              <span
                className={`ai-trend-fill${isLatest ? ' ai-trend-fill-current' : ''}`}
                style={{ height: `${height}%` }}
              />
              <span className="ai-trend-date">{formatShortDate(point.date)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** One past session: its date and day, its sets as chips, and its totals. */
function SessionRow({ session }: { session: FullHistorySession }) {
  return (
    <li className="card exercise-history-session">
      <div className="exercise-history-session-head">
        <span className="exercise-history-session-date">
          {formatShortDate(session.completedAt)}
        </span>
        <span className="exercise-history-session-day">{session.dayName}</span>
      </div>

      <div className="exercise-history-chips">
        {session.sets.map((set) => (
          <SetChip key={set.setNumber} set={set} />
        ))}
      </div>

      <div className="exercise-history-session-foot">
        <span>
          Volume{' '}
          <strong>{Math.round(session.totalVolume).toLocaleString()} kg</strong>
        </span>
        {session.bestSet && (
          <span>
            Best{' '}
            <strong>
              {formatWeight(session.bestSet.weight)} kg × {session.bestSet.reps}
              {session.bestSet.e1rm !== null
                ? ` · ${formatE1rm(session.bestSet.e1rm)} 1RM`
                : ''}
            </strong>
          </span>
        )}
      </div>
    </li>
  )
}

/** One set as a chip: weight × reps, warmups dimmed, effort in the tooltip. */
function SetChip({ set }: { set: FullHistorySet }) {
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

import {
  formatSignedKg,
  formatTrainingTime,
  formatVolume,
  trendOf,
  useStatsOverview,
  type PersonalRecord,
  type RecentWorkout,
} from '../stats'
import { formatRelativeDay, formatShortDate, formatWeight } from '../workout'

/** One number and its label. The building block of every summary below. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-cell">
      <p className="label">{label}</p>
      <p className="stat-value">{value}</p>
    </div>
  )
}

/** An arrow and a signed number. Direction only — no judgement about which way
 *  is good, because the app does not know whether the user is cutting or bulking. */
function Trend({ changeKg }: { changeKg: number }) {
  const trend = trendOf(changeKg)
  const arrow = trend === 'up' ? '▲' : trend === 'down' ? '▼' : '•'
  return (
    <span className="trend" data-trend={trend}>
      <span aria-hidden="true">{arrow}</span> {formatSignedKg(changeKg)} kg
    </span>
  )
}

function PersonalRecordRow({ record }: { record: PersonalRecord }) {
  return (
    <li className="stat-row">
      <div className="stat-row-main">
        <p className="stat-row-title">{record.exerciseName}</p>
        <p className="stat-row-note">
          Best set · {formatRelativeDay(record.achievedAt)}
        </p>
      </div>
      <div className="stat-row-figures">
        <p className="stat-row-value">
          {formatWeight(record.weightKg)} kg × {record.reps}
        </p>
        {/* An estimate off a bodyweight set is just 0, so it is not worth showing. */}
        {record.estimatedOneRepMaxKg > 0 && (
          <p className="stat-row-note">
            ≈{formatWeight(record.estimatedOneRepMaxKg)} kg 1RM
          </p>
        )}
      </div>
    </li>
  )
}

function RecentWorkoutRow({ workout }: { workout: RecentWorkout }) {
  return (
    <li className="stat-row">
      <div className="stat-row-main">
        <p className="stat-row-title">{workout.dayName}</p>
        <p className="stat-row-note">
          {formatShortDate(workout.completedAt)} ·{' '}
          {formatTrainingTime(workout.durationSeconds)} ·{' '}
          {workout.exerciseCount} exercises · {workout.setCount} sets
        </p>
      </div>
      <div className="stat-row-figures">
        <p className="stat-row-value">{formatVolume(workout.volumeKg)}</p>
        {workout.bodyWeightKg !== null && (
          <p className="stat-row-note">
            {formatWeight(workout.bodyWeightKg)} kg bw
          </p>
        )}
      </div>
    </li>
  )
}

/**
 * The Stats tab. Every figure here is computed by Postgres and read from
 * `/api/stats/overview` — the component formats numbers and does not derive
 * them.
 *
 * Only finished workouts count, so a user who has started workouts but never
 * completed one sees the empty state rather than a screen of zeros pretending
 * to be a summary.
 */
export default function StatsPanel() {
  const stats = useStatsOverview()

  if (stats.status === 'loading') return <p className="subtitle">Loading…</p>
  if (stats.status === 'error') {
    return (
      <p className="error" role="alert">
        {stats.message}
      </p>
    )
  }
  if (stats.status === 'not-found') return null

  const { week, consistency, bodyWeight, personalRecords, recentWorkouts } =
    stats.data

  // No completed workout has ever been recorded: every section below would be a
  // zero, which reads as "you trained nothing" rather than "nothing yet".
  if (recentWorkouts.length === 0) {
    return (
      <div className="card stats-empty">
        <p className="label">No stats yet</p>
        <p className="message">Finish a workout to see your stats here.</p>
      </div>
    )
  }

  return (
    <div className="stats">
      <section className="stats-section" aria-labelledby="stats-week-heading">
        <h3 id="stats-week-heading">This week</h3>
        <div className="stat-grid">
          <Stat label="Workouts" value={String(week.workouts)} />
          <Stat label="Training time" value={formatTrainingTime(week.seconds)} />
          <Stat label="Sets" value={String(week.sets)} />
          <Stat label="Volume" value={formatVolume(week.volumeKg)} />
        </div>
      </section>

      <section
        className="stats-section"
        aria-labelledby="stats-consistency-heading"
      >
        <h3 id="stats-consistency-heading">Consistency</h3>
        <div className="stat-grid">
          <Stat
            label="Day streak"
            value={
              consistency.currentStreakDays === 1
                ? '1 day'
                : `${consistency.currentStreakDays} days`
            }
          />
          <Stat
            label="This month"
            value={String(consistency.workoutsThisMonth)}
          />
          <Stat
            label="Avg / week"
            value={`${consistency.averageWorkoutsPerWeek}`}
          />
        </div>
      </section>

      <section className="stats-section" aria-labelledby="stats-weight-heading">
        <h3 id="stats-weight-heading">Body weight</h3>
        {bodyWeight === null ? (
          <div className="card stats-empty">
            <p className="message">
              No body weight recorded yet. Add one when you finish a workout.
            </p>
          </div>
        ) : (
          <div className="card stats-weight">
            <div>
              <p className="label">Latest</p>
              <p className="stat-value">
                {formatWeight(bodyWeight.latestKg)} kg
              </p>
              <p className="stat-row-note">
                {formatRelativeDay(bodyWeight.recordedAt)}
              </p>
            </div>
            <div className="stats-weight-change">
              <p className="label">30 days</p>
              {/* Both fields are set together by the API; narrowing both is what
                  proves it to the type checker, rather than asserting it. */}
              {bodyWeight.changeKg !== null && bodyWeight.changeSince !== null ? (
                <>
                  <Trend changeKg={bodyWeight.changeKg} />
                  <p className="stat-row-note">
                    since {formatShortDate(bodyWeight.changeSince)}
                  </p>
                </>
              ) : (
                <p className="stat-row-note">Not enough data</p>
              )}
            </div>
          </div>
        )}
      </section>

      <section className="stats-section" aria-labelledby="stats-pr-heading">
        <h3 id="stats-pr-heading">Personal records</h3>
        {personalRecords.length === 0 ? (
          <p className="subtitle">No sets logged yet.</p>
        ) : (
          <ul className="stat-list">
            {personalRecords.map((record) => (
              <PersonalRecordRow key={record.exerciseName} record={record} />
            ))}
          </ul>
        )}
      </section>

      <section className="stats-section" aria-labelledby="stats-recent-heading">
        <h3 id="stats-recent-heading">Recent workouts</h3>
        <ul className="stat-list">
          {recentWorkouts.map((workout) => (
            <RecentWorkoutRow key={workout.id} workout={workout} />
          ))}
        </ul>
      </section>
    </div>
  )
}

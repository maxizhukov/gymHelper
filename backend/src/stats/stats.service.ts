import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

/**
 * Workout statistics, derived entirely from the tables the workout flow already
 * writes. Read-only: this module owns no schema and creates no tables, so it
 * needs no bootstrap — it queries `workout_sessions`, `workout_sets` and
 * `workout_session_exercises` at request time.
 *
 * Only *completed* workouts count. An abandoned session is a workout the user
 * decided did not happen, and letting it inflate a streak or a volume total
 * would make every number here a little bit of a lie.
 *
 * Every window ("this week", "this month", "last 28 days") is resolved by
 * Postgres against `now()`, not by the browser: the database clock is the
 * authority for workout timing everywhere else in this app, and a phone with a
 * skewed clock must not be able to move a week boundary.
 *
 * `COUNT`/`SUM` return bigint and numeric, which `pg` hands back as *strings*.
 * Every aggregate below is cast (`::int`, `::float8`) so the JSON carries
 * numbers rather than quoted digits.
 */

/** How many personal records the panel lists. */
const PR_LIMIT = 6;

/** How many finished workouts the recent list shows. */
const RECENT_WORKOUT_LIMIT = 8;

/** Weeks averaged for "workouts per week"; 28 days is exactly four of them. */
const AVERAGE_WEEKS = 4;

/** Days of history read to compute the streak. Bounds an otherwise open scan. */
const STREAK_WINDOW_DAYS = 400;

/** Milliseconds in a day. Streak arithmetic is done on UTC midnights. */
const DAY_MS = 86_400_000;

export interface WeekSummary {
  workouts: number;
  /** Summed wall-clock duration of this week's workouts. */
  seconds: number;
  sets: number;
  /** Σ weight × reps, in kilograms. */
  volumeKg: number;
}

export interface Consistency {
  /** Consecutive calendar days trained, counting back from today. */
  currentStreakDays: number;
  workoutsThisMonth: number;
  /** Workouts per week over the last four weeks, to one decimal. */
  averageWorkoutsPerWeek: number;
}

export interface BodyWeightStats {
  latestKg: number;
  recordedAt: string;
  /** Change over the last 30 days; null until two measurements exist in it. */
  changeKg: number | null;
  /** When the compared-against measurement was taken. */
  changeSince: string | null;
}

export interface PersonalRecord {
  exerciseName: string;
  weightKg: number;
  reps: number;
  /** Epley: weight × (1 + reps / 30). Comparable across rep ranges. */
  estimatedOneRepMaxKg: number;
  achievedAt: string;
}

export interface RecentWorkout {
  id: number;
  dayName: string;
  completedAt: string;
  durationSeconds: number;
  exerciseCount: number;
  setCount: number;
  volumeKg: number;
  bodyWeightKg: number | null;
}

export interface StatsOverview {
  week: WeekSummary;
  consistency: Consistency;
  /** Null when the user has never recorded a body weight. */
  bodyWeight: BodyWeightStats | null;
  personalRecords: PersonalRecord[];
  recentWorkouts: RecentWorkout[];
}

@Injectable()
export class StatsService {
  constructor(private readonly db: DatabaseService) {}

  /** Everything the Stats tab renders, in one round of queries. */
  async getOverview(userId: number): Promise<StatsOverview> {
    const [week, consistency, bodyWeight, personalRecords, recentWorkouts] =
      await Promise.all([
        this.weekSummary(userId),
        this.consistency(userId),
        this.bodyWeight(userId),
        this.personalRecords(userId),
        this.recentWorkouts(userId),
      ]);

    return { week, consistency, bodyWeight, personalRecords, recentWorkouts };
  }

  /**
   * This week's totals. `date_trunc('week')` starts on Monday, which is what a
   * training week means to everyone who is not a calendar library.
   *
   * The sets are aggregated in their own CTE rather than joined onto the
   * sessions: one row per set would multiply each session's duration by its set
   * count and turn a 50-minute workout into an eight-hour one.
   */
  private async weekSummary(userId: number): Promise<WeekSummary> {
    const result = await this.db.query<{
      workouts: number;
      seconds: number;
      sets: number;
      volume: number;
    }>(
      `WITH week_sessions AS (
         SELECT id, started_at, completed_at
           FROM workout_sessions
          WHERE user_id = $1
            AND completed_at IS NOT NULL
            AND completed_at >= date_trunc('week', now())
       ),
       week_sets AS (
         SELECT ws.actual_weight, ws.actual_reps
           FROM workout_sets ws
          WHERE ws.workout_session_id IN (SELECT id FROM week_sessions)
       )
       SELECT
         (SELECT COUNT(*) FROM week_sessions)::int AS workouts,
         (SELECT COALESCE(
                   SUM(EXTRACT(EPOCH FROM (completed_at - started_at))), 0)
            FROM week_sessions)::int AS seconds,
         (SELECT COUNT(*) FROM week_sets)::int AS sets,
         (SELECT COALESCE(SUM(actual_weight * actual_reps), 0)
            FROM week_sets)::float8 AS volume`,
      [userId],
    );

    const row = result.rows[0];
    return {
      workouts: row?.workouts ?? 0,
      seconds: row?.seconds ?? 0,
      sets: row?.sets ?? 0,
      volumeKg: row?.volume ?? 0,
    };
  }

  private async consistency(userId: number): Promise<Consistency> {
    const result = await this.db.query<{
      month_workouts: number;
      recent_workouts: number;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM workout_sessions
           WHERE user_id = $1 AND completed_at IS NOT NULL
             AND completed_at >= date_trunc('month', now()))::int
           AS month_workouts,
         (SELECT COUNT(*) FROM workout_sessions
           WHERE user_id = $1 AND completed_at IS NOT NULL
             AND completed_at >= now() - make_interval(days => $2))::int
           AS recent_workouts`,
      [userId, AVERAGE_WEEKS * 7],
    );

    const row = result.rows[0];
    const average = (row?.recent_workouts ?? 0) / AVERAGE_WEEKS;

    return {
      currentStreakDays: await this.currentStreakDays(userId),
      workoutsThisMonth: row?.month_workouts ?? 0,
      averageWorkoutsPerWeek: Math.round(average * 10) / 10,
    };
  }

  /**
   * Consecutive calendar days on which the user finished at least one workout.
   *
   * Today not yet trained does not break the streak — it is still early. A gap
   * of a full day does. Dates are read as text and compared as UTC midnights, so
   * neither the Node process's timezone nor `pg`'s date parsing can shift a day
   * across a boundary; the day a workout belongs to is decided once, by Postgres.
   */
  private async currentStreakDays(userId: number): Promise<number> {
    const result = await this.db.query<{ day: string; today: string }>(
      `SELECT DISTINCT
              to_char(completed_at::date, 'YYYY-MM-DD') AS day,
              to_char(current_date, 'YYYY-MM-DD') AS today
         FROM workout_sessions
        WHERE user_id = $1
          AND completed_at IS NOT NULL
          AND completed_at >= now() - make_interval(days => $2)
        ORDER BY day DESC`,
      [userId, STREAK_WINDOW_DAYS],
    );

    const days = result.rows.map((row) => row.day);
    if (days.length === 0) return 0;

    const midnight = (day: string) => Date.parse(`${day}T00:00:00Z`);
    const today = midnight(result.rows[0].today);

    // Trained neither today nor yesterday: whatever ran before has ended.
    if ((today - midnight(days[0])) / DAY_MS > 1) return 0;

    let streak = 1;
    for (let i = 1; i < days.length; i += 1) {
      if ((midnight(days[i - 1]) - midnight(days[i])) / DAY_MS !== 1) break;
      streak += 1;
    }
    return streak;
  }

  /**
   * The latest body weight, and how it has moved over the last 30 days.
   *
   * The change compares the newest measurement in that window against the oldest
   * one in it — with only two data points that is the whole trend, and with
   * twenty it is still the honest reading of "over the last 30 days". A single
   * measurement yields a weight but no change: one point is not a direction.
   */
  private async bodyWeight(userId: number): Promise<BodyWeightStats | null> {
    const latest = await this.db.query<{ kg: number; recorded_at: Date }>(
      `SELECT body_weight_kg::float8 AS kg, completed_at AS recorded_at
         FROM workout_sessions
        WHERE user_id = $1
          AND completed_at IS NOT NULL
          AND body_weight_kg IS NOT NULL
        ORDER BY completed_at DESC
        LIMIT 1`,
      [userId],
    );

    const latestRow = latest.rows[0];
    if (!latestRow) return null;

    const window = await this.db.query<{ kg: number; recorded_at: Date }>(
      `SELECT body_weight_kg::float8 AS kg, completed_at AS recorded_at
         FROM workout_sessions
        WHERE user_id = $1
          AND completed_at IS NOT NULL
          AND body_weight_kg IS NOT NULL
          AND completed_at >= now() - INTERVAL '30 days'
        ORDER BY completed_at ASC
        LIMIT 1`,
      [userId],
    );

    // The oldest row in the window is the latest one when only one exists there
    // — and comparing a measurement against itself is a change of zero, which
    // reads as "stable" when the truth is "not enough data".
    const oldestRow = window.rows[0];
    const hasTrend =
      oldestRow !== undefined &&
      oldestRow.recorded_at.getTime() < latestRow.recorded_at.getTime();

    return {
      latestKg: latestRow.kg,
      recordedAt: latestRow.recorded_at.toISOString(),
      changeKg: hasTrend
        ? Math.round((latestRow.kg - oldestRow.kg) * 100) / 100
        : null,
      changeSince: hasTrend ? oldestRow.recorded_at.toISOString() : null,
    };
  }

  /**
   * The best set ever recorded on each exercise, newest achievement first.
   *
   * "Best" is the highest estimated one-rep max, so 80 kg × 5 outranks 85 kg × 1
   * — a heavier single is not automatically a better set. Ties fall to the
   * heavier bar, then the more recent set.
   *
   * `DISTINCT ON (e.name)` keeps one row per exercise and requires that name
   * lead the inner ORDER BY; the outer query is what puts the survivors in
   * recency order.
   */
  private async personalRecords(userId: number): Promise<PersonalRecord[]> {
    const result = await this.db.query<{
      name: string;
      weight: number;
      reps: number;
      est_1rm: number;
      achieved_at: Date;
    }>(
      `SELECT name, weight, reps, est_1rm, achieved_at
         FROM (
           SELECT DISTINCT ON (e.name)
                  e.name AS name,
                  ws.actual_weight::float8 AS weight,
                  ws.actual_reps AS reps,
                  (ws.actual_weight * (1 + ws.actual_reps::numeric / 30))::float8
                    AS est_1rm,
                  ws.completed_at AS achieved_at
             FROM workout_sets ws
             JOIN workout_session_exercises e ON e.id = ws.exercise_id
             JOIN workout_sessions s ON s.id = ws.workout_session_id
            WHERE s.user_id = $1 AND s.completed_at IS NOT NULL
            ORDER BY e.name,
                     (ws.actual_weight * (1 + ws.actual_reps::numeric / 30)) DESC,
                     ws.actual_weight DESC,
                     ws.completed_at DESC
         ) best
        ORDER BY best.achieved_at DESC
        LIMIT $2`,
      [userId, PR_LIMIT],
    );

    return result.rows.map((row) => ({
      exerciseName: row.name,
      weightKg: row.weight,
      reps: row.reps,
      estimatedOneRepMaxKg: Math.round(row.est_1rm * 10) / 10,
      achievedAt: row.achieved_at.toISOString(),
    }));
  }

  /**
   * The last few finished workouts, one row each. The set-derived figures are
   * scalar subqueries rather than joins, for the same reason the week summary
   * splits its CTEs: joining sets onto sessions multiplies the session row.
   *
   * `exercise_count` counts exercises the user actually logged a set on, not the
   * ones the plan listed — a workout cut short reports what was trained.
   */
  private async recentWorkouts(userId: number): Promise<RecentWorkout[]> {
    const result = await this.db.query<{
      id: number;
      day_name: string;
      completed_at: Date;
      duration_seconds: number;
      exercise_count: number;
      set_count: number;
      volume: number;
      body_weight_kg: number | null;
    }>(
      `SELECT s.id,
              COALESCE(d.day, td.name, 'Workout') AS day_name,
              s.completed_at,
              EXTRACT(EPOCH FROM (s.completed_at - s.started_at))::int
                AS duration_seconds,
              (SELECT COUNT(DISTINCT ws.exercise_id) FROM workout_sets ws
                WHERE ws.workout_session_id = s.id)::int AS exercise_count,
              (SELECT COUNT(*) FROM workout_sets ws
                WHERE ws.workout_session_id = s.id)::int AS set_count,
              (SELECT COALESCE(SUM(ws.actual_weight * ws.actual_reps), 0)
                 FROM workout_sets ws
                WHERE ws.workout_session_id = s.id)::float8 AS volume,
              s.body_weight_kg::float8 AS body_weight_kg
         FROM workout_sessions s
         LEFT JOIN training_days d ON d.id = s.training_day_id
         LEFT JOIN training_template_days td ON td.id = s.template_day_id
        WHERE s.user_id = $1 AND s.completed_at IS NOT NULL
        ORDER BY s.completed_at DESC
        LIMIT $2`,
      [userId, RECENT_WORKOUT_LIMIT],
    );

    return result.rows.map((row) => ({
      id: row.id,
      dayName: row.day_name,
      completedAt: row.completed_at.toISOString(),
      durationSeconds: row.duration_seconds,
      exerciseCount: row.exercise_count,
      setCount: row.set_count,
      volumeKg: row.volume,
      bodyWeightKg: row.body_weight_kg,
    }));
  }
}

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { bootstrapSchema } from '../database/bootstrap-schema';
import { DatabaseService } from '../database/database.service';

/**
 * The AI *general progress* summary shown on the Progress page. Unlike the
 * post-workout summary — which compares one finished session to earlier sessions
 * of the SAME training day — this one analyses the user's overall training across
 * ALL workouts in a selected time window (last week / month / 3 months / all
 * time).
 *
 * The deterministic work — volumes, per-exercise best sets and estimated-1RM
 * movement, muscle-group distribution, the volume/consistency trend, and the
 * comparison against the previous equal window — is computed here in SQL/JS, so
 * the model receives a small structured summary rather than a raw dump of every
 * set. The model turns that into a short human-readable assessment.
 *
 * The OpenAI key is read from the backend environment and only ever used for the
 * server-to-server call; it is never returned to the caller or the browser. If
 * the model call fails the user's data is untouched — the caller still gets the
 * deterministic metrics plus a friendly fallback message.
 *
 * The model narrative is cached per (user, period) in `progress_ai_summaries`,
 * keyed by a cheap "data signature" (workout count + latest completion + total
 * volume). A visit whose signature matches the cached one reuses the stored text
 * for free; a new workout changes the signature and the next visit regenerates.
 */

/** The chat-completions endpoint. */
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

/** Cost-efficient and more than capable for a short structured summary. */
const OPENAI_MODEL = 'gpt-4o-mini';

/** Bound the wait so a hung upstream cannot hold generation open forever. */
const REQUEST_TIMEOUT_MS = 30_000;

/** How many exercises the highlights/tables surface. */
const TOP_EXERCISES = 8;

/** How many best sets the model is shown and the UI lists. */
const BEST_SETS = 6;

/** The selectable time windows. */
export type ProgressPeriod = 'week' | 'month' | 'three_months' | 'all_time';

/** The overall verdict, kept to a small closed set the UI can badge. */
export type ProgressAssessment =
  | 'improving'
  | 'stable'
  | 'declining'
  | 'not_enough_data';

/** date_trunc granularity for the volume trend, per period. */
type Bucket = 'day' | 'week' | 'month';

interface PeriodConfig {
  /** Length of the window in days; null means "all time". */
  days: number | null;
  /** Human label the model is told, e.g. "the last week". */
  label: string;
  /** How the trend is bucketed for this window. */
  bucket: Bucket;
  /** to_char format for a bucket label. */
  bucketFormat: string;
  /** Whether a previous equal-length window is compared against. */
  compare: boolean;
}

const PERIODS: Record<ProgressPeriod, PeriodConfig> = {
  week: {
    days: 7,
    label: 'the last week',
    bucket: 'day',
    bucketFormat: 'Mon DD',
    compare: true,
  },
  month: {
    days: 30,
    label: 'the last month',
    bucket: 'week',
    bucketFormat: 'Mon DD',
    compare: true,
  },
  three_months: {
    days: 90,
    label: 'the last 3 months',
    bucket: 'month',
    bucketFormat: 'Mon YYYY',
    compare: true,
  },
  all_time: {
    days: null,
    label: 'all time',
    bucket: 'month',
    bucketFormat: 'Mon YYYY',
    compare: false,
  },
};

export function parseProgressPeriod(value: unknown): ProgressPeriod {
  if (
    value === 'week' ||
    value === 'month' ||
    value === 'three_months' ||
    value === 'all_time'
  ) {
    return value;
  }
  throw new BadRequestException('Invalid period.');
}

/** The best set of an exercise in the window, by estimated 1RM. */
export interface BestSet {
  name: string;
  weight: number;
  reps: number;
  e1rm: number;
}

/** One exercise's activity across the window. */
export interface ExerciseProgress {
  name: string;
  volume: number;
  sets: number;
  reps: number;
  /** Best estimated 1RM in the window (0 when only bodyweight sets). */
  bestE1rm: number;
  /** Number of distinct sessions this exercise appeared in. */
  sessions: number;
  /** Latest best-1RM minus earliest best-1RM across sessions; a strength trend. */
  e1rmChange: number;
}

/** Volume attributed to a muscle group (or category, or "Other"). */
export interface MuscleGroupVolume {
  name: string;
  volume: number;
  sets: number;
}

/** One point on the volume/consistency trend. */
export interface TrendBucket {
  label: string;
  volume: number;
  workouts: number;
}

/** One finished workout's total working volume. */
export interface WorkoutVolume {
  date: string;
  dayName: string;
  volume: number;
}

/** Totals for a comparison window (this window, or the previous equal one). */
export interface WindowTotals {
  workouts: number;
  volume: number;
  reps: number;
}

/** The deterministic numbers behind the summary — the visual data the UI charts. */
export interface ProgressMetrics {
  period: ProgressPeriod;
  periodLabel: string;
  workouts: number;
  totalVolume: number;
  totalSets: number;
  totalReps: number;
  averageWorkoutsPerWeek: number;
  /** Distinct training days / templates trained, with how often. */
  daysTrained: { name: string; workouts: number }[];
  volumeTrend: TrendBucket[];
  volumeByWorkout: WorkoutVolume[];
  topExercises: ExerciseProgress[];
  muscleGroups: MuscleGroupVolume[];
  bestSets: BestSet[];
  /** The previous equal-length window, when one is compared and has data. */
  previous: WindowTotals | null;
}

/** The model-authored narrative. */
export interface ProgressSummaryContent {
  assessment: ProgressAssessment;
  headline: string;
  summary: string;
  consistencyNote: string;
  highlights: string[];
  weakSpots: string[];
  comparisonNote: string;
  recommendations: string[];
}

/** What the summary endpoint returns to the frontend. */
export interface ProgressSummaryPayload extends ProgressSummaryContent {
  period: ProgressPeriod;
  /** 'ready' when the model produced it; 'unavailable' for the fallback. */
  status: 'ready' | 'unavailable';
  generatedAt: string | null;
  metrics: ProgressMetrics;
}

interface SetRow {
  sid: number;
  completed_at: Date;
  day_name: string;
  lib_id: number | null;
  name: string;
  muscle_group: string | null;
  category: string | null;
  weight: number;
  reps: number;
}

/** Running aggregate for one exercise across the window. */
interface ExerciseAgg {
  name: string;
  volume: number;
  sets: number;
  reps: number;
  bestE1rm: number;
  sessions: Set<number>;
  /** Best e1rm within each session, keyed by session id, for the strength trend. */
  perSessionBest: Map<number, { at: number; e1rm: number }>;
}

/** Estimated one-rep max: weight × (1 + reps / 30). Zero weight → zero. */
function estimate1rm(weight: number, reps: number): number {
  return Math.round(weight * (1 + reps / 30) * 100) / 100;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

@Injectable()
export class AiProgressSummaryService implements OnModuleInit {
  private readonly logger = new Logger(AiProgressSummaryService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    await bootstrapSchema(this.logger, 'ProgressAiSummary', () =>
      this.ensureSchema(),
    );
  }

  /**
   * The only table this module owns. One cached narrative per (user, period);
   * `data_signature` records the metrics it was built from so a later visit can
   * tell whether the cached text still describes the user's training or has been
   * outdated by a new workout.
   */
  private async ensureSchema(): Promise<void> {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS progress_ai_summaries (
        id             SERIAL PRIMARY KEY,
        user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        period         TEXT NOT NULL,
        data_signature TEXT NOT NULL,
        summary_text   TEXT NOT NULL,
        summary_json   JSONB NOT NULL,
        generated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (user_id, period)
      )
    `);
  }

  /**
   * The summary for a period: the cached narrative when it still matches the
   * user's data, otherwise generated now. The deterministic metrics are always
   * recomputed — they are cheap and must never be stale.
   */
  async getSummary(
    userId: number,
    period: ProgressPeriod,
  ): Promise<ProgressSummaryPayload> {
    const metrics = await this.computeMetrics(userId, period);
    const signature = this.signature(metrics);

    const cached = await this.loadCached(userId, period, signature);
    if (cached) return cached;

    return this.generate(userId, period, metrics, signature);
  }

  /**
   * Regenerates from scratch, ignoring any cached copy — the manual "Regenerate"
   * path.
   */
  async regenerate(
    userId: number,
    period: ProgressPeriod,
  ): Promise<ProgressSummaryPayload> {
    const metrics = await this.computeMetrics(userId, period);
    return this.generate(userId, period, metrics, this.signature(metrics));
  }

  // ── Generation ──────────────────────────────────────────────────────────────

  private async generate(
    userId: number,
    period: ProgressPeriod,
    metrics: ProgressMetrics,
    signature: string,
  ): Promise<ProgressSummaryPayload> {
    let content: ProgressSummaryContent | null = null;
    if (metrics.workouts > 0) {
      try {
        content = await this.callModel(metrics);
      } catch (err) {
        this.logger.warn(
          `OpenAI progress summary (${period}) for user ${userId} failed: ${
            err instanceof Error ? err.message : 'unknown error'
          }`,
        );
      }
    }

    if (content) {
      await this.db.query(
        `INSERT INTO progress_ai_summaries
           (user_id, period, data_signature, summary_text, summary_json, generated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, now())
         ON CONFLICT (user_id, period) DO UPDATE
           SET data_signature = EXCLUDED.data_signature,
               summary_text   = EXCLUDED.summary_text,
               summary_json   = EXCLUDED.summary_json,
               generated_at   = now()`,
        [
          userId,
          period,
          signature,
          content.summary,
          JSON.stringify({ content, metrics }),
        ],
      );
      return {
        period,
        status: 'ready',
        generatedAt: new Date().toISOString(),
        ...content,
        metrics,
      };
    }

    // The model was unreachable (or there is nothing to analyse). Return the
    // numbers we computed plus a friendly fallback, and store nothing — so a
    // later visit or a manual retry can still produce the real thing.
    return {
      period,
      status: 'unavailable',
      generatedAt: null,
      ...this.fallbackContent(metrics),
      metrics,
    };
  }

  /** A cached summary whose signature still matches, or null. */
  private async loadCached(
    userId: number,
    period: ProgressPeriod,
    signature: string,
  ): Promise<ProgressSummaryPayload | null> {
    const result = await this.db.query<{
      summary_json: unknown;
      generated_at: Date;
    }>(
      `SELECT summary_json, generated_at
         FROM progress_ai_summaries
        WHERE user_id = $1 AND period = $2 AND data_signature = $3`,
      [userId, period, signature],
    );
    const row = result.rows[0];
    if (!row) return null;

    const json = row.summary_json;
    if (typeof json !== 'object' || json === null) return null;
    const { content, metrics } = json as {
      content?: ProgressSummaryContent;
      metrics?: ProgressMetrics;
    };
    if (!content || !metrics) return null;

    return {
      period,
      status: 'ready',
      generatedAt: row.generated_at.toISOString(),
      ...content,
      metrics,
    };
  }

  /**
   * A cheap fingerprint of the window's data. If nothing the summary depends on
   * has changed, this string is identical and the cached narrative still holds.
   */
  private signature(metrics: ProgressMetrics): string {
    const lastWorkout = metrics.volumeByWorkout[0]?.date ?? 'none';
    return [
      metrics.period,
      metrics.workouts,
      metrics.totalSets,
      Math.round(metrics.totalVolume),
      lastWorkout,
    ].join(':');
  }

  // ── Metrics ─────────────────────────────────────────────────────────────────

  /** The structured analysis behind the summary, all computed by the database. */
  private async computeMetrics(
    userId: number,
    period: ProgressPeriod,
  ): Promise<ProgressMetrics> {
    const cfg = PERIODS[period];

    const [setRows, counts, trend, previous] = await Promise.all([
      this.windowSets(userId, cfg),
      this.windowCounts(userId, cfg),
      this.volumeTrend(userId, cfg),
      cfg.compare && cfg.days !== null
        ? this.previousTotals(userId, cfg.days)
        : Promise.resolve(null),
    ]);

    let totalVolume = 0;
    let totalReps = 0;
    const totalSets = setRows.length;
    const exercises = new Map<string, ExerciseAgg>();
    const muscles = new Map<string, MuscleGroupVolume>();
    const byWorkout = new Map<
      number,
      { date: Date; dayName: string; volume: number }
    >();

    for (const row of setRows) {
      const volume = row.weight * row.reps;
      const e1rm = estimate1rm(row.weight, row.reps);
      totalVolume += volume;
      totalReps += row.reps;

      const workout = byWorkout.get(row.sid);
      if (workout) {
        workout.volume += volume;
      } else {
        byWorkout.set(row.sid, {
          date: row.completed_at,
          dayName: row.day_name,
          volume,
        });
      }

      const key = row.lib_id !== null ? `lib:${row.lib_id}` : `name:${row.name}`;
      let ex = exercises.get(key);
      if (!ex) {
        ex = {
          name: row.name,
          volume: 0,
          sets: 0,
          reps: 0,
          bestE1rm: 0,
          sessions: new Set(),
          perSessionBest: new Map(),
        };
        exercises.set(key, ex);
      }
      ex.volume += volume;
      ex.sets += 1;
      ex.reps += row.reps;
      ex.sessions.add(row.sid);
      if (e1rm > ex.bestE1rm) ex.bestE1rm = e1rm;
      const sessionBest = ex.perSessionBest.get(row.sid);
      if (!sessionBest) {
        ex.perSessionBest.set(row.sid, {
          at: row.completed_at.getTime(),
          e1rm,
        });
      } else if (e1rm > sessionBest.e1rm) {
        sessionBest.e1rm = e1rm;
      }

      const muscleName =
        this.clean(row.muscle_group) ?? this.clean(row.category) ?? 'Other';
      let muscle = muscles.get(muscleName);
      if (!muscle) {
        muscle = { name: muscleName, volume: 0, sets: 0 };
        muscles.set(muscleName, muscle);
      }
      muscle.volume += volume;
      muscle.sets += 1;
    }

    const topExercises = [...exercises.values()]
      .map((ex) => this.exerciseProgress(ex))
      .sort((a, b) => b.volume - a.volume)
      .slice(0, TOP_EXERCISES);

    const muscleGroups = [...muscles.values()]
      .map((m) => ({ name: m.name, volume: round2(m.volume), sets: m.sets }))
      .sort((a, b) => b.volume - a.volume);

    const bestSets = this.bestSets(setRows);

    const volumeByWorkout: WorkoutVolume[] = [...byWorkout.values()]
      .sort((a, b) => b.date.getTime() - a.date.getTime())
      .map((w) => ({
        date: w.date.toISOString(),
        dayName: w.dayName,
        volume: round2(w.volume),
      }));

    return {
      period,
      periodLabel: cfg.label,
      workouts: counts.workouts,
      totalVolume: round2(totalVolume),
      totalSets,
      totalReps,
      averageWorkoutsPerWeek: this.perWeek(counts, cfg),
      daysTrained: counts.daysTrained,
      volumeTrend: trend,
      volumeByWorkout,
      topExercises,
      muscleGroups,
      bestSets,
      previous:
        previous && previous.workouts > 0
          ? {
              workouts: previous.workouts,
              volume: round2(previous.volume),
              reps: previous.reps,
            }
          : null,
    };
  }

  private exerciseProgress(ex: ExerciseAgg): ExerciseProgress {
    const sessions = [...ex.perSessionBest.values()].sort(
      (a, b) => a.at - b.at,
    );
    const e1rmChange =
      sessions.length >= 2
        ? round2(sessions[sessions.length - 1].e1rm - sessions[0].e1rm)
        : 0;
    return {
      name: ex.name,
      volume: round2(ex.volume),
      sets: ex.sets,
      reps: ex.reps,
      bestE1rm: round2(ex.bestE1rm),
      sessions: ex.sessions.size,
      e1rmChange,
    };
  }

  /** The single best set (by e1rm) of each exercise, strongest first. */
  private bestSets(rows: SetRow[]): BestSet[] {
    const best = new Map<string, BestSet>();
    for (const row of rows) {
      const e1rm = estimate1rm(row.weight, row.reps);
      const key = row.lib_id !== null ? `lib:${row.lib_id}` : `name:${row.name}`;
      const existing = best.get(key);
      if (!existing || e1rm > existing.e1rm) {
        best.set(key, {
          name: row.name,
          weight: round2(row.weight),
          reps: row.reps,
          e1rm,
        });
      }
    }
    return [...best.values()]
      .filter((s) => s.e1rm > 0)
      .sort((a, b) => b.e1rm - a.e1rm)
      .slice(0, BEST_SETS);
  }

  /** Working (non-warm-up) sets in the window, one row per set. */
  private async windowSets(
    userId: number,
    cfg: PeriodConfig,
  ): Promise<SetRow[]> {
    const params: unknown[] = [userId];
    let windowClause = '';
    if (cfg.days !== null) {
      params.push(cfg.days);
      windowClause = `AND s.completed_at >= now() - make_interval(days => $${params.length})`;
    }

    const result = await this.db.query<SetRow>(
      `SELECT s.id AS sid,
              s.completed_at AS completed_at,
              COALESCE(d.day, td.name, 'Workout') AS day_name,
              e.exercise_library_id AS lib_id,
              e.name AS name,
              lib.muscle_group AS muscle_group,
              lib.category AS category,
              ws.actual_weight::float8 AS weight,
              ws.actual_reps AS reps
         FROM workout_sets ws
         JOIN workout_session_exercises e ON e.id = ws.exercise_id
         JOIN workout_sessions s ON s.id = ws.workout_session_id
         LEFT JOIN training_days d ON d.id = s.training_day_id
         LEFT JOIN training_template_days td ON td.id = s.template_day_id
         LEFT JOIN exercise_library lib ON lib.id = e.exercise_library_id
        WHERE s.user_id = $1
          AND s.completed_at IS NOT NULL
          AND ws.is_warmup = false
          ${windowClause}`,
      params,
    );
    return result.rows;
  }

  /**
   * Completed-workout count and the days/templates trained, plus the span of
   * history (for the all-time per-week average). Counts every completed session
   * in the window, including one that logged only warm-ups.
   */
  private async windowCounts(
    userId: number,
    cfg: PeriodConfig,
  ): Promise<{
    workouts: number;
    daysTrained: { name: string; workouts: number }[];
    spanDays: number;
  }> {
    const params: unknown[] = [userId];
    let windowClause = '';
    if (cfg.days !== null) {
      params.push(cfg.days);
      windowClause = `AND s.completed_at >= now() - make_interval(days => $${params.length})`;
    }

    const totals = await this.db.query<{ workouts: number; span_days: number }>(
      `SELECT COUNT(*)::int AS workouts,
              COALESCE(
                EXTRACT(EPOCH FROM (MAX(completed_at) - MIN(completed_at))) / 86400,
                0)::float8 AS span_days
         FROM workout_sessions s
        WHERE s.user_id = $1
          AND s.completed_at IS NOT NULL
          ${windowClause}`,
      params,
    );

    // Group by the full COALESCE expression, not the output alias `name`.
    // `training_template_days` also has a column called `name`, so a bare
    // `GROUP BY name` binds to that input column (Postgres prefers an input
    // column over an output alias when both match a simple name), which leaves
    // `d.day` in the SELECT ungrouped and raises error 42803.
    const days = await this.db.query<{ name: string; workouts: number }>(
      `SELECT COALESCE(d.day, td.name, 'Workout') AS name,
              COUNT(*)::int AS workouts
         FROM workout_sessions s
         LEFT JOIN training_days d ON d.id = s.training_day_id
         LEFT JOIN training_template_days td ON td.id = s.template_day_id
        WHERE s.user_id = $1
          AND s.completed_at IS NOT NULL
          ${windowClause}
        GROUP BY COALESCE(d.day, td.name, 'Workout')
        ORDER BY workouts DESC, COALESCE(d.day, td.name, 'Workout')`,
      params,
    );

    return {
      workouts: totals.rows[0]?.workouts ?? 0,
      spanDays: totals.rows[0]?.span_days ?? 0,
      daysTrained: days.rows,
    };
  }

  private perWeek(
    counts: { workouts: number; spanDays: number },
    cfg: PeriodConfig,
  ): number {
    // A fixed window divides by its own length; all-time by the span actually
    // trained (floored at a week, so a single workout is not "7 / week").
    const days =
      cfg.days !== null ? cfg.days : Math.max(7, Math.round(counts.spanDays));
    const weeks = Math.max(1, days / 7);
    return Math.round((counts.workouts / weeks) * 10) / 10;
  }

  /**
   * Volume and workout count bucketed over the window — the trend chart. Sessions
   * with no working sets still count as a workout (volume 0), so a light week is
   * visible rather than missing.
   */
  private async volumeTrend(
    userId: number,
    cfg: PeriodConfig,
  ): Promise<TrendBucket[]> {
    // bucket / format come from a fixed config, never user input, so injecting
    // them as literals is safe; the user id and window stay parameterised.
    const params: unknown[] = [userId, cfg.bucket, cfg.bucketFormat];
    let windowClause = '';
    if (cfg.days !== null) {
      params.push(cfg.days);
      windowClause = `AND s.completed_at >= now() - make_interval(days => $${params.length})`;
    }

    const result = await this.db.query<{
      label: string;
      workouts: number;
      volume: number;
    }>(
      `SELECT to_char(date_trunc($2, s.completed_at), $3) AS label,
              COUNT(DISTINCT s.id)::int AS workouts,
              COALESCE(SUM(
                ws.actual_weight * ws.actual_reps)
                FILTER (WHERE ws.is_warmup = false), 0)::float8 AS volume
         FROM workout_sessions s
         LEFT JOIN workout_sets ws ON ws.workout_session_id = s.id
        WHERE s.user_id = $1
          AND s.completed_at IS NOT NULL
          ${windowClause}
        GROUP BY date_trunc($2, s.completed_at)
        ORDER BY date_trunc($2, s.completed_at)`,
      params,
    );

    return result.rows.map((row) => ({
      label: row.label.trim(),
      workouts: row.workouts,
      volume: round2(row.volume),
    }));
  }

  /** Totals for the equal-length window immediately before this one. */
  private async previousTotals(
    userId: number,
    days: number,
  ): Promise<WindowTotals> {
    const result = await this.db.query<{
      workouts: number;
      volume: number;
      reps: number;
    }>(
      `SELECT COUNT(DISTINCT s.id)::int AS workouts,
              COALESCE(SUM(ws.actual_weight * ws.actual_reps), 0)::float8 AS volume,
              COALESCE(SUM(ws.actual_reps), 0)::int AS reps
         FROM workout_sessions s
         JOIN workout_sets ws ON ws.workout_session_id = s.id
        WHERE s.user_id = $1
          AND s.completed_at IS NOT NULL
          AND ws.is_warmup = false
          AND s.completed_at >= now() - make_interval(days => $2)
          AND s.completed_at <  now() - make_interval(days => $3)`,
      [userId, days * 2, days],
    );
    const row = result.rows[0];
    return {
      workouts: row?.workouts ?? 0,
      volume: row?.volume ?? 0,
      reps: row?.reps ?? 0,
    };
  }

  private clean(value: string | null): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  // ── Model call ──────────────────────────────────────────────────────────────

  private async callModel(
    metrics: ProgressMetrics,
  ): Promise<ProgressSummaryContent> {
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not configured.');
    }

    let res: Response;
    try {
      res = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: this.systemPrompt() },
            { role: 'user', content: JSON.stringify(metrics) },
          ],
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new Error('Could not reach the summary service.');
    }

    if (!res.ok) {
      throw new Error(`Summary service returned HTTP ${res.status}.`);
    }

    const payload = (await res.json().catch(() => null)) as {
      choices?: { message?: { content?: string } }[];
    } | null;
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('Summary service returned an unexpected response.');
    }
    return this.parseContent(content, metrics);
  }

  private systemPrompt(): string {
    return (
      'You are a concise, encouraging strength-training coach inside a gym app. ' +
      "You are given STRUCTURED metrics summarising a user's OVERALL training " +
      'across ALL of their workouts in a selected time period (not a single ' +
      'session, and not one training day — the whole period). Volume = sum of ' +
      'weight × reps over working sets (warm-ups already excluded). Estimated ' +
      '1RM = weight × (1 + reps / 30). "previous" is the equal-length window ' +
      'immediately before this one (null when not compared or no data). ' +
      '"volumeTrend" is volume and workout count bucketed over the period.\n' +
      'Rules: Use ONLY the numbers provided. Never invent exercises, workouts, ' +
      'or muscle groups. Judge trends from volumeTrend, previous, and per-' +
      'exercise e1rmChange. If workouts is 0 or 1, set "assessment" to ' +
      '"not_enough_data" and say so plainly. If weight is 0 for an exercise, ' +
      'reason about reps/frequency instead of volume. Keep every field short and ' +
      'mobile-readable.\n' +
      'Reply with STRICT JSON and no prose outside it:\n' +
      '{"assessment": "improving"|"stable"|"declining"|"not_enough_data", ' +
      '"headline": string (<=9 words, e.g. "Strength trending up, but chest ' +
      'volume dropped"), "summary": string (2-4 short sentences on overall ' +
      'progress across the period), "consistencyNote": string (1 sentence on ' +
      'workouts completed and average per week), "highlights": string[] (0-4 ' +
      'strongest improvements: exercises with better best sets, volume ' +
      'increases), "weakSpots": string[] (0-4 declining/neglected exercises or ' +
      'muscle groups, or inconsistency), "comparisonNote": string (1-2 ' +
      'sentences: for week/month compare to the previous window; for 3 months / ' +
      'all time describe the month-by-month trend), "recommendations": string[] ' +
      '(2-4 practical cues: what to increase, keep stable, watch, and a focus ' +
      'for next week/month).}'
    );
  }

  private parseContent(
    content: string,
    metrics: ProgressMetrics,
  ): ProgressSummaryContent {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error('Summary service returned invalid JSON.');
    }
    const obj =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};

    const summary = this.text(obj.summary);
    if (!summary) {
      throw new Error('Summary service returned an empty summary.');
    }

    return {
      assessment: this.assessment(obj.assessment, metrics),
      headline: this.text(obj.headline) || 'Your progress so far',
      summary,
      consistencyNote: this.text(obj.consistencyNote),
      highlights: this.stringList(obj.highlights).slice(0, 4),
      weakSpots: this.stringList(obj.weakSpots).slice(0, 4),
      comparisonNote: this.text(obj.comparisonNote),
      recommendations: this.stringList(obj.recommendations).slice(0, 4),
    };
  }

  private assessment(
    value: unknown,
    metrics: ProgressMetrics,
  ): ProgressAssessment {
    if (
      value === 'improving' ||
      value === 'stable' ||
      value === 'declining' ||
      value === 'not_enough_data'
    ) {
      return value;
    }
    return metrics.workouts <= 1 ? 'not_enough_data' : 'stable';
  }

  // ── Fallback (no model) ──────────────────────────────────────────────────────

  /**
   * A deterministic summary for when the model cannot be reached — or when there
   * is simply nothing in the window to send it. The numbers are already
   * computed, so the user still sees a truthful read plus a clear "AI note
   * unavailable" message rather than an empty screen.
   */
  private fallbackContent(metrics: ProgressMetrics): ProgressSummaryContent {
    if (metrics.workouts === 0) {
      return {
        assessment: 'not_enough_data',
        headline: 'No workouts in this period',
        summary:
          'There are no completed workouts in this time period yet, so there ' +
          'is nothing to analyse. Finish a workout and it will show up here.',
        consistencyNote: '',
        highlights: [],
        weakSpots: [],
        comparisonNote: '',
        recommendations: ['Complete a workout to start tracking progress.'],
      };
    }

    const prev = metrics.previous;
    const volDelta = prev ? round2(metrics.totalVolume - prev.volume) : null;
    const assessment: ProgressAssessment =
      metrics.workouts <= 1
        ? 'not_enough_data'
        : volDelta === null
          ? 'stable'
          : volDelta > 0
            ? 'improving'
            : volDelta < 0
              ? 'declining'
              : 'stable';

    const comparisonNote =
      volDelta === null || prev === null
        ? ''
        : `Total volume ${volDelta >= 0 ? 'up' : 'down'} ${Math.abs(
            volDelta,
          )} kg vs the previous period (${Math.round(
            metrics.totalVolume,
          )} vs ${Math.round(prev.volume)} kg).`;

    return {
      assessment,
      headline:
        volDelta === null
          ? 'Your training so far'
          : volDelta >= 0
            ? 'Volume trending up'
            : 'Volume trending down',
      summary:
        `${metrics.workouts} workout${metrics.workouts === 1 ? '' : 's'} in ` +
        `${metrics.periodLabel}, ${Math.round(
          metrics.totalVolume,
        )} kg total volume across ${metrics.totalSets} working sets. The AI ` +
        'coach note is unavailable right now — the numbers below are still your ' +
        'real results.',
      consistencyNote:
        `${metrics.workouts} workouts, about ` +
        `${metrics.averageWorkoutsPerWeek} per week.`,
      highlights: [],
      weakSpots: [],
      comparisonNote,
      recommendations: [],
    };
  }

  // ── Coercion ─────────────────────────────────────────────────────────────────

  private text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private stringList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }
}

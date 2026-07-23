import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../database/database.service';

/**
 * Post-workout AI summary. When a workout finishes it is compared against the
 * user's *earlier sessions of the same training day only* — a Friday is measured
 * against previous Fridays, never against a Monday. "Same day" is the
 * `template_day_id` a Training Builder workout carries; a legacy session that
 * predates the builder has none, so it falls back to `training_day_id`, and a
 * session with neither is treated as having no comparison group (a first
 * session). This is deliberately safe: a missing key narrows the comparison
 * rather than breaking it.
 *
 * The heavy lifting — volumes, best sets, per-exercise deltas, the volume trend —
 * is computed here in SQL/JS so the model receives a small, structured summary
 * rather than a raw dump of every set. The model turns that into a short
 * human-readable assessment. Everything is cached on the session row
 * (`ai_summary_json` / `ai_summary_text` / `ai_summary_generated_at`) so a
 * finished workout is summarised once, not on every visit.
 *
 * The OpenAI key is read from the backend environment and only ever used for the
 * server-to-server call; it is never returned to the caller or the browser. If
 * the model call fails the workout is unaffected — the caller still gets the
 * deterministic metrics plus a friendly fallback message.
 */

/** The chat-completions endpoint. */
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

/** Cost-efficient and more than capable for a short structured summary. */
const OPENAI_MODEL = 'gpt-4o-mini';

/** Bound the wait so a hung upstream cannot hold generation open forever. */
const REQUEST_TIMEOUT_MS = 30_000;

/** How many previous same-day sessions feed the ~1-month trend. */
const TREND_WORKOUTS = 4;

/** The overall verdict, kept to a small closed set the UI can badge. */
export type WorkoutAssessment = 'better' | 'similar' | 'worse' | 'first';

/** The best set of an exercise, by estimated 1RM. */
export interface BestSet {
  weight: number;
  reps: number;
  e1rm: number;
}

/** One point on the volume trend: a past (or the current) same-day session. */
export interface TrendPoint {
  date: string;
  volume: number;
  totalReps: number;
  bestE1rm: number;
}

/** Per-exercise comparison of the current workout against the previous same day. */
export interface ExerciseMetric {
  name: string;
  currentVolume: number;
  currentReps: number;
  currentBest: BestSet | null;
  previousVolume: number | null;
  previousBest: BestSet | null;
  /** current − previous volume, or null when this exercise is new this day. */
  volumeDelta: number | null;
}

/** The deterministic numbers behind the summary — the visual data the UI charts. */
export interface WorkoutSummaryMetrics {
  isFirstSession: boolean;
  current: { volume: number; totalReps: number; bestE1rm: number; date: string };
  previous: {
    volume: number;
    totalReps: number;
    bestE1rm: number;
    date: string;
  } | null;
  /** Oldest → newest, including the current session as the last point. */
  volumeTrend: TrendPoint[];
  exercises: ExerciseMetric[];
  effort: { hasData: boolean; avgRir: number | null; avgRpe: number | null };
}

/** The model-authored narrative. */
export interface AiSummaryContent {
  assessment: WorkoutAssessment;
  headline: string;
  summary: string;
  improvements: string[];
  declines: string[];
  exerciseNotes: string[];
  trendNote: string;
  effortNote: string | null;
  recommendation: string;
}

/** What the summary endpoint returns to the frontend. */
export interface WorkoutSummaryPayload extends AiSummaryContent {
  /** 'ready' when the model produced it; 'unavailable' for the fallback. */
  status: 'ready' | 'unavailable';
  generatedAt: string | null;
  metrics: WorkoutSummaryMetrics;
}

interface SummarySessionRow {
  id: number;
  user_id: number;
  training_day_id: number | null;
  template_day_id: number | null;
  completed_at: Date | null;
  day_name: string;
  ai_summary_generated_at: Date | null;
  ai_summary_json: unknown;
}

interface SetRow {
  sid: number;
  lib_id: number | null;
  name: string;
  weight: number;
  reps: number;
  is_warmup: boolean;
  rir: number | null;
  rpe: number | null;
}

/** Aggregates for one exercise within one session. */
interface ExerciseAgg {
  name: string;
  volume: number;
  reps: number;
  best: BestSet | null;
}

/** Aggregates for one whole session. */
interface SessionAgg {
  volume: number;
  totalReps: number;
  bestE1rm: number;
  exercises: Map<string, ExerciseAgg>;
  rirValues: number[];
  rpeValues: number[];
}

/** Estimated one-rep max: weight × (1 + reps / 30). Zero weight → zero. */
function estimate1rm(weight: number, reps: number): number {
  return Math.round(weight * (1 + reps / 30) * 100) / 100;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

@Injectable()
export class AiWorkoutSummaryService {
  private readonly logger = new Logger(AiWorkoutSummaryService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
  ) {}

  /**
   * The summary for a finished workout: the cached one if it exists, otherwise
   * generated now. Scoped to the owner. Throws 404 for an unknown/foreign
   * workout and 400 for one that is not finished yet.
   */
  async getSummary(
    userId: number,
    sessionId: number,
  ): Promise<WorkoutSummaryPayload> {
    const session = await this.loadCompletedSession(userId, sessionId);
    const stored = this.payloadFromStored(session);
    if (stored) return stored;
    return this.generate(session);
  }

  /**
   * Regenerates the summary from scratch, ignoring any cached copy — the manual
   * "try again" path. Same ownership/completion rules as {@link getSummary}.
   */
  async regenerate(
    userId: number,
    sessionId: number,
  ): Promise<WorkoutSummaryPayload> {
    const session = await this.loadCompletedSession(userId, sessionId);
    return this.generate(session);
  }

  /**
   * Fire-and-forget generation, called after a workout completes so the summary
   * is usually ready by the time the user reaches the summary screen. Never
   * throws — a failed summary must not affect workout completion — and skips
   * work if one was already generated.
   */
  async generateInBackground(userId: number, sessionId: number): Promise<void> {
    try {
      const session = await this.loadCompletedSession(userId, sessionId);
      if (session.ai_summary_generated_at) return;
      await this.generate(session);
    } catch (err) {
      this.logger.warn(
        `Background workout summary for session ${sessionId} failed: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
  }

  // ── Generation ──────────────────────────────────────────────────────────────

  private async generate(
    session: SummarySessionRow,
  ): Promise<WorkoutSummaryPayload> {
    const metrics = await this.computeMetrics(session);

    let content: AiSummaryContent | null = null;
    try {
      content = await this.callModel(session.day_name, metrics);
    } catch (err) {
      this.logger.warn(
        `OpenAI workout summary for session ${session.id} failed: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }

    if (content) {
      await this.db.query(
        `UPDATE workout_sessions
            SET ai_summary_text = $2,
                ai_summary_json = $3::jsonb,
                ai_summary_generated_at = now()
          WHERE id = $1`,
        [session.id, content.summary, JSON.stringify({ content, metrics })],
      );
      return {
        status: 'ready',
        generatedAt: new Date().toISOString(),
        ...content,
        metrics,
      };
    }

    // The model was unreachable. Return the numbers we computed plus a friendly
    // fallback, and store nothing — so a later visit or a manual retry can still
    // produce the real thing.
    return {
      status: 'unavailable',
      generatedAt: null,
      ...this.fallbackContent(metrics),
      metrics,
    };
  }

  /** A stored summary as a payload, or null when none has been generated. */
  private payloadFromStored(
    session: SummarySessionRow,
  ): WorkoutSummaryPayload | null {
    if (!session.ai_summary_generated_at) return null;
    const json = session.ai_summary_json;
    if (typeof json !== 'object' || json === null) return null;
    const { content, metrics } = json as {
      content?: AiSummaryContent;
      metrics?: WorkoutSummaryMetrics;
    };
    if (!content || !metrics) return null;
    return {
      status: 'ready',
      generatedAt: session.ai_summary_generated_at.toISOString(),
      ...content,
      metrics,
    };
  }

  // ── Metrics ─────────────────────────────────────────────────────────────────

  /**
   * The structured comparison behind the summary. Gathers the current session
   * and up to four earlier *same training day* sessions, aggregates each into
   * volumes / reps / best sets, and lines the current one up against the most
   * recent previous one plus the whole trend.
   */
  private async computeMetrics(
    session: SummarySessionRow,
  ): Promise<WorkoutSummaryMetrics> {
    const priorRows = await this.priorSessions(session);
    const priorIds = priorRows.map((row) => row.id);

    const setRows = await this.db.query<SetRow>(
      `SELECT ws.workout_session_id AS sid,
              e.exercise_library_id AS lib_id,
              e.name AS name,
              ws.actual_weight::float8 AS weight,
              ws.actual_reps AS reps,
              ws.is_warmup AS is_warmup,
              ws.rir::float8 AS rir,
              ws.rpe::float8 AS rpe
         FROM workout_sets ws
         JOIN workout_session_exercises e ON e.id = ws.exercise_id
        WHERE ws.workout_session_id = ANY($1::int[])`,
      [[session.id, ...priorIds]],
    );

    const bySession = new Map<number, SessionAgg>();
    for (const row of setRows.rows) {
      this.accumulate(bySession, row);
    }

    const currentAgg = bySession.get(session.id) ?? this.emptyAgg();
    const previousRow = priorRows[0] ?? null;
    const previousAgg = previousRow
      ? (bySession.get(previousRow.id) ?? this.emptyAgg())
      : null;

    const currentDate = (session.completed_at ?? new Date()).toISOString();

    // Oldest → newest: the earlier same-day sessions in chronological order,
    // then the current one as the final point.
    const trend: TrendPoint[] = [...priorRows]
      .reverse()
      .map((row) => {
        const agg = bySession.get(row.id) ?? this.emptyAgg();
        return {
          date: row.completed_at.toISOString(),
          volume: round2(agg.volume),
          totalReps: agg.totalReps,
          bestE1rm: round2(agg.bestE1rm),
        };
      });
    trend.push({
      date: currentDate,
      volume: round2(currentAgg.volume),
      totalReps: currentAgg.totalReps,
      bestE1rm: round2(currentAgg.bestE1rm),
    });

    const exercises: ExerciseMetric[] = [];
    for (const [key, ex] of currentAgg.exercises) {
      const prev = previousAgg?.exercises.get(key) ?? null;
      exercises.push({
        name: ex.name,
        currentVolume: round2(ex.volume),
        currentReps: ex.reps,
        currentBest: ex.best,
        previousVolume: prev ? round2(prev.volume) : null,
        previousBest: prev?.best ?? null,
        volumeDelta: prev ? round2(ex.volume - prev.volume) : null,
      });
    }

    const avgRir = this.average(currentAgg.rirValues);
    const avgRpe = this.average(currentAgg.rpeValues);

    return {
      isFirstSession: previousAgg === null,
      current: {
        volume: round2(currentAgg.volume),
        totalReps: currentAgg.totalReps,
        bestE1rm: round2(currentAgg.bestE1rm),
        date: currentDate,
      },
      previous: previousAgg
        ? {
            volume: round2(previousAgg.volume),
            totalReps: previousAgg.totalReps,
            bestE1rm: round2(previousAgg.bestE1rm),
            date: (previousRow as { completed_at: Date }).completed_at.toISOString(),
          }
        : null,
      volumeTrend: trend,
      exercises,
      effort: {
        hasData: avgRir !== null || avgRpe !== null,
        avgRir,
        avgRpe,
      },
    };
  }

  /**
   * The user's earlier completed sessions of the *same training day* as this
   * one, newest first. "Same day" is `template_day_id` when present, else the
   * legacy `training_day_id`; a session with neither has no comparison group and
   * this returns nothing, which the caller reads as a first session.
   */
  private async priorSessions(
    session: SummarySessionRow,
  ): Promise<{ id: number; completed_at: Date }[]> {
    const completedAt = session.completed_at;
    if (!completedAt) return [];

    let dayPredicate: string;
    let dayParam: number;
    if (session.template_day_id !== null) {
      dayPredicate = 's.template_day_id = $4';
      dayParam = session.template_day_id;
    } else if (session.training_day_id !== null) {
      dayPredicate = 's.training_day_id = $4';
      dayParam = session.training_day_id;
    } else {
      return [];
    }

    const result = await this.db.query<{ id: number; completed_at: Date }>(
      `SELECT s.id, s.completed_at
         FROM workout_sessions s
        WHERE s.user_id = $1
          AND s.id <> $2
          AND s.completed_at IS NOT NULL
          AND s.completed_at < $3
          AND ${dayPredicate}
        ORDER BY s.completed_at DESC
        LIMIT ${TREND_WORKOUTS}`,
      [session.user_id, session.id, completedAt, dayParam],
    );
    return result.rows;
  }

  /** Folds one set row into the running per-session aggregates. */
  private accumulate(bySession: Map<number, SessionAgg>, row: SetRow): void {
    let agg = bySession.get(row.sid);
    if (!agg) {
      agg = this.emptyAgg();
      bySession.set(row.sid, agg);
    }
    // Warm-up sets never count toward volume, reps, or best set.
    if (row.is_warmup) return;

    const volume = row.weight * row.reps;
    agg.volume += volume;
    agg.totalReps += row.reps;

    const e1rm = estimate1rm(row.weight, row.reps);
    if (e1rm > agg.bestE1rm) agg.bestE1rm = e1rm;

    const key = row.lib_id !== null ? `lib:${row.lib_id}` : `name:${row.name}`;
    let ex = agg.exercises.get(key);
    if (!ex) {
      ex = { name: row.name, volume: 0, reps: 0, best: null };
      agg.exercises.set(key, ex);
    }
    ex.volume += volume;
    ex.reps += row.reps;
    if (!ex.best || e1rm > ex.best.e1rm) {
      ex.best = { weight: row.weight, reps: row.reps, e1rm };
    }

    if (row.rir !== null) agg.rirValues.push(row.rir);
    if (row.rpe !== null) agg.rpeValues.push(row.rpe);
  }

  private emptyAgg(): SessionAgg {
    return {
      volume: 0,
      totalReps: 0,
      bestE1rm: 0,
      exercises: new Map(),
      rirValues: [],
      rpeValues: [],
    };
  }

  private average(values: number[]): number | null {
    if (values.length === 0) return null;
    const sum = values.reduce((total, value) => total + value, 0);
    return Math.round((sum / values.length) * 10) / 10;
  }

  // ── Model call ──────────────────────────────────────────────────────────────

  private async callModel(
    dayName: string,
    metrics: WorkoutSummaryMetrics,
  ): Promise<AiSummaryContent> {
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not configured.');
    }

    const userPayload = {
      trainingDay: dayName,
      note:
        'All comparisons below are against the SAME training day only ' +
        '(previous and last few sessions of this exact day). Never compare to ' +
        'other training days.',
      ...metrics,
    };

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
            { role: 'user', content: JSON.stringify(userPayload) },
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
      'You are given STRUCTURED metrics comparing a just-finished workout to the ' +
      "user's earlier sessions of the SAME training day only. Volume = sum of " +
      'weight × reps over working sets (warm-ups already excluded). Best set is ' +
      'by estimated 1RM = weight × (1 + reps / 30).\n' +
      'Rules: Use only the numbers provided. Never invent exercises or sessions. ' +
      'Never compare to a different training day. If isFirstSession is true, give ' +
      'a first-session baseline summary (nothing to compare yet) and set ' +
      '"assessment" to "first". If weight is 0 or missing for an exercise, reason ' +
      'about reps instead of volume. Keep every field short and mobile-readable.\n' +
      'Reply with STRICT JSON and no prose outside it:\n' +
      '{"assessment": "better"|"similar"|"worse"|"first", "headline": string (<=8 ' +
      'words), "summary": string (2-4 short sentences comparing to the previous ' +
      'same-day session: total volume change, total reps change, notable best-set ' +
      'moves), "improvements": string[] (exercises that improved, may be empty), ' +
      '"declines": string[] (exercises that dropped or stalled, may be empty), ' +
      '"exerciseNotes": string[] (0-4 short, specific per-exercise notes and ' +
      'next-time suggestions), "trendNote": string (1 sentence on the ~1-month ' +
      'trend across the last few same-day sessions: volume/strength/consistency), ' +
      '"effortNote": string|null (1 sentence on recovery/effort if RIR/RPE data ' +
      'exists, else null), "recommendation": string (ONE very short practical ' +
      'next-time cue, e.g. "Increase weight on bench", "Keep weight, add a rep", ' +
      '"Reduce fatigue").}'
    );
  }

  private parseContent(
    content: string,
    metrics: WorkoutSummaryMetrics,
  ): AiSummaryContent {
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
      headline: this.text(obj.headline) || 'Workout complete',
      summary,
      improvements: this.stringList(obj.improvements),
      declines: this.stringList(obj.declines),
      exerciseNotes: this.stringList(obj.exerciseNotes).slice(0, 4),
      trendNote: this.text(obj.trendNote),
      effortNote: this.text(obj.effortNote) || null,
      recommendation: this.text(obj.recommendation),
    };
  }

  private assessment(
    value: unknown,
    metrics: WorkoutSummaryMetrics,
  ): WorkoutAssessment {
    if (
      value === 'better' ||
      value === 'similar' ||
      value === 'worse' ||
      value === 'first'
    ) {
      return value;
    }
    return metrics.isFirstSession ? 'first' : 'similar';
  }

  // ── Fallback (no model) ──────────────────────────────────────────────────────

  /**
   * A deterministic summary for when the model cannot be reached: the numbers
   * are already computed, so the user still sees a truthful comparison and a
   * clear "AI note unavailable" message rather than an empty screen.
   */
  private fallbackContent(metrics: WorkoutSummaryMetrics): AiSummaryContent {
    if (metrics.isFirstSession || !metrics.previous) {
      return {
        assessment: 'first',
        headline: 'First session logged',
        summary:
          "This is your first recorded session for this training day, so " +
          "there's nothing to compare against yet. Your numbers below become " +
          'the baseline for next time.',
        improvements: [],
        declines: [],
        exerciseNotes: [],
        trendNote: '',
        effortNote: null,
        recommendation: 'Log this day again to start tracking progress.',
      };
    }

    const volDelta = round2(metrics.current.volume - metrics.previous.volume);
    const repsDelta = metrics.current.totalReps - metrics.previous.totalReps;
    const assessment: WorkoutAssessment =
      volDelta > 0 ? 'better' : volDelta < 0 ? 'worse' : 'similar';
    const dir = volDelta > 0 ? 'up' : volDelta < 0 ? 'down' : 'level';
    return {
      assessment,
      headline:
        volDelta > 0
          ? 'Volume up on last time'
          : volDelta < 0
            ? 'Volume down on last time'
            : 'On par with last time',
      summary:
        `Total volume ${dir} ${Math.abs(volDelta)} kg vs your previous ` +
        `session of this day (${metrics.current.volume} vs ` +
        `${metrics.previous.volume} kg), with ` +
        `${repsDelta >= 0 ? '+' : ''}${repsDelta} total reps. The AI coach note ` +
        'is unavailable right now — you can retry it below.',
      improvements: [],
      declines: [],
      exerciseNotes: [],
      trendNote: '',
      effortNote: null,
      recommendation:
        volDelta >= 0
          ? 'Keep progressing — aim to add a little next time.'
          : 'Aim to match or beat your previous numbers next time.',
    };
  }

  // ── Loading / coercion ───────────────────────────────────────────────────────

  private async loadCompletedSession(
    userId: number,
    sessionId: number,
  ): Promise<SummarySessionRow> {
    const result = await this.db.query<SummarySessionRow>(
      `SELECT s.id, s.user_id, s.training_day_id, s.template_day_id,
              s.completed_at, s.ai_summary_generated_at, s.ai_summary_json,
              COALESCE(d.day, td.name, 'Workout') AS day_name
         FROM workout_sessions s
         LEFT JOIN training_days d ON d.id = s.training_day_id
         LEFT JOIN training_template_days td ON td.id = s.template_day_id
        WHERE s.id = $1 AND s.user_id = $2 AND s.abandoned_at IS NULL`,
      [sessionId, userId],
    );
    const session = result.rows[0];
    if (!session) {
      throw new NotFoundException('Workout not found.');
    }
    if (session.completed_at === null) {
      throw new BadRequestException(
        'Finish the workout before generating its summary.',
      );
    }
    return session;
  }

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

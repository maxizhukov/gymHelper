import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../database/database.service';

/**
 * AI weight recommendations, generated once when a workout starts. For every
 * planned exercise the model is given the exercise's target (sets × reps, both
 * snapshotted onto the session) and the working sets of its last few *completed*
 * workouts — read straight from the database, warm-ups excluded — and it returns
 * one short line per exercise on whether to move the weight up, hold, or drop it.
 *
 * The rule the model follows is deliberately simple and set/rep-preserving: it
 * only ever suggests a weight change. If every target set was completed at the
 * target reps last time, nudge the weight up; if reps fell short on the later
 * sets, hold; if performance dropped, hold or drop; with no history, start
 * conservative.
 *
 * The recommendation is cached on the `workout_session_exercises` row it belongs
 * to (`ai_weight_recommendation` / `ai_weight_recommendation_json` /
 * `ai_weight_recommendation_generated_at`), so OpenAI is called exactly once per
 * workout — never again as the user walks through the exercises. Generation is
 * fire-and-forget from the start flow and never throws: a failed or unreachable
 * model leaves the recommendations null and the workout starts exactly as before.
 */

/** The chat-completions endpoint. */
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

/** Cost-efficient and more than capable for short structured recommendations. */
const OPENAI_MODEL = 'gpt-4o-mini';

/** Bound the wait so a hung upstream cannot hold generation open forever. */
const REQUEST_TIMEOUT_MS = 30_000;

/** How many previous completed workouts of the exercise feed the model. */
const HISTORY_WORKOUTS = 3;

/** The suggested direction, kept to a small closed set. */
export type WeightAction = 'increase' | 'keep' | 'decrease' | 'no_history';

/** One logged working set fed to the model. */
interface HistorySet {
  weight: number;
  reps: number;
  rir: number | null;
  rpe: number | null;
}

/** One past workout's worth of working sets for a single exercise. */
interface HistoryWorkout {
  date: string;
  sets: HistorySet[];
}

/** The compact per-exercise input handed to the model. */
interface ExerciseInput {
  sessionExerciseId: number;
  exerciseLibraryId: number | null;
  exerciseName: string;
  targetSets: number;
  targetReps: string;
  targetWeight: number | null;
  recentHistory: HistoryWorkout[];
}

/** The model's recommendation for one exercise, as stored on its row. */
export interface WeightRecommendation {
  sessionExerciseId: number;
  exerciseLibraryId: number | null;
  exerciseName: string;
  recommendation: string;
  action: WeightAction;
  suggestedWeight: number | null;
  confidence: 'high' | 'medium' | 'low';
}

interface SessionRow {
  id: number;
  user_id: number;
  sets_per_exercise: number;
  planned_reps: number;
}

interface ExerciseRow {
  id: number;
  exercise_library_id: number | null;
  name: string;
}

interface SetRow {
  session_id: number;
  completed_at: Date;
  weight: number;
  reps: number;
  rir: number | null;
  rpe: number | null;
}

@Injectable()
export class AiWeightRecommendationService {
  private readonly logger = new Logger(AiWeightRecommendationService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Gathers the data for every exercise in a just-started workout, calls OpenAI
   * once, and stores one recommendation per exercise. Never throws — it is called
   * fire-and-forget right after the workout is created, and a failure here must
   * leave the workout untouched. Skips work if recommendations already exist, so
   * a retried start does not pay twice.
   */
  async generateForSession(userId: number, sessionId: number): Promise<void> {
    try {
      const session = await this.loadSession(userId, sessionId);
      if (!session) return;

      const already = await this.db.query<{ count: string }>(
        `SELECT count(*) AS count
           FROM workout_session_exercises
          WHERE session_id = $1 AND ai_weight_recommendation_generated_at IS NOT NULL`,
        [sessionId],
      );
      if (Number(already.rows[0]?.count ?? 0) > 0) return;

      const exercises = await this.loadExercises(sessionId);
      if (exercises.length === 0) return;

      const inputs: ExerciseInput[] = [];
      for (const exercise of exercises) {
        inputs.push({
          sessionExerciseId: exercise.id,
          exerciseLibraryId: exercise.exercise_library_id,
          exerciseName: exercise.name,
          targetSets: session.sets_per_exercise,
          targetReps: String(session.planned_reps),
          // No per-exercise target weight is stored; the model infers from history.
          targetWeight: null,
          recentHistory: await this.recentHistory(userId, exercise),
        });
      }

      const recommendations = await this.callModel(inputs);
      await this.store(sessionId, inputs, recommendations);
    } catch (err) {
      this.logger.warn(
        `Weight recommendations for session ${sessionId} failed: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
  }

  // ── Data gathering ──────────────────────────────────────────────────────────

  private async loadSession(
    userId: number,
    sessionId: number,
  ): Promise<SessionRow | null> {
    const result = await this.db.query<SessionRow>(
      `SELECT id, user_id, sets_per_exercise, planned_reps
         FROM workout_sessions
        WHERE id = $1 AND user_id = $2`,
      [sessionId, userId],
    );
    return result.rows[0] ?? null;
  }

  private async loadExercises(sessionId: number): Promise<ExerciseRow[]> {
    const result = await this.db.query<ExerciseRow>(
      `SELECT id, exercise_library_id, name
         FROM workout_session_exercises
        WHERE session_id = $1
        ORDER BY position`,
      [sessionId],
    );
    return result.rows;
  }

  /**
   * The working sets of this exercise's last few completed workouts, newest
   * first. Resolved by `exercise_library_id` when the exercise has one (a
   * Training Builder workout), else by the snapshotted name (a legacy plan) —
   * the same identity rules the Previous Performance panel uses. Warm-up sets are
   * excluded; the in-progress workout has no `completed_at` and so never appears.
   */
  private async recentHistory(
    userId: number,
    exercise: ExerciseRow,
  ): Promise<HistoryWorkout[]> {
    const byLibrary = exercise.exercise_library_id !== null;
    const matchPredicate = byLibrary
      ? 'e.exercise_library_id = $2'
      : 'e.name = $2';
    const matchValue: number | string = byLibrary
      ? (exercise.exercise_library_id as number)
      : exercise.name;

    // The most recent completed workouts that logged a working set on this
    // exercise. Bounded here so the sets query below reads at most a few workouts.
    const workoutsResult = await this.db.query<{
      id: number;
      completed_at: Date;
    }>(
      `SELECT s.id, s.completed_at
         FROM workout_sessions s
        WHERE s.user_id = $1
          AND s.completed_at IS NOT NULL
          AND EXISTS (
                SELECT 1
                  FROM workout_session_exercises e
                  JOIN workout_sets ws ON ws.exercise_id = e.id
                 WHERE e.session_id = s.id
                   AND ${matchPredicate}
                   AND ws.is_warmup = false
              )
        ORDER BY s.completed_at DESC
        LIMIT ${HISTORY_WORKOUTS}`,
      [userId, matchValue],
    );
    const workouts = workoutsResult.rows;
    if (workouts.length === 0) return [];

    const setsResult = await this.db.query<SetRow>(
      `SELECT ws.workout_session_id AS session_id, s.completed_at,
              ws.actual_weight::float8 AS weight, ws.actual_reps AS reps,
              ws.rir::float8 AS rir, ws.rpe::float8 AS rpe
         FROM workout_sets ws
         JOIN workout_sessions s ON s.id = ws.workout_session_id
         JOIN workout_session_exercises e ON e.id = ws.exercise_id
        WHERE ws.workout_session_id = ANY($1::int[])
          AND ${matchPredicate}
          AND ws.is_warmup = false
        ORDER BY ws.workout_session_id, ws.set_number`,
      [workouts.map((workout) => workout.id), matchValue],
    );

    const setsBySession = new Map<number, HistorySet[]>();
    for (const row of setsResult.rows) {
      const sets = setsBySession.get(row.session_id) ?? [];
      sets.push({
        weight: row.weight,
        reps: row.reps,
        rir: row.rir,
        rpe: row.rpe,
      });
      setsBySession.set(row.session_id, sets);
    }

    // Newest first, matching the workout query's order.
    return workouts
      .map((workout) => ({
        date: workout.completed_at.toISOString(),
        sets: setsBySession.get(workout.id) ?? [],
      }))
      .filter((workout) => workout.sets.length > 0);
  }

  // ── Model call ──────────────────────────────────────────────────────────────

  private async callModel(
    inputs: ExerciseInput[],
  ): Promise<WeightRecommendation[]> {
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
            { role: 'user', content: JSON.stringify({ exercises: inputs }) },
          ],
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new Error('Could not reach the recommendation service.');
    }

    if (!res.ok) {
      throw new Error(`Recommendation service returned HTTP ${res.status}.`);
    }

    const payload = (await res.json().catch(() => null)) as {
      choices?: { message?: { content?: string } }[];
    } | null;
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('Recommendation service returned an unexpected response.');
    }
    return this.parseContent(content, inputs);
  }

  private systemPrompt(): string {
    return (
      'You are a concise strength-training coach inside a gym app. For each ' +
      'planned exercise you are given its target sets and reps and the working ' +
      'sets (warm-ups already excluded) of its most recent completed workouts, ' +
      'newest first. Your ONLY job is to advise whether to change the WEIGHT this ' +
      'session. Sets and reps stay fixed — never suggest changing them.\n' +
      'Rules: Use only the data provided; never invent sets, weights, or ' +
      'sessions. Reason per exercise:\n' +
      '- If the most recent session completed all target sets at (or above) the ' +
      'target reps, suggest a small increase (typically +2.5kg, or +1.25kg for ' +
      'light isolation work).\n' +
      '- If some sets fell below the target reps (especially later sets), suggest ' +
      'keeping the same weight.\n' +
      '- If performance clearly dropped versus earlier sessions, suggest keeping ' +
      'or lowering the weight.\n' +
      '- If there is no history, say to start conservative and record clean sets.\n' +
      'Each "recommendation" is ONE short, practical line (no motivation), ' +
      'mentioning the concrete weight when you can, e.g. "Increase to 12.5kg: you ' +
      'completed all sets at 10kg last time." or "Keep 10kg: reps dropped on the ' +
      'later sets last time." Keep it mobile-readable.\n' +
      'Reply with STRICT JSON and no prose outside it, echoing every exercise by ' +
      'its sessionExerciseId:\n' +
      '{"recommendations": [{"sessionExerciseId": number, "exerciseLibraryId": ' +
      'number|null, "exerciseName": string, "recommendation": string, "action": ' +
      '"increase"|"keep"|"decrease"|"no_history", "suggestedWeight": number|null, ' +
      '"confidence": "high"|"medium"|"low"}]}'
    );
  }

  private parseContent(
    content: string,
    inputs: ExerciseInput[],
  ): WeightRecommendation[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error('Recommendation service returned invalid JSON.');
    }
    const list =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { recommendations?: unknown }).recommendations
        : undefined;
    if (!Array.isArray(list)) {
      throw new Error('Recommendation service returned no recommendations.');
    }

    // Index the model output by the id it echoed, so a reordered or partial reply
    // still lands each recommendation on the right exercise.
    const byId = new Map<number, Record<string, unknown>>();
    for (const item of list) {
      if (typeof item !== 'object' || item === null) continue;
      const obj = item as Record<string, unknown>;
      const id = Number(obj.sessionExerciseId);
      if (Number.isInteger(id)) byId.set(id, obj);
    }

    const recommendations: WeightRecommendation[] = [];
    for (const input of inputs) {
      const obj = byId.get(input.sessionExerciseId);
      const text = this.text(obj?.recommendation);
      if (!text) continue;
      recommendations.push({
        sessionExerciseId: input.sessionExerciseId,
        exerciseLibraryId: input.exerciseLibraryId,
        exerciseName: input.exerciseName,
        recommendation: text,
        action: this.action(obj?.action),
        suggestedWeight: this.number(obj?.suggestedWeight),
        confidence: this.confidence(obj?.confidence),
      });
    }
    return recommendations;
  }

  // ── Storage ─────────────────────────────────────────────────────────────────

  private async store(
    sessionId: number,
    inputs: ExerciseInput[],
    recommendations: WeightRecommendation[],
  ): Promise<void> {
    if (recommendations.length === 0) return;
    const byId = new Map(
      recommendations.map((rec) => [rec.sessionExerciseId, rec]),
    );
    // One transaction so every exercise's recommendation lands together — the
    // start flow reads them back as a set.
    await this.db.transaction(async (client) => {
      for (const input of inputs) {
        const rec = byId.get(input.sessionExerciseId);
        if (!rec) continue;
        await client.query(
          `UPDATE workout_session_exercises
              SET ai_weight_recommendation = $3,
                  ai_weight_recommendation_json = $4::jsonb,
                  ai_weight_recommendation_generated_at = now()
            WHERE id = $1 AND session_id = $2`,
          [rec.sessionExerciseId, sessionId, rec.recommendation, JSON.stringify(rec)],
        );
      }
    });
  }

  // ── Coercion ────────────────────────────────────────────────────────────────

  private text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private number(value: unknown): number | null {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : null;
  }

  private action(value: unknown): WeightAction {
    return value === 'increase' ||
      value === 'keep' ||
      value === 'decrease' ||
      value === 'no_history'
      ? value
      : 'keep';
  }

  private confidence(value: unknown): 'high' | 'medium' | 'low' {
    return value === 'high' || value === 'medium' || value === 'low'
      ? value
      : 'low';
  }
}

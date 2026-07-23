import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { bootstrapSchema } from '../database/bootstrap-schema';
import { DatabaseService } from '../database/database.service';
import { TrainingConfigService } from '../training/training-config.service';
import { AiWeightRecommendationService } from './ai-weight-recommendation.service';
import { AiWorkoutSummaryService } from './ai-workout-summary.service';

/**
 * Workout tracking. The database is the single source of truth: every user
 * action is written before the response is sent, and the state the frontend
 * renders is always read back from these tables. Nothing about an in-progress
 * workout lives in memory, so a crash costs at most the tap in flight.
 *
 * The cursor (which exercise, which set, whether we are resting) lives on the
 * `workout_sessions` row. Completed sets accumulate in `workout_sets`, in-flight
 * keypad input in `workout_set_drafts`, and an append-only audit of what the
 * user did in `workout_events`.
 *
 * Identity and order are deliberately separate concerns:
 *
 * - **Identity** is `workout_session_exercises.id` — a surrogate key minted when
 *   the workout starts and never reused, renumbered, or reassigned. It answers
 *   "which exercise was this?". Everything that records what the user *did*
 *   (`workout_sets`, `workout_set_drafts`, `workout_events`) points at it.
 * - **Order** is `workout_session_exercises.position` — a mutable queue index,
 *   rewritten in place whenever the user defers an exercise. It answers "when
 *   does this exercise come up?" and nothing else. Only the session cursor
 *   (`workout_sessions.exercise_position`) reads it.
 *
 * Deferring an exercise therefore rewrites positions and touches no history: a
 * logged set names the exercise it belongs to directly, so the queue can be
 * reordered any number of times and every set still resolves to the lift that
 * was actually performed.
 *
 * The identity is per session, not per plan row: the exercise list is
 * snapshotted at start (`name`, plus `catalog_exercise_id` for provenance), so
 * editing or deleting a plan exercise later cannot rename, renumber, or orphan
 * the sets of a workout already recorded.
 */

// Bounds mirror the CHECK constraints below; both exist on purpose. The DTO is
// the first gate, the constraint the last one for anything reaching the table
// another way.
export const WEIGHT_MIN = 0;
export const WEIGHT_MAX = 1000;
export const REPS_MIN = 1;
export const REPS_MAX = 100;

// Optional effort markers on a logged set. RIR (reps in reserve) is a whole
// count; RPE (rate of perceived exertion) is the 0–10 scale, half-points
// allowed. Both mirror the CHECK constraints on the table.
export const RIR_MIN = 0;
export const RIR_MAX = 50;
export const RPE_MIN = 0;
export const RPE_MAX = 10;

/** The optional effort/warmup markers a set may carry. */
export interface SetDetails {
  rir: number | null;
  rpe: number | null;
  isWarmup: boolean;
}

// A human body weight in kilograms. Anything outside this is a typo — a slipped
// decimal point or a reading in pounds — not a value worth charting later.
export const BODY_WEIGHT_MIN = 20;
export const BODY_WEIGHT_MAX = 400;

/** Postgres error code for a unique-constraint violation. */
const UNIQUE_VIOLATION = '23505';

/** How many past workouts the Previous Performance panel lists. */
const HISTORY_WORKOUTS = 5;

/** What the user did, in order. Append-only; never updated or deleted. */
export type WorkoutEventKind =
  | 'workout_started'
  | 'exercise_started'
  | 'set_completed'
  | 'rest_started'
  | 'rest_finished'
  | 'next_set_started'
  | 'exercise_deferred'
  | 'workout_completed'
  | 'workout_abandoned';

/** Where the workout screen is: logging a set, resting, or finished. */
export type WorkoutPhase = 'set' | 'rest' | 'completed';

export interface WorkoutExercise {
  position: number;
  name: string;
  /** The library movement this exercise is, or null for a legacy-plan exercise
   *  that has no library link. Exercise history keys on this. */
  exerciseLibraryId: number | null;
  /** True once the user has pushed this one back at least once. */
  deferred: boolean;
  /** Sets logged against this exercise — counted by identity, so a reordered
   *  queue never moves a set from one exercise to another. */
  completedSets: number;
  /** The one-line AI weight recommendation generated at workout start, or null
   *  when none was generated (no OpenAI, a failure, or not yet landed). */
  aiWeightRecommendation: string | null;
}

/**
 * Everything the workout screen renders, reconstructed from the database on
 * every read. Timers are sent as server-computed second counts (plus the
 * timestamps they derive from) so the client never has to trust its own clock
 * for anything but the cosmetic tick between polls.
 */
export interface WorkoutState {
  id: number;
  daySlug: string;
  dayName: string;
  focus: string;
  phase: WorkoutPhase;

  startedAt: string;
  completedAt: string | null;
  /** Wall-clock seconds since the workout started (frozen once completed). */
  elapsedSeconds: number;

  exercises: WorkoutExercise[];
  exerciseIndex: number;
  exerciseCount: number;
  exerciseName: string;
  /** The library id of the current exercise, or null for a legacy-plan one.
   *  The Previous Performance panel prefers this over the name when present. */
  exerciseLibraryId: number | null;

  /** Deferred exercises still waiting later in the queue. Informational. */
  deferredCount: number;

  setNumber: number;
  setsPerExercise: number;
  targetReps: number;

  /** Prefill for the weight input: the saved draft, else the last weight
   *  lifted on this exercise, else null when there is no history. */
  plannedWeight: number | null;
  /** Reps typed into the draft, if any; otherwise the target. */
  draftReps: number | null;

  restSeconds: number;
  /** Seconds left on the rest timer, or null when not resting. Never negative:
   *  a finished countdown reads 0 and waits for the user. */
  restRemainingSeconds: number | null;

  setsCompleted: number;
  exercisesCompleted: number;

  /** What the user weighed at the end of this workout, in kg. Null when they
   *  skipped the question — a workout with no scale to hand records nothing
   *  rather than carrying the previous workout's number forward. */
  bodyWeightKg: number | null;
}

/** One logged set of a past workout. */
export interface HistorySet {
  setNumber: number;
  weight: number;
  reps: number;
}

/** One past workout's worth of sets for a single exercise, newest first. */
export interface HistoryWorkout {
  workoutId: number;
  completedAt: string;
  sets: HistorySet[];
}

/**
 * What the Previous Performance panel renders for one exercise. Computed here
 * so the client never has to hold — or page through — the full set history.
 */
export interface ExerciseHistory {
  exerciseName: string;
  /** The most recent completed workout, also `recent[0]` when present. */
  last: HistoryWorkout | null;
  /** Up to five completed workouts, newest first. */
  recent: HistoryWorkout[];
  /** The heaviest set ever logged, best reps breaking a tie. */
  best: { weight: number; reps: number } | null;
}

interface SessionRow {
  id: number;
  user_id: number;
  training_day_id: number | null;
  template_day_id: number | null;
  slug: string;
  day: string;
  focus: string;
  started_at: Date;
  completed_at: Date | null;
  /** Cursor into the queue — a position, never an exercise identity. */
  exercise_position: number;
  set_number: number;
  resting_since: Date | null;
  /** When the user arrived at the current set; stamped onto the set it logs. */
  set_started_at: Date | null;
  planned_reps: number;
  rest_seconds: number;
  sets_per_exercise: number;
  /** NUMERIC: `pg` hands it back as a string, or as a number once cast. */
  body_weight_kg: string | number | null;
  server_now: Date;
}

/**
 * A NUMERIC column as a JavaScript number. `pg` returns NUMERIC as a string to
 * keep the precision it cannot fit in a double; a body weight has two decimal
 * places and loses nothing here. Null — never recorded — stays null.
 */
function numericOrNull(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Every read of a session resolves the day it belongs to and stamps the
// server's clock, so elapsed/remaining seconds are computed against the
// database's time rather than the browser's. A session comes from either a
// legacy `training_days` row or a Training Builder day, so both are LEFT JOINed
// and the display fields fall through to whichever is present. The slug is
// synthesised for template days — the frontend only uses it as an opaque label.
const SESSION_SELECT = `
  SELECT s.id, s.user_id, s.training_day_id, s.template_day_id, s.started_at,
         s.completed_at, s.exercise_position, s.set_number, s.resting_since,
         s.set_started_at, s.planned_reps, s.rest_seconds, s.sets_per_exercise,
         s.body_weight_kg,
         COALESCE(d.slug, 'tpl-' || s.template_day_id::text, 'workout-' || s.id::text) AS slug,
         COALESCE(d.day, td.name, 'Workout') AS day,
         COALESCE(d.focus, t.name, '') AS focus,
         now() AS server_now
    FROM workout_sessions s
    LEFT JOIN training_days d ON d.id = s.training_day_id
    LEFT JOIN training_template_days td ON td.id = s.template_day_id
    LEFT JOIN training_templates t ON t.id = td.template_id
`;

/** An active session is one that was neither completed nor abandoned. */
const ACTIVE_PREDICATE = 's.completed_at IS NULL AND s.abandoned_at IS NULL';

/** Runs a query on the transaction's client when there is one, else the pool. */
type Run = <T extends Record<string, unknown>>(
  text: string,
  params: unknown[],
) => Promise<{ rows: T[]; rowCount: number | null }>;

@Injectable()
export class WorkoutService implements OnModuleInit {
  private readonly logger = new Logger(WorkoutService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly trainingConfig: TrainingConfigService,
    private readonly aiSummary: AiWorkoutSummaryService,
    private readonly aiWeightRecommendation: AiWeightRecommendationService,
  ) {}

  async onModuleInit(): Promise<void> {
    await bootstrapSchema(this.logger, 'Workout', () => this.ensureSchema());
  }

  /**
   * Brings the schema to its current shape: create what is missing, migrate what
   * predates the identity/order split, then index the final columns. Split in
   * three because the indexes name columns that only exist after the migration,
   * and the migration needs the tables to exist first.
   */
  async ensureSchema(): Promise<void> {
    await this.createTables();
    await this.db.transaction((client) =>
      this.migrateToExerciseIdentity(client),
    );
    await this.createIndexes();
  }

  private async createTables(): Promise<void> {
    // planned_reps / rest_seconds / sets_per_exercise are snapshotted from the
    // user's config when the workout starts, so editing the config mid-workout
    // does not reshape a workout already underway.
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS workout_sessions (
        id                SERIAL PRIMARY KEY,
        user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        training_day_id   INTEGER NOT NULL REFERENCES training_days(id) ON DELETE CASCADE,
        started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_at      TIMESTAMPTZ,
        abandoned_at      TIMESTAMPTZ,
        exercise_position INTEGER NOT NULL DEFAULT 0 CHECK (exercise_position >= 0),
        set_number        INTEGER NOT NULL DEFAULT 1 CHECK (set_number >= 1),
        resting_since     TIMESTAMPTZ,
        set_started_at    TIMESTAMPTZ DEFAULT now(),
        planned_reps      INTEGER NOT NULL CHECK (planned_reps BETWEEN 1 AND 100),
        rest_seconds      INTEGER NOT NULL CHECK (rest_seconds BETWEEN 0 AND 3600),
        sets_per_exercise INTEGER NOT NULL CHECK (sets_per_exercise BETWEEN 1 AND 20),
        body_weight_kg    NUMERIC(5, 2) CHECK (body_weight_kg BETWEEN 20 AND 400)
      )
    `);

    // The workout owns the body weight recorded at the end of it: one measurement
    // per session, taken at a known time, alongside the sets it belongs with.
    // That is the shape the weight chart and the strength-per-kilo view want —
    // a separate table would only re-derive this join. Nullable because the user
    // may skip the question, and a skipped workout must not inherit a stale
    // number. Added after the table shipped; existing sessions read null.
    //
    // Postgres skips the whole clause when the column is already there, so the
    // CHECK is not re-added on every boot.
    await this.db.query(`
      ALTER TABLE workout_sessions
        ADD COLUMN IF NOT EXISTS body_weight_kg NUMERIC(5, 2)
          CHECK (body_weight_kg BETWEEN 20 AND 400)
    `);

    // A workout can now be started from a Training Builder day as well as from a
    // legacy `training_days` row. Exactly one of the two source columns is set
    // per session (enforced in code where the session is created). training_day_id
    // becomes nullable for template-sourced sessions; template_day_id is added
    // for them. ON DELETE SET NULL on the template link keeps a finished
    // workout's history intact after its template is deleted — the session still
    // owns its snapshotted exercises and sets.
    await this.db.query(
      'ALTER TABLE workout_sessions ALTER COLUMN training_day_id DROP NOT NULL',
    );
    await this.db.query(
      `ALTER TABLE workout_sessions
         ADD COLUMN IF NOT EXISTS template_day_id INTEGER
           REFERENCES training_template_days(id) ON DELETE SET NULL`,
    );

    // The AI post-workout summary, cached on the session it describes so a
    // finished workout is summarised once rather than on every visit.
    // `ai_summary_json` holds the model narrative plus the deterministic metrics
    // it was built from; `ai_summary_text` is the plain-text summary for a quick
    // read; `ai_summary_generated_at` doubles as the "already generated" flag.
    // All nullable and added after the table shipped, so existing sessions read
    // null and are summarised lazily on first view.
    await this.db.query(`
      ALTER TABLE workout_sessions
        ADD COLUMN IF NOT EXISTS ai_summary_text TEXT,
        ADD COLUMN IF NOT EXISTS ai_summary_json JSONB,
        ADD COLUMN IF NOT EXISTS ai_summary_generated_at TIMESTAMPTZ
    `);

    // The session's exercise queue, and the workout's exercise identities.
    //
    // `id` is the identity: minted here, pointed at by every row that records
    // what the user did, and never reused. `position` is the running order,
    // rewritten in place whenever the user defers. Nothing but the cursor reads
    // `position`, so reordering the queue can never reattribute a logged set.
    //
    // The exercise list is snapshotted per session, so editing the plan later
    // cannot renumber or rename the exercises of a workout already in progress.
    // `catalog_exercise_id` is kept for provenance but nulls out if the plan row
    // is deleted — the snapshotted name is what the workout screen renders, and
    // history stays intact either way.
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS workout_session_exercises (
        id                  SERIAL PRIMARY KEY,
        session_id          INTEGER NOT NULL REFERENCES workout_sessions(id) ON DELETE CASCADE,
        position            INTEGER NOT NULL,
        catalog_exercise_id INTEGER REFERENCES exercises(id) ON DELETE SET NULL,
        exercise_library_id INTEGER REFERENCES exercise_library(id) ON DELETE SET NULL,
        name                TEXT NOT NULL,
        deferred_at         TIMESTAMPTZ,
        UNIQUE (session_id, position)
      )
    `);
    // Added after the table shipped; workouts already in flight keep their rows.
    await this.db.query(
      'ALTER TABLE workout_session_exercises ADD COLUMN IF NOT EXISTS deferred_at TIMESTAMPTZ',
    );
    // The library movement this exercise is, snapshotted at start so exercise
    // history can be resolved by `exercise_library_id` across every workout —
    // removing an exercise from a template and adding it back later still finds
    // its past sets. Nullable: a workout started from the legacy plan (whose
    // exercises are named text with no library link) records nothing here.
    await this.db.query(
      `ALTER TABLE workout_session_exercises
         ADD COLUMN IF NOT EXISTS exercise_library_id INTEGER
           REFERENCES exercise_library(id) ON DELETE SET NULL`,
    );

    // The AI weight recommendation for this exercise, generated once when the
    // workout starts and shown under the exercise name while training. Cached on
    // the exercise row so OpenAI is called once per workout, never again as the
    // user walks through the exercises. `ai_weight_recommendation` is the short
    // line the screen renders; `ai_weight_recommendation_json` keeps the full
    // structured recommendation (action / suggested weight / confidence);
    // `ai_weight_recommendation_generated_at` doubles as the "already generated"
    // flag. All nullable and added after the table shipped, so existing rows read
    // null and simply show nothing.
    await this.db.query(`
      ALTER TABLE workout_session_exercises
        ADD COLUMN IF NOT EXISTS ai_weight_recommendation TEXT,
        ADD COLUMN IF NOT EXISTS ai_weight_recommendation_json JSONB,
        ADD COLUMN IF NOT EXISTS ai_weight_recommendation_generated_at TIMESTAMPTZ
    `);

    // One row per completed set, naming the exercise it belongs to by identity.
    // The unique key makes the write idempotent, so a retried "Finish set"
    // overwrites rather than duplicating.
    //
    // planned_* is what the workout asked for, actual_* what the user managed.
    // started_at/completed_at bracket the set; rest_duration is the pause taken
    // after it, filled in when rest ends (null for a set nobody rested after).
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS workout_sets (
        id                 SERIAL PRIMARY KEY,
        workout_session_id INTEGER NOT NULL REFERENCES workout_sessions(id) ON DELETE CASCADE,
        exercise_id        INTEGER NOT NULL REFERENCES workout_session_exercises(id) ON DELETE CASCADE,
        set_number         INTEGER NOT NULL,
        planned_reps       INTEGER NOT NULL,
        actual_reps        INTEGER NOT NULL CHECK (actual_reps BETWEEN 1 AND 100),
        planned_weight     NUMERIC(6, 2) CHECK (planned_weight >= 0 AND planned_weight <= 1000),
        actual_weight      NUMERIC(6, 2) NOT NULL CHECK (actual_weight >= 0 AND actual_weight <= 1000),
        started_at         TIMESTAMPTZ,
        completed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        rest_duration      INTEGER CHECK (rest_duration >= 0),
        rir                SMALLINT CHECK (rir BETWEEN 0 AND 50),
        rpe                NUMERIC(3, 1) CHECK (rpe BETWEEN 0 AND 10),
        is_warmup          BOOLEAN NOT NULL DEFAULT false,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (workout_session_id, exercise_id, set_number)
      )
    `);
    // Optional per-set effort markers, added after the table shipped. A set
    // logged before these existed reads null RIR/RPE and a non-warmup flag.
    await this.db.query(`
      ALTER TABLE workout_sets
        ADD COLUMN IF NOT EXISTS rir       SMALLINT CHECK (rir BETWEEN 0 AND 50),
        ADD COLUMN IF NOT EXISTS rpe       NUMERIC(3, 1) CHECK (rpe BETWEEN 0 AND 10),
        ADD COLUMN IF NOT EXISTS is_warmup BOOLEAN NOT NULL DEFAULT false
    `);

    // Keypad input persisted as it is typed, before the set is committed. Keyed
    // to the exercise, so a crash mid-entry restores exactly what was on screen
    // and a deferred exercise carries its half-typed numbers with it.
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS workout_set_drafts (
        session_id  INTEGER NOT NULL REFERENCES workout_sessions(id) ON DELETE CASCADE,
        exercise_id INTEGER NOT NULL REFERENCES workout_session_exercises(id) ON DELETE CASCADE,
        set_number  INTEGER NOT NULL,
        weight      NUMERIC(6, 2) CHECK (weight >= 0 AND weight <= 1000),
        reps        INTEGER CHECK (reps BETWEEN 1 AND 100),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (session_id, exercise_id, set_number)
      )
    `);

    // Append-only audit of every significant action, so the workout can be
    // reconstructed or inspected after the fact. `exercise_id` says which
    // exercise; `exercise_position` records where it sat in the queue at the
    // time, which is a fact about the past and so is never rewritten.
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS workout_events (
        id                SERIAL PRIMARY KEY,
        session_id        INTEGER NOT NULL REFERENCES workout_sessions(id) ON DELETE CASCADE,
        kind              TEXT NOT NULL,
        exercise_position INTEGER,
        exercise_id       INTEGER REFERENCES workout_session_exercises(id) ON DELETE SET NULL,
        set_number        INTEGER,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  private async createIndexes(): Promise<void> {
    // At most one unfinished workout per user. The partial unique index is what
    // makes "start" safe against a double tap: the second insert loses.
    await this.db.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS workout_sessions_one_active_per_user
        ON workout_sessions (user_id)
        WHERE completed_at IS NULL AND abandoned_at IS NULL
    `);
    await this.db.query(
      'CREATE INDEX IF NOT EXISTS workout_sessions_user_id_idx ON workout_sessions (user_id)',
    );
    await this.db.query(
      'CREATE INDEX IF NOT EXISTS workout_session_exercises_session_id_idx ON workout_session_exercises (session_id)',
    );
    await this.db.query(
      'CREATE INDEX IF NOT EXISTS workout_sets_workout_session_id_idx ON workout_sets (workout_session_id)',
    );
    // Resolving an exercise's history — "what did I last lift on this?" — walks
    // sets by exercise, never by position.
    await this.db.query(
      'CREATE INDEX IF NOT EXISTS workout_sets_exercise_id_idx ON workout_sets (exercise_id)',
    );
    // Exercises are the same lift across workouts when they share a name — that
    // is how the prefill and the Previous Performance panel find their history.
    await this.db.query(
      'CREATE INDEX IF NOT EXISTS workout_session_exercises_name_idx ON workout_session_exercises (name)',
    );
    await this.db.query(
      'CREATE INDEX IF NOT EXISTS workout_events_session_id_idx ON workout_events (session_id)',
    );
  }

  private async columnExists(
    client: PoolClient,
    table: string,
    column: string,
  ): Promise<boolean> {
    const result = await client.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = $1 AND column_name = $2`,
      [table, column],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Migrates a database that identified exercises by their queue position onto
   * the identity/order split described at the top of this file. Idempotent and
   * guarded on the legacy columns, so it is a no-op on a fresh database and on
   * every boot after the first.
   *
   * Backfilling `workout_sets.exercise_id` from `exercise_index` is exact, not a
   * best guess. Under the old rules an exercise could only be deferred while it
   * had no sets logged against it, and a defer renumbered only the cursor and
   * the positions behind it. A position with sets under it therefore never
   * moved, and its current occupant is the exercise those sets were recorded
   * against. The same argument covers the drafts, which were deleted from the
   * cursor back on every defer.
   *
   * Events are the exception: an event's `exercise_index` was the queue position
   * *at the time it happened*, and a later defer may have moved a different
   * exercise there. Rather than invent an identity for historical events, the
   * column is renamed to `exercise_position` — which is what it always was — and
   * `exercise_id` is left null for rows written before this migration.
   */
  private async migrateToExerciseIdentity(client: PoolClient): Promise<void> {
    // ---- workout_sessions: the cursor is a position; say so. ----------------
    if (await this.columnExists(client, 'workout_sessions', 'exercise_index')) {
      await client.query(
        'ALTER TABLE workout_sessions RENAME COLUMN exercise_index TO exercise_position',
      );
    }
    await client.query(
      'ALTER TABLE workout_sessions ADD COLUMN IF NOT EXISTS set_started_at TIMESTAMPTZ DEFAULT now()',
    );

    // ---- workout_session_exercises: mint the identities. --------------------
    // The old primary key was (session_id, position) — an identity built out of
    // a mutable position, which is the bug this migration exists to remove.
    if (!(await this.columnExists(client, 'workout_session_exercises', 'id'))) {
      await client.query(
        'ALTER TABLE workout_session_exercises DROP CONSTRAINT IF EXISTS workout_session_exercises_pkey',
      );
      await client.query(
        'ALTER TABLE workout_session_exercises ADD COLUMN id SERIAL',
      );
      await client.query(
        'ALTER TABLE workout_session_exercises ADD PRIMARY KEY (id)',
      );
      await client.query(
        `ALTER TABLE workout_session_exercises
           ADD CONSTRAINT workout_session_exercises_session_id_position_key
           UNIQUE (session_id, position)`,
      );
    }
    // Frees the name `exercise_id` to mean the identity everywhere else.
    if (
      await this.columnExists(
        client,
        'workout_session_exercises',
        'exercise_id',
      )
    ) {
      await client.query(
        'ALTER TABLE workout_session_exercises RENAME COLUMN exercise_id TO catalog_exercise_id',
      );
    }

    // ---- workout_sets: point at the exercise, not at a slot in the queue. ---
    if (await this.columnExists(client, 'workout_sets', 'exercise_index')) {
      await client.query(
        'ALTER TABLE workout_sets RENAME COLUMN session_id TO workout_session_id',
      );
      await client.query(
        'ALTER TABLE workout_sets RENAME COLUMN target_reps TO planned_reps',
      );
      await client.query(
        'ALTER TABLE workout_sets RENAME COLUMN reps TO actual_reps',
      );
      await client.query(
        'ALTER TABLE workout_sets RENAME COLUMN weight TO actual_weight',
      );
      await client.query(
        'ALTER INDEX IF EXISTS workout_sets_session_id_idx RENAME TO workout_sets_workout_session_id_idx',
      );

      // Postgres does not rename a constraint when its column is renamed, so a
      // migrated database would otherwise keep the old names for good and drift
      // from a freshly created one. Converge them, or the next migration that
      // says DROP CONSTRAINT works on exactly one of the two.
      await client.query(
        `ALTER TABLE workout_sets
           RENAME CONSTRAINT workout_sets_session_id_fkey TO workout_sets_workout_session_id_fkey`,
      );
      await client.query(
        'ALTER TABLE workout_sets RENAME CONSTRAINT workout_sets_reps_check TO workout_sets_actual_reps_check',
      );
      await client.query(
        'ALTER TABLE workout_sets RENAME CONSTRAINT workout_sets_weight_check TO workout_sets_actual_weight_check',
      );

      // Unknown for sets logged before these columns existed. Left null rather
      // than backfilled with a plausible-looking guess.
      await client.query(
        `ALTER TABLE workout_sets
           ADD COLUMN IF NOT EXISTS planned_weight NUMERIC(6, 2)
             CHECK (planned_weight >= 0 AND planned_weight <= 1000),
           ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
           ADD COLUMN IF NOT EXISTS rest_duration INTEGER CHECK (rest_duration >= 0),
           ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ`,
      );
      // A set's row was created when the set was completed, so that is the
      // truthful created_at for historical rows — not the time of this migration.
      await client.query(
        'UPDATE workout_sets SET created_at = completed_at WHERE created_at IS NULL',
      );
      await client.query(
        `ALTER TABLE workout_sets
           ALTER COLUMN created_at SET NOT NULL,
           ALTER COLUMN created_at SET DEFAULT now()`,
      );

      await client.query(
        'ALTER TABLE workout_sets ADD COLUMN IF NOT EXISTS exercise_id INTEGER',
      );
      await client.query(
        `UPDATE workout_sets ws
            SET exercise_id = e.id
           FROM workout_session_exercises e
          WHERE e.session_id = ws.workout_session_id
            AND e.position = ws.exercise_index
            AND ws.exercise_id IS NULL`,
      );

      // Fail safe: a set we cannot attribute to an exercise must not be silently
      // dropped or silently kept. Abort the transaction and leave the old schema
      // in place for a human to look at.
      const orphans = await client.query(
        'SELECT count(*) AS count FROM workout_sets WHERE exercise_id IS NULL',
      );
      const orphanCount = Number(
        (orphans.rows[0] as { count: string } | undefined)?.count ?? 0,
      );
      if (orphanCount > 0) {
        throw new Error(
          `Cannot migrate workout_sets: ${orphanCount} set(s) have no exercise at their recorded position.`,
        );
      }

      await client.query(
        `ALTER TABLE workout_sets
           ALTER COLUMN exercise_id SET NOT NULL,
           ADD CONSTRAINT workout_sets_exercise_id_fkey
             FOREIGN KEY (exercise_id) REFERENCES workout_session_exercises(id) ON DELETE CASCADE,
           DROP CONSTRAINT IF EXISTS workout_sets_session_id_exercise_index_set_number_key,
           ADD CONSTRAINT workout_sets_workout_session_id_exercise_id_set_number_key
             UNIQUE (workout_session_id, exercise_id, set_number),
           DROP COLUMN exercise_index`,
      );
    }

    // ---- workout_set_drafts: same move, same reasoning. ---------------------
    if (
      await this.columnExists(client, 'workout_set_drafts', 'exercise_index')
    ) {
      await client.query(
        'ALTER TABLE workout_set_drafts ADD COLUMN IF NOT EXISTS exercise_id INTEGER',
      );
      await client.query(
        `UPDATE workout_set_drafts d
            SET exercise_id = e.id
           FROM workout_session_exercises e
          WHERE e.session_id = d.session_id
            AND e.position = d.exercise_index
            AND d.exercise_id IS NULL`,
      );
      // A draft is throwaway keypad input, not history: one we cannot attribute
      // is dropped rather than blocking the migration.
      await client.query(
        'DELETE FROM workout_set_drafts WHERE exercise_id IS NULL',
      );
      await client.query(
        `ALTER TABLE workout_set_drafts
           ALTER COLUMN exercise_id SET NOT NULL,
           ADD CONSTRAINT workout_set_drafts_exercise_id_fkey
             FOREIGN KEY (exercise_id) REFERENCES workout_session_exercises(id) ON DELETE CASCADE,
           DROP CONSTRAINT IF EXISTS workout_set_drafts_pkey,
           ADD PRIMARY KEY (session_id, exercise_id, set_number),
           DROP COLUMN exercise_index`,
      );
    }

    // ---- workout_events: a position is what it recorded; keep it as one. ----
    if (await this.columnExists(client, 'workout_events', 'exercise_index')) {
      await client.query(
        'ALTER TABLE workout_events RENAME COLUMN exercise_index TO exercise_position',
      );
    }
    await client.query(
      `ALTER TABLE workout_events
         ADD COLUMN IF NOT EXISTS exercise_id INTEGER
           REFERENCES workout_session_exercises(id) ON DELETE SET NULL`,
    );
  }

  private async recordEvent(
    client: PoolClient,
    sessionId: number,
    kind: WorkoutEventKind,
    exercisePosition: number | null,
    exerciseId: number | null,
    setNumber: number | null,
  ): Promise<void> {
    await client.query(
      `INSERT INTO workout_events
         (session_id, kind, exercise_position, exercise_id, set_number)
       VALUES ($1, $2, $3, $4, $5)`,
      [sessionId, kind, exercisePosition, exerciseId, setNumber],
    );
  }

  /**
   * Loads the user's active session and locks the row for the rest of the
   * transaction, so two taps racing each other cannot both advance the cursor.
   * Throws when there is nothing in progress — callers mutate, and a mutation
   * with no session is a request we deny rather than guess at.
   */
  private async lockActiveSession(
    client: PoolClient,
    userId: number,
  ): Promise<SessionRow> {
    const result = await client.query<SessionRow>(
      `${SESSION_SELECT} WHERE s.user_id = $1 AND ${ACTIVE_PREDICATE} FOR UPDATE OF s`,
      [userId],
    );
    const session = result.rows[0];
    if (!session) {
      throw new NotFoundException('No workout in progress.');
    }
    return session;
  }

  /**
   * The identity of the exercise sitting at a queue position. This is the only
   * place a position is turned into an exercise, and it happens once per action
   * inside the transaction that holds the session lock — so the queue cannot be
   * reordered between resolving the exercise and writing against it.
   */
  private async exerciseIdAt(
    run: Run,
    sessionId: number,
    position: number,
  ): Promise<number> {
    const result = await run<{ id: number }>(
      'SELECT id FROM workout_session_exercises WHERE session_id = $1 AND position = $2',
      [sessionId, position],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) {
      throw new Error(
        `Workout ${sessionId} has no exercise at position ${position}.`,
      );
    }
    return id;
  }

  /** The user's unfinished workout, or null. */
  async getActiveWorkout(userId: number): Promise<WorkoutState | null> {
    const result = await this.db.query<SessionRow>(
      `${SESSION_SELECT} WHERE s.user_id = $1 AND ${ACTIVE_PREDICATE}`,
      [userId],
    );
    const session = result.rows[0];
    return session ? this.buildState(session) : null;
  }

  /**
   * One of the user's workouts by id — used to render the summary after it has
   * finished. Scoped to the owner, so an id from the URL cannot read another
   * user's workout.
   */
  async getWorkout(userId: number, id: number): Promise<WorkoutState | null> {
    const result = await this.db.query<SessionRow>(
      `${SESSION_SELECT} WHERE s.id = $1 AND s.user_id = $2 AND s.abandoned_at IS NULL`,
      [id, userId],
    );
    const session = result.rows[0];
    return session ? this.buildState(session) : null;
  }

  /**
   * What the user last did on one exercise: the previous completed workout, the
   * five most recent, and their heaviest set ever. Read while a workout is on,
   * so it is deliberately one round trip for one exercise — never the whole
   * plan's history — and it aggregates in the database rather than shipping
   * every set to the client to fold there.
   *
   * "The same exercise" means the same snapshotted name, which is what
   * `resolvePrefill` already means by it: renaming a lift starts its history
   * fresh rather than inheriting a stranger's numbers.
   *
   * Only completed workouts count. The workout in progress is excluded because
   * it has no `completed_at` — so the panel keeps showing what to beat, rather
   * than the sets just logged against it.
   */
  async getExerciseHistory(
    userId: number,
    exerciseName: string,
  ): Promise<ExerciseHistory> {
    // The most recent completed workouts that logged a set on this exercise.
    // Bounded here, so everything below reads at most five workouts of sets.
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
                 WHERE e.session_id = s.id AND e.name = $2
              )
        ORDER BY s.completed_at DESC
        LIMIT $3`,
      [userId, exerciseName, HISTORY_WORKOUTS],
    );
    const workouts = workoutsResult.rows;

    if (workouts.length === 0) {
      return { exerciseName, last: null, recent: [], best: null };
    }

    const setsResult = await this.db.query<{
      workout_session_id: number;
      set_number: number;
      weight: number;
      reps: number;
    }>(
      `SELECT ws.workout_session_id, ws.set_number,
              ws.actual_weight::float8 AS weight, ws.actual_reps AS reps
         FROM workout_sets ws
         JOIN workout_session_exercises e ON e.id = ws.exercise_id
        WHERE ws.workout_session_id = ANY($1::int[]) AND e.name = $2
        ORDER BY ws.workout_session_id, ws.set_number`,
      [workouts.map((workout) => workout.id), exerciseName],
    );

    const setsByWorkout = new Map<number, HistorySet[]>();
    for (const row of setsResult.rows) {
      const sets = setsByWorkout.get(row.workout_session_id) ?? [];
      sets.push({
        setNumber: row.set_number,
        weight: row.weight,
        reps: row.reps,
      });
      setsByWorkout.set(row.workout_session_id, sets);
    }

    // Ordered by the workout query, so the list stays newest-first.
    const recent: HistoryWorkout[] = workouts.map((workout) => ({
      workoutId: workout.id,
      completedAt: workout.completed_at.toISOString(),
      sets: setsByWorkout.get(workout.id) ?? [],
    }));

    // Best ever, over every completed workout rather than the five above: a
    // personal best is not something that scrolls off the end of a list.
    const bestResult = await this.db.query<{ weight: number; reps: number }>(
      `SELECT ws.actual_weight::float8 AS weight, ws.actual_reps AS reps
         FROM workout_sets ws
         JOIN workout_session_exercises e ON e.id = ws.exercise_id
         JOIN workout_sessions s ON s.id = ws.workout_session_id
        WHERE s.user_id = $1 AND e.name = $2 AND s.completed_at IS NOT NULL
        ORDER BY ws.actual_weight DESC, ws.actual_reps DESC
        LIMIT 1`,
      [userId, exerciseName],
    );
    const bestRow = bestResult.rows[0];

    return {
      exerciseName,
      last: recent[0] ?? null,
      recent,
      best: bestRow ? { weight: bestRow.weight, reps: bestRow.reps } : null,
    };
  }

  /**
   * The same panel as `getExerciseHistory`, but resolved by `exercise_library_id`
   * rather than by name — the identity the Training Builder assigns. This is what
   * makes history follow a movement through the template: remove an exercise from
   * a day and add it back, and its past sets still surface, because they were
   * logged against the same library id whatever the template did in between.
   *
   * Only completed workouts count, and the panel reports the last five plus the
   * best set ever. The exercise name comes from the library so the heading reads
   * correctly even if no completed set exists yet.
   */
  async getExerciseHistoryByLibraryId(
    userId: number,
    exerciseLibraryId: number,
  ): Promise<ExerciseHistory> {
    const nameResult = await this.db.query<{ name: string }>(
      'SELECT name FROM exercise_library WHERE id = $1',
      [exerciseLibraryId],
    );
    const exerciseName = nameResult.rows[0]?.name ?? '';

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
                 WHERE e.session_id = s.id AND e.exercise_library_id = $2
              )
        ORDER BY s.completed_at DESC
        LIMIT $3`,
      [userId, exerciseLibraryId, HISTORY_WORKOUTS],
    );
    const workouts = workoutsResult.rows;

    if (workouts.length === 0) {
      return { exerciseName, last: null, recent: [], best: null };
    }

    const setsResult = await this.db.query<{
      workout_session_id: number;
      set_number: number;
      weight: number;
      reps: number;
    }>(
      `SELECT ws.workout_session_id, ws.set_number,
              ws.actual_weight::float8 AS weight, ws.actual_reps AS reps
         FROM workout_sets ws
         JOIN workout_session_exercises e ON e.id = ws.exercise_id
        WHERE ws.workout_session_id = ANY($1::int[]) AND e.exercise_library_id = $2
        ORDER BY ws.workout_session_id, ws.set_number`,
      [workouts.map((workout) => workout.id), exerciseLibraryId],
    );

    const setsByWorkout = new Map<number, HistorySet[]>();
    for (const row of setsResult.rows) {
      const sets = setsByWorkout.get(row.workout_session_id) ?? [];
      sets.push({
        setNumber: row.set_number,
        weight: row.weight,
        reps: row.reps,
      });
      setsByWorkout.set(row.workout_session_id, sets);
    }

    const recent: HistoryWorkout[] = workouts.map((workout) => ({
      workoutId: workout.id,
      completedAt: workout.completed_at.toISOString(),
      sets: setsByWorkout.get(workout.id) ?? [],
    }));

    const bestResult = await this.db.query<{ weight: number; reps: number }>(
      `SELECT ws.actual_weight::float8 AS weight, ws.actual_reps AS reps
         FROM workout_sets ws
         JOIN workout_session_exercises e ON e.id = ws.exercise_id
         JOIN workout_sessions s ON s.id = ws.workout_session_id
        WHERE s.user_id = $1 AND e.exercise_library_id = $2
          AND s.completed_at IS NOT NULL
        ORDER BY ws.actual_weight DESC, ws.actual_reps DESC
        LIMIT 1`,
      [userId, exerciseLibraryId],
    );
    const bestRow = bestResult.rows[0];

    return {
      exerciseName,
      last: recent[0] ?? null,
      recent,
      best: bestRow ? { weight: bestRow.weight, reps: bestRow.reps } : null,
    };
  }

  /**
   * Starts a workout for a training day: snapshots the config and the exercise
   * list, stamps the start time, and points the cursor at the first set. The
   * partial unique index rejects a second concurrent start.
   */
  async startWorkout(userId: number, slug: string): Promise<WorkoutState> {
    const dayResult = await this.db.query<{
      id: number;
    }>('SELECT id FROM training_days WHERE slug = $1', [slug]);
    const day = dayResult.rows[0];
    if (!day) {
      throw new NotFoundException('Training day not found.');
    }

    // Flattened in the order the exercises are performed: groups top to bottom,
    // exercises within a group likewise. This ordering seeds the queue's initial
    // positions; from here on the queue owns its own order.
    const exercisesResult = await this.db.query<{ id: number; name: string }>(
      `SELECT id, name
         FROM exercises
        WHERE training_day_id = $1
        ORDER BY group_index, item_index`,
      [day.id],
    );
    const exercises = exercisesResult.rows;
    if (exercises.length === 0) {
      throw new BadRequestException(
        'This training day has no exercises to work through.',
      );
    }

    const config = await this.trainingConfig.getConfig(userId);

    const sessionId = await this.db
      .transaction(async (client) => {
        const inserted = await client.query<{ id: number }>(
          `INSERT INTO workout_sessions
             (user_id, training_day_id, planned_reps, rest_seconds, sets_per_exercise)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [userId, day.id, config.reps, config.restPeriod, config.setsPerExercise],
        );
        const id = inserted.rows[0]?.id;
        if (id === undefined) {
          throw new Error('Could not create the workout session.');
        }

        let firstExerciseId: number | undefined;
        for (const [position, exercise] of exercises.entries()) {
          const row = await client.query<{ id: number }>(
            `INSERT INTO workout_session_exercises
               (session_id, position, catalog_exercise_id, name)
             VALUES ($1, $2, $3, $4)
             RETURNING id`,
            [id, position, exercise.id, exercise.name],
          );
          if (position === 0) {
            firstExerciseId = row.rows[0]?.id;
          }
        }
        if (firstExerciseId === undefined) {
          throw new Error('Could not seed the workout exercise queue.');
        }

        await this.recordEvent(
          client,
          id,
          'workout_started',
          0,
          firstExerciseId,
          1,
        );
        await this.recordEvent(
          client,
          id,
          'exercise_started',
          0,
          firstExerciseId,
          1,
        );
        return id;
      })
      .catch((err: unknown) => {
        // The partial unique index fired: the user already has a workout going.
        // Tell them to resume it rather than silently starting a second one.
        if (this.isUniqueViolation(err)) {
          throw new ConflictException('A workout is already in progress.');
        }
        throw err;
      });

    // Generate the AI weight recommendations for this workout's exercises in the
    // background, so the model is called once at start without delaying it.
    // Deliberately not awaited and it never throws — a failed recommendation must
    // not affect starting the workout; the frontend picks them up when they land.
    void this.aiWeightRecommendation.generateForSession(userId, sessionId);

    const state = await this.getWorkout(userId, sessionId);
    if (!state) {
      throw new Error('Could not read back the workout that was just started.');
    }
    return state;
  }

  /**
   * Starts a workout from a Training Builder day. Mirrors `startWorkout`, but the
   * exercise queue is snapshotted from the day's *active* exercises, each
   * carrying its `exercise_library_id` and the library's current name — so the
   * workout is fixed even if the template is edited mid-session, and every set
   * logged resolves back to its library movement for history.
   *
   * The day must belong to a template the user owns; the partial unique index
   * rejects a second concurrent start.
   */
  async startWorkoutFromTemplateDay(
    userId: number,
    dayId: number,
  ): Promise<WorkoutState> {
    const dayResult = await this.db.query<{ id: number }>(
      `SELECT td.id
         FROM training_template_days td
         JOIN training_templates t ON t.id = td.template_id
        WHERE td.id = $1 AND t.user_id = $2`,
      [dayId, userId],
    );
    if (!dayResult.rows[0]) {
      throw new NotFoundException('Training day not found.');
    }

    // Active exercises only, in their builder order, resolved to the library's
    // current name. A removed (deactivated) exercise is excluded here, but its
    // past sets still live under its library id.
    const exercisesResult = await this.db.query<{
      exercise_library_id: number;
      name: string;
    }>(
      `SELECT tde.exercise_library_id, el.name
         FROM training_template_day_exercises tde
         JOIN exercise_library el ON el.id = tde.exercise_library_id
        WHERE tde.day_id = $1 AND tde.is_active = true
        ORDER BY tde.position, tde.id`,
      [dayId],
    );
    const exercises = exercisesResult.rows;
    if (exercises.length === 0) {
      throw new BadRequestException(
        'This training day has no exercises to work through.',
      );
    }

    const config = await this.trainingConfig.getConfig(userId);

    const sessionId = await this.db
      .transaction(async (client) => {
        const inserted = await client.query<{ id: number }>(
          `INSERT INTO workout_sessions
             (user_id, template_day_id, planned_reps, rest_seconds, sets_per_exercise)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [
            userId,
            dayId,
            config.reps,
            config.restPeriod,
            config.setsPerExercise,
          ],
        );
        const id = inserted.rows[0]?.id;
        if (id === undefined) {
          throw new Error('Could not create the workout session.');
        }

        let firstExerciseId: number | undefined;
        for (const [position, exercise] of exercises.entries()) {
          const row = await client.query<{ id: number }>(
            `INSERT INTO workout_session_exercises
               (session_id, position, exercise_library_id, name)
             VALUES ($1, $2, $3, $4)
             RETURNING id`,
            [id, position, exercise.exercise_library_id, exercise.name],
          );
          if (position === 0) {
            firstExerciseId = row.rows[0]?.id;
          }
        }
        if (firstExerciseId === undefined) {
          throw new Error('Could not seed the workout exercise queue.');
        }

        await this.recordEvent(client, id, 'workout_started', 0, firstExerciseId, 1);
        await this.recordEvent(
          client,
          id,
          'exercise_started',
          0,
          firstExerciseId,
          1,
        );
        return id;
      })
      .catch((err: unknown) => {
        if (this.isUniqueViolation(err)) {
          throw new ConflictException('A workout is already in progress.');
        }
        throw err;
      });

    // See startWorkout: generated once at start, in the background, never fatal.
    void this.aiWeightRecommendation.generateForSession(userId, sessionId);

    const state = await this.getWorkout(userId, sessionId);
    if (!state) {
      throw new Error('Could not read back the workout that was just started.');
    }
    return state;
  }

  /**
   * Persists the typed weight/reps for the current set before it is committed.
   * Ignored once the workout is over. Both fields are optional: a null clears
   * that side of the draft.
   */
  async saveDraft(
    userId: number,
    draft: { weight: number | null; reps: number | null },
  ): Promise<WorkoutState> {
    return this.db.transaction(async (client) => {
      const session = await this.lockActiveSession(client, userId);
      const exerciseId = await this.exerciseIdAt(
        this.runner(client),
        session.id,
        session.exercise_position,
      );
      await client.query(
        `INSERT INTO workout_set_drafts (session_id, exercise_id, set_number, weight, reps)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (session_id, exercise_id, set_number) DO UPDATE
           SET weight = EXCLUDED.weight,
               reps = EXCLUDED.reps,
               updated_at = now()`,
        [session.id, exerciseId, session.set_number, draft.weight, draft.reps],
      );
      return this.buildState(session, client);
    });
  }

  /**
   * Commits the current set and starts the rest timer — unless that was the
   * final set of the final exercise, in which case the workout completes then
   * and there is nothing left to rest for.
   */
  async finishSet(
    userId: number,
    weight: number,
    reps: number,
    details: SetDetails = { rir: null, rpe: null, isWarmup: false },
  ): Promise<WorkoutState> {
    const { state, completedSessionId } = await this.db.transaction(async (client) => {
      const session = await this.lockActiveSession(client, userId);
      const run = this.runner(client);

      // Fail safe: a set can only be finished from the set phase. Arriving here
      // while resting means the client is out of step with the database.
      if (session.resting_since !== null) {
        throw new BadRequestException(
          'Rest is in progress — start the next set first.',
        );
      }

      const exerciseCount = await this.countExercises(client, session.id);
      const exerciseId = await this.exerciseIdAt(
        run,
        session.id,
        session.exercise_position,
      );
      const exerciseName = await this.exerciseName(run, exerciseId);

      // Read before the insert: the prefill is what the workout asked of the
      // user, and after the row lands the set itself would be its own answer.
      const { plannedWeight } = await this.resolvePrefill(
        session,
        exerciseId,
        exerciseName,
        run,
      );

      // Idempotent on (session, exercise, set): a retried tap overwrites the same
      // row rather than logging the set twice. Only the actuals are overwritten —
      // started_at and planned_* describe the attempt and are set once.
      await client.query(
        `INSERT INTO workout_sets
           (workout_session_id, exercise_id, set_number, planned_reps, actual_reps,
            planned_weight, actual_weight, started_at, rir, rpe, is_warmup)
         VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, now()),
                 $9, $10, $11)
         ON CONFLICT (workout_session_id, exercise_id, set_number) DO UPDATE
           SET actual_reps = EXCLUDED.actual_reps,
               actual_weight = EXCLUDED.actual_weight,
               rir = EXCLUDED.rir,
               rpe = EXCLUDED.rpe,
               is_warmup = EXCLUDED.is_warmup,
               completed_at = now()`,
        [
          session.id,
          exerciseId,
          session.set_number,
          session.planned_reps,
          reps,
          plannedWeight,
          weight,
          session.set_started_at,
          details.rir,
          details.rpe,
          details.isWarmup,
        ],
      );
      await client.query(
        `DELETE FROM workout_set_drafts
          WHERE session_id = $1 AND exercise_id = $2 AND set_number = $3`,
        [session.id, exerciseId, session.set_number],
      );
      await this.recordEvent(
        client,
        session.id,
        'set_completed',
        session.exercise_position,
        exerciseId,
        session.set_number,
      );

      const isFinalSet = session.set_number >= session.sets_per_exercise;
      const isFinalExercise = session.exercise_position >= exerciseCount - 1;

      if (isFinalSet && isFinalExercise) {
        const updated = await client.query<SessionRow>(
          `UPDATE workout_sessions
              SET completed_at = now(), resting_since = NULL
            WHERE id = $1
          RETURNING *, now() AS server_now`,
          [session.id],
        );
        await this.recordEvent(
          client,
          session.id,
          'workout_completed',
          session.exercise_position,
          exerciseId,
          session.set_number,
        );
        return {
          state: await this.buildState(
            this.mergeSession(session, updated.rows[0]),
            client,
          ),
          completedSessionId: session.id,
        };
      }

      const updated = await client.query<SessionRow>(
        `UPDATE workout_sessions
            SET resting_since = now()
          WHERE id = $1
        RETURNING *, now() AS server_now`,
        [session.id],
      );
      await this.recordEvent(
        client,
        session.id,
        'rest_started',
        session.exercise_position,
        exerciseId,
        session.set_number,
      );
      return {
        state: await this.buildState(
          this.mergeSession(session, updated.rows[0]),
          client,
        ),
        completedSessionId: null as number | null,
      };
    });

    // The workout just finished: generate its AI summary in the background so it
    // is usually ready by the time the user reaches the summary screen. Deliberately
    // not awaited and it never throws — a failed summary must not turn a
    // successfully completed workout into an error.
    if (completedSessionId !== null) {
      void this.aiSummary.generateInBackground(userId, completedSessionId);
    }

    return state;
  }

  /**
   * Ends rest and advances the cursor: to the next set, or — when the exercise
   * is done — to the first set of the next exercise. The countdown reaching
   * zero does nothing on its own; only this call moves the workout on.
   *
   * Idempotent: called when not resting (a double tap, a stale client) it
   * returns the current state rather than advancing twice.
   */
  async startNextSet(userId: number): Promise<WorkoutState> {
    return this.db.transaction(async (client) => {
      const session = await this.lockActiveSession(client, userId);
      if (session.resting_since === null) {
        return this.buildState(session, client);
      }
      return this.buildState(await this.endRest(client, session), client);
    });
  }

  /**
   * Ends the rest the session is in and moves the cursor on: to the next set,
   * or — when the exercise is done — to the first set of the next exercise.
   * Returns the session as it now stands. The caller holds the session lock.
   *
   * Shared with `deferExercise`, which reaches the next exercise the same way
   * before pushing it back, so that both do it in one transaction and record
   * the same events.
   */
  private async endRest(
    client: PoolClient,
    session: SessionRow,
  ): Promise<SessionRow> {
    const exerciseId = await this.exerciseIdAt(
      this.runner(client),
      session.id,
      session.exercise_position,
    );

    // Close out the set the user just rested after. The rest is over now, so
    // its duration is a fact — record it against the set it followed.
    await client.query(
      `UPDATE workout_sets
          SET rest_duration = CAST(
                GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - $4::timestamptz)))) AS INTEGER)
        WHERE workout_session_id = $1 AND exercise_id = $2 AND set_number = $3`,
      [session.id, exerciseId, session.set_number, session.resting_since],
    );

    await this.recordEvent(
      client,
      session.id,
      'rest_finished',
      session.exercise_position,
      exerciseId,
      session.set_number,
    );

    const movesToNextExercise = session.set_number >= session.sets_per_exercise;
    const nextPosition = movesToNextExercise
      ? session.exercise_position + 1
      : session.exercise_position;
    const nextSetNumber = movesToNextExercise ? 1 : session.set_number + 1;

    // The final set of the final exercise completes the workout in finishSet,
    // so the cursor can never be advanced past the last exercise here. Guard
    // anyway rather than trust that invariant from a mutating endpoint.
    const exerciseCount = await this.countExercises(client, session.id);
    if (nextPosition >= exerciseCount) {
      throw new BadRequestException('The workout has no further exercises.');
    }

    const updated = await client.query<SessionRow>(
      `UPDATE workout_sessions
          SET resting_since = NULL, exercise_position = $2, set_number = $3,
              set_started_at = now()
        WHERE id = $1
      RETURNING *, now() AS server_now`,
      [session.id, nextPosition, nextSetNumber],
    );

    const nextExerciseId = movesToNextExercise
      ? await this.exerciseIdAt(this.runner(client), session.id, nextPosition)
      : exerciseId;
    await this.recordEvent(
      client,
      session.id,
      movesToNextExercise ? 'exercise_started' : 'next_set_started',
      nextPosition,
      nextExerciseId,
      nextSetNumber,
    );

    return this.mergeSession(session, updated.rows[0]);
  }

  /**
   * Pushes the current exercise behind exactly one exercise — the machine was
   * busy, not abandoned. The exercise that takes its place becomes current, and
   * the deferred one comes back round as soon as that exercise is finished.
   *
   * "Exactly one" means one *available* exercise, not one queue slot. Exercises
   * already deferred are still unavailable, so a defer hops the whole run of
   * them and lands behind the first exercise that has not been pushed back:
   *
   *     Bench✓ | [Chest] Incline  Pec      defer Chest -> behind Incline
   *     Bench✓ | [Incline] Chest  Pec      defer Incline -> behind Pec, not Chest
   *     Bench✓ | [Pec] Incline  Chest
   *
   * Rotating rather than swapping is what keeps that stable: the run of deferred
   * exercises stays in the order it was deferred in, and each one is only ever
   * one available exercise away from coming up again. When every exercise ahead
   * is deferred there is nothing available to hop, so the cursor's exercise
   * simply trades places with the one behind it — the user moves on, and the
   * machine it was waiting on gets another turn.
   *
   * Callable from the rest that ends an exercise as well as from the exercise
   * itself: that rest already names the exercise coming up, so it is where a
   * busy machine is found. It is ended first, and the exercise it lands on is
   * the one deferred.
   *
   * Only exercises with nothing logged against them may move. That is a product
   * rule — you finish what you started — and no longer a constraint on the data:
   * sets name their exercise by identity, so reordering the queue cannot
   * reattribute them however many times it happens.
   */
  async deferExercise(userId: number): Promise<WorkoutState> {
    return this.db.transaction(async (client) => {
      const locked = await this.lockActiveSession(client, userId);
      const run = this.runner(client);

      // The rest that ends an exercise is the walk to the next machine, and so
      // the moment its being busy is discovered — a screen before the cursor
      // moves. Ending that rest is exactly what "Start next set" would do, so do
      // it here, in this transaction, and defer the exercise it lands on. A rest
      // between two sets of one exercise leads back to a machine already in use.
      const session =
        locked.resting_since !== null &&
        locked.set_number >= locked.sets_per_exercise
          ? await this.endRest(client, locked)
          : locked;

      if (session.resting_since !== null) {
        throw new BadRequestException(
          'Rest is in progress — start the next set first.',
        );
      }

      const cursor = session.exercise_position;
      const deferredExerciseId = await this.exerciseIdAt(
        run,
        session.id,
        cursor,
      );

      // The rule the button is drawn from, re-checked against the database
      // because the client is untrusted: an exercise with a set on it is
      // underway, and you finish what you started.
      const logged = await client.query(
        'SELECT 1 FROM workout_sets WHERE workout_session_id = $1 AND exercise_id = $2 LIMIT 1',
        [session.id, deferredExerciseId],
      );
      if (logged.rowCount) {
        throw new BadRequestException(
          'This exercise is already underway — finish it before deferring.',
        );
      }

      // Nothing to do first: deferring the last exercise would just re-present
      // it, and the rotation below has no target to hop. Fail rather than
      // pretend the tap did something.
      const exerciseCount = await this.countExercises(client, session.id);
      if (cursor >= exerciseCount - 1) {
        throw new BadRequestException(
          'This is the last exercise — there is nothing to do before it.',
        );
      }

      // The exercise to hop: the first one ahead of the cursor that is not
      // itself deferred. Non-empty by the guard above, so `upcoming[0]` is the
      // fallback when everything ahead has already been pushed back.
      const upcoming = await client.query<{
        position: number;
        deferred: boolean;
      }>(
        `SELECT position, deferred_at IS NOT NULL AS deferred
           FROM workout_session_exercises
          WHERE session_id = $1 AND position > $2
          ORDER BY position`,
        [session.id, cursor],
      );
      const target =
        upcoming.rows.find((row) => !row.deferred) ?? upcoming.rows[0];
      const targetPosition = target.position;

      // Rotate `cursor..targetPosition` right by one: the target jumps to the
      // cursor, and the deferred exercise — followed by any exercises deferred
      // before it — slides one place back.
      const rotated = [targetPosition];
      for (let position = cursor; position < targetPosition; position++) {
        rotated.push(position);
      }

      // Renumbered in two passes, because (session_id, position) is unique: a
      // single `SET position = position - 1` can collide with a row it has not
      // renumbered yet. Postgres checks the key per row, not at the end of the
      // statement, and the order it visits rows in is not ours to choose — it
      // happens to work on an ascending scan, which is exactly the kind of luck
      // not to build on. Park the rotating block on negatives (always free,
      // positions are non-negative), then land it on the final positions.
      await client.query(
        `UPDATE workout_session_exercises
            SET position = -position - 1
          WHERE session_id = $1 AND position BETWEEN $2 AND $3`,
        [session.id, cursor, targetPosition],
      );
      for (const [offset, from] of rotated.entries()) {
        await client.query(
          `UPDATE workout_session_exercises
              SET position = $3
            WHERE session_id = $1 AND position = $2`,
          [session.id, -from - 1, cursor + offset],
        );
      }

      await client.query(
        `UPDATE workout_session_exercises
            SET deferred_at = now()
          WHERE id = $1`,
        [deferredExerciseId],
      );

      // The cursor has not moved, but the exercise under it has, so the user is
      // starting a different lift now.
      const updated = await client.query<SessionRow>(
        `UPDATE workout_sessions
            SET set_started_at = now()
          WHERE id = $1
        RETURNING *, now() AS server_now`,
        [session.id],
      );

      await this.recordEvent(
        client,
        session.id,
        'exercise_deferred',
        cursor + 1,
        deferredExerciseId,
        session.set_number,
      );
      const nextExerciseId = await this.exerciseIdAt(run, session.id, cursor);
      await this.recordEvent(
        client,
        session.id,
        'exercise_started',
        cursor,
        nextExerciseId,
        session.set_number,
      );

      return this.buildState(
        this.mergeSession(session, updated.rows[0]),
        client,
      );
    });
  }

  /**
   * Abandons the unfinished workout, freeing the user to start another. The row
   * is kept (never deleted) so the sets already logged remain part of history.
   */
  async abandonWorkout(userId: number): Promise<void> {
    await this.db.transaction(async (client) => {
      const session = await this.lockActiveSession(client, userId);
      const exerciseId = await this.exerciseIdAt(
        this.runner(client),
        session.id,
        session.exercise_position,
      );
      await client.query(
        'UPDATE workout_sessions SET abandoned_at = now(), resting_since = NULL WHERE id = $1',
        [session.id],
      );
      await this.recordEvent(
        client,
        session.id,
        'workout_abandoned',
        session.exercise_position,
        exerciseId,
        session.set_number,
      );
    });
  }

  /**
   * Records — or corrects — the body weight of one finished workout. Written
   * straight to the session row that owns it, so the last step of the workout is
   * one round trip and the value is durable before the screen closes.
   *
   * Scoped to the owner, so an id from the URL cannot write another user's
   * workout. Only a completed workout takes a weight: the question is asked at
   * the end, and a workout still underway has no end to attach it to.
   *
   * `null` clears a weight entered by mistake. Skipping simply never calls this.
   */
  async setBodyWeight(
    userId: number,
    workoutId: number,
    bodyWeightKg: number | null,
  ): Promise<WorkoutState> {
    return this.db.transaction(async (client) => {
      const result = await client.query<SessionRow>(
        `${SESSION_SELECT}
          WHERE s.id = $1 AND s.user_id = $2 AND s.abandoned_at IS NULL
          FOR UPDATE OF s`,
        [workoutId, userId],
      );
      const session = result.rows[0];
      if (!session) {
        throw new NotFoundException('Workout not found.');
      }
      if (session.completed_at === null) {
        throw new BadRequestException(
          'Finish the workout before recording your body weight.',
        );
      }

      const updated = await client.query<SessionRow>(
        `UPDATE workout_sessions
            SET body_weight_kg = $2
          WHERE id = $1
        RETURNING *, now() AS server_now`,
        [session.id, bodyWeightKg],
      );
      return this.buildState(
        this.mergeSession(session, updated.rows[0]),
        client,
      );
    });
  }

  private async countExercises(
    client: PoolClient,
    sessionId: number,
  ): Promise<number> {
    const result = await client.query<{ count: string }>(
      'SELECT count(*) AS count FROM workout_session_exercises WHERE session_id = $1',
      [sessionId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  /** The snapshotted name of an exercise identity. */
  private async exerciseName(run: Run, exerciseId: number): Promise<string> {
    const result = await run<{ name: string }>(
      'SELECT name FROM workout_session_exercises WHERE id = $1',
      [exerciseId],
    );
    return result.rows[0]?.name ?? '';
  }

  /** Queries on the transaction's client, so reads see its uncommitted writes. */
  private runner(client?: PoolClient): Run {
    return <T extends Record<string, unknown>>(
      text: string,
      params: unknown[],
    ) =>
      client ? client.query<T>(text, params) : this.db.query<T>(text, params);
  }

  /**
   * The columns an UPDATE ... RETURNING * gives back, layered over the joined
   * row we already hold. The joined day columns are not in `workout_sessions`,
   * so RETURNING * cannot supply them.
   */
  private mergeSession(
    original: SessionRow,
    updated: SessionRow | undefined,
  ): SessionRow {
    if (!updated) {
      throw new Error(`Workout session ${original.id} vanished mid-update.`);
    }
    return {
      ...updated,
      slug: original.slug,
      day: original.day,
      focus: original.focus,
    };
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: unknown }).code === UNIQUE_VIOLATION
    );
  }

  /**
   * Projects a session row into what the screen renders. Every field is read
   * from the database; nothing is remembered between calls. `client` is passed
   * when we are inside a transaction so the reads see its uncommitted writes.
   */
  private async buildState(
    session: SessionRow,
    client?: PoolClient,
  ): Promise<WorkoutState> {
    const run = this.runner(client);

    // `completed_sets` is counted per exercise identity rather than per cursor
    // position, so it survives a reordered queue. It is what the workout screen
    // renders the "Machine busy — do this later" button from: the button shows
    // while the current exercise has none. Sent as data, not as a decision —
    // `deferExercise` re-checks the database, because the client is untrusted.
    const exercisesResult = await run<{
      id: number;
      position: number;
      name: string;
      exercise_library_id: number | null;
      deferred_at: Date | null;
      completed_sets: number;
      ai_weight_recommendation: string | null;
    }>(
      `SELECT e.id, e.position, e.name, e.exercise_library_id, e.deferred_at,
              e.ai_weight_recommendation,
              count(ws.id)::int AS completed_sets
         FROM workout_session_exercises e
         LEFT JOIN workout_sets ws ON ws.exercise_id = e.id
        WHERE e.session_id = $1
        GROUP BY e.id
        ORDER BY e.position`,
      [session.id],
    );
    const exercises: WorkoutExercise[] = exercisesResult.rows.map((row) => ({
      position: row.position,
      name: row.name,
      exerciseLibraryId:
        row.exercise_library_id === null ? null : Number(row.exercise_library_id),
      deferred: row.deferred_at !== null,
      completedSets: row.completed_sets,
      aiWeightRecommendation: row.ai_weight_recommendation ?? null,
    }));

    // Rows come back ordered by position, so the cursor indexes them directly.
    const currentExercise = exercisesResult.rows[session.exercise_position];
    const currentExerciseId = currentExercise?.id ?? null;
    const exerciseName = currentExercise?.name ?? '';
    const currentExerciseLibraryId =
      currentExercise?.exercise_library_id == null
        ? null
        : Number(currentExercise.exercise_library_id);

    // Counted by exercise identity, so a reordered queue never changes what a
    // finished workout reports.
    const totalsResult = await run<{
      sets_completed: string;
      exercises_completed: string;
    }>(
      `SELECT count(*) AS sets_completed,
              count(DISTINCT exercise_id) AS exercises_completed
         FROM workout_sets
        WHERE workout_session_id = $1`,
      [session.id],
    );
    const setsCompleted = Number(totalsResult.rows[0]?.sets_completed ?? 0);
    const exercisesCompleted = Number(
      totalsResult.rows[0]?.exercises_completed ?? 0,
    );

    const completed = session.completed_at !== null;
    const resting = !completed && session.resting_since !== null;

    const serverNow = session.server_now.getTime();
    const endedAt = session.completed_at?.getTime() ?? serverNow;
    const elapsedSeconds = Math.max(
      0,
      Math.floor((endedAt - session.started_at.getTime()) / 1000),
    );

    // Clamped at zero: an expired countdown displays 00:00 and waits. It never
    // advances the workout on its own.
    const restRemainingSeconds =
      resting && session.resting_since
        ? Math.max(
            0,
            session.rest_seconds -
              Math.floor((serverNow - session.resting_since.getTime()) / 1000),
          )
        : null;

    const phase: WorkoutPhase = completed
      ? 'completed'
      : resting
        ? 'rest'
        : 'set';

    // Only the ones still waiting: once the cursor reaches a deferred exercise
    // it is no longer pending, it is the exercise being done.
    const deferredCount = completed
      ? 0
      : exercises.filter(
          (exercise) =>
            exercise.deferred && exercise.position > session.exercise_position,
        ).length;

    const { plannedWeight, draftReps } =
      completed || currentExerciseId === null
        ? { plannedWeight: null, draftReps: null }
        : await this.resolvePrefill(
            session,
            currentExerciseId,
            exerciseName,
            run,
          );

    return {
      id: session.id,
      daySlug: session.slug,
      dayName: session.day,
      focus: session.focus,
      phase,
      startedAt: session.started_at.toISOString(),
      completedAt: session.completed_at?.toISOString() ?? null,
      elapsedSeconds,
      exercises,
      exerciseIndex: session.exercise_position,
      exerciseCount: exercises.length,
      exerciseName,
      exerciseLibraryId: currentExerciseLibraryId,
      deferredCount,
      setNumber: session.set_number,
      setsPerExercise: session.sets_per_exercise,
      targetReps: session.planned_reps,
      plannedWeight,
      draftReps,
      restSeconds: session.rest_seconds,
      restRemainingSeconds,
      setsCompleted,
      exercisesCompleted,
      bodyWeightKg: numericOrNull(session.body_weight_kg),
    };
  }

  /**
   * What to show in the weight/reps inputs for the current set: the draft the
   * user already typed, falling back to the weight they last lifted on this
   * exercise (in any workout) so the common case needs no typing at all.
   */
  private async resolvePrefill(
    session: SessionRow,
    exerciseId: number,
    exerciseName: string,
    run: Run,
  ): Promise<{ plannedWeight: number | null; draftReps: number | null }> {
    const draftResult = await run<{
      weight: number | null;
      reps: number | null;
    }>(
      `SELECT weight::float8 AS weight, reps
         FROM workout_set_drafts
        WHERE session_id = $1 AND exercise_id = $2 AND set_number = $3`,
      [session.id, exerciseId, session.set_number],
    );
    const draft = draftResult.rows[0];
    if (draft?.weight !== null && draft?.weight !== undefined) {
      return { plannedWeight: draft.weight, draftReps: draft.reps ?? null };
    }

    // No draft weight — reuse the last weight lifted on this exercise. Joined
    // through the set's exercise identity, so a queue reordered by a defer (in
    // this workout or an earlier one) can never surface another lift's numbers.
    // Matched by name across workouts, so a renamed exercise simply starts fresh
    // rather than inheriting a stranger's numbers.
    const lastResult = await run<{ weight: number }>(
      `SELECT ws.actual_weight::float8 AS weight
         FROM workout_sets ws
         JOIN workout_sessions s ON s.id = ws.workout_session_id
         JOIN workout_session_exercises e ON e.id = ws.exercise_id
        WHERE s.user_id = $1 AND e.name = $2
        ORDER BY ws.completed_at DESC
        LIMIT 1`,
      [session.user_id, exerciseName],
    );

    return {
      plannedWeight: lastResult.rows[0]?.weight ?? null,
      draftReps: draft?.reps ?? null,
    };
  }
}

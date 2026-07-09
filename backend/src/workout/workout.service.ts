import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { TrainingConfigService } from '../training/training-config.service';

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
 * The exercise order is a *mutable queue*, not the training day's list:
 * `workout_session_exercises.position` is the running order, rewritten in place
 * whenever the user defers an exercise. The cursor names a position in that
 * queue, and because only exercises with no sets logged against them may move
 * (see `deferExercise`), the cursor is always the first unfinished exercise in
 * the current queue. Resuming a workout therefore restores the reordered queue,
 * never the original list.
 */

/** How many sets each exercise gets. Snapshotted onto the session at start. */
const SETS_PER_EXERCISE = 4;

// Bounds mirror the CHECK constraints below; both exist on purpose. The DTO is
// the first gate, the constraint the last one for anything reaching the table
// another way.
export const WEIGHT_MIN = 0;
export const WEIGHT_MAX = 1000;
export const REPS_MIN = 1;
export const REPS_MAX = 100;

/** Postgres error code for a unique-constraint violation. */
const UNIQUE_VIOLATION = '23505';

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
  /** True once the user has pushed this one back at least once. */
  deferred: boolean;
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

  /**
   * Whether the current exercise may be pushed to the back of the queue: it has
   * to be untouched (no sets logged), not resting, and not already last — there
   * is nothing to do first if it is. The client uses this to show the button;
   * `deferExercise` re-checks it, because the client is untrusted.
   */
  canDefer: boolean;
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
}

interface SessionRow {
  id: number;
  user_id: number;
  training_day_id: number;
  slug: string;
  day: string;
  focus: string;
  started_at: Date;
  completed_at: Date | null;
  exercise_index: number;
  set_number: number;
  resting_since: Date | null;
  planned_reps: number;
  rest_seconds: number;
  sets_per_exercise: number;
  server_now: Date;
}

// Every read of a session joins the day it belongs to and stamps the server's
// clock, so elapsed/remaining seconds are computed against the database's time
// rather than the browser's.
const SESSION_SELECT = `
  SELECT s.id, s.user_id, s.training_day_id, s.started_at, s.completed_at,
         s.exercise_index, s.set_number, s.resting_since,
         s.planned_reps, s.rest_seconds, s.sets_per_exercise,
         d.slug, d.day, d.focus,
         now() AS server_now
    FROM workout_sessions s
    JOIN training_days d ON d.id = s.training_day_id
`;

/** An active session is one that was neither completed nor abandoned. */
const ACTIVE_PREDICATE = 's.completed_at IS NULL AND s.abandoned_at IS NULL';

@Injectable()
export class WorkoutService implements OnModuleInit {
  private readonly logger = new Logger(WorkoutService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly trainingConfig: TrainingConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Tolerate an unavailable database so the app can still boot (mirrors
    // AuthService's behaviour).
    try {
      await this.ensureSchema();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      this.logger.warn(
        `Workout bootstrap skipped (is the database reachable?): ${message}`,
      );
    }
  }

  private async ensureSchema(): Promise<void> {
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
        exercise_index    INTEGER NOT NULL DEFAULT 0 CHECK (exercise_index >= 0),
        set_number        INTEGER NOT NULL DEFAULT 1 CHECK (set_number >= 1),
        resting_since     TIMESTAMPTZ,
        planned_reps      INTEGER NOT NULL CHECK (planned_reps BETWEEN 1 AND 100),
        rest_seconds      INTEGER NOT NULL CHECK (rest_seconds BETWEEN 0 AND 3600),
        sets_per_exercise INTEGER NOT NULL CHECK (sets_per_exercise BETWEEN 1 AND 20)
      )
    `);

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

    // The session's exercise queue. Seeded from the training day at start, then
    // owned by the session: `position` is rewritten whenever the user defers an
    // exercise, and it — not the plan — is the order the workout runs in.
    //
    // The exercise list is snapshotted per session, so editing the plan later
    // cannot renumber or rename the exercises of a workout already in progress.
    // The exercise_id link is kept for provenance but nulls out if the plan row
    // is deleted — the name is what the workout screen renders.
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS workout_session_exercises (
        session_id  INTEGER NOT NULL REFERENCES workout_sessions(id) ON DELETE CASCADE,
        position    INTEGER NOT NULL,
        exercise_id INTEGER REFERENCES exercises(id) ON DELETE SET NULL,
        name        TEXT NOT NULL,
        deferred_at TIMESTAMPTZ,
        PRIMARY KEY (session_id, position)
      )
    `);
    // Added after the table shipped; workouts already in flight keep their rows.
    await this.db.query(
      'ALTER TABLE workout_session_exercises ADD COLUMN IF NOT EXISTS deferred_at TIMESTAMPTZ',
    );

    // One row per completed set. The unique key makes the write idempotent, so
    // a retried "Finish set" overwrites rather than duplicating.
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS workout_sets (
        id             SERIAL PRIMARY KEY,
        session_id     INTEGER NOT NULL REFERENCES workout_sessions(id) ON DELETE CASCADE,
        exercise_index INTEGER NOT NULL,
        set_number     INTEGER NOT NULL,
        target_reps    INTEGER NOT NULL,
        reps           INTEGER NOT NULL CHECK (reps BETWEEN 1 AND 100),
        weight         NUMERIC(6, 2) NOT NULL CHECK (weight >= 0 AND weight <= 1000),
        completed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (session_id, exercise_index, set_number)
      )
    `);
    await this.db.query(
      'CREATE INDEX IF NOT EXISTS workout_sets_session_id_idx ON workout_sets (session_id)',
    );

    // Keypad input persisted as it is typed, before the set is committed. Keyed
    // to the cursor so a crash mid-entry restores exactly what was on screen.
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS workout_set_drafts (
        session_id     INTEGER NOT NULL REFERENCES workout_sessions(id) ON DELETE CASCADE,
        exercise_index INTEGER NOT NULL,
        set_number     INTEGER NOT NULL,
        weight         NUMERIC(6, 2) CHECK (weight >= 0 AND weight <= 1000),
        reps           INTEGER CHECK (reps BETWEEN 1 AND 100),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (session_id, exercise_index, set_number)
      )
    `);

    // Append-only audit of every significant action, so the workout can be
    // reconstructed or inspected after the fact.
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS workout_events (
        id             SERIAL PRIMARY KEY,
        session_id     INTEGER NOT NULL REFERENCES workout_sessions(id) ON DELETE CASCADE,
        kind           TEXT NOT NULL,
        exercise_index INTEGER,
        set_number     INTEGER,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(
      'CREATE INDEX IF NOT EXISTS workout_events_session_id_idx ON workout_events (session_id)',
    );
  }

  private async recordEvent(
    client: PoolClient,
    sessionId: number,
    kind: WorkoutEventKind,
    exerciseIndex: number | null,
    setNumber: number | null,
  ): Promise<void> {
    await client.query(
      `INSERT INTO workout_events (session_id, kind, exercise_index, set_number)
       VALUES ($1, $2, $3, $4)`,
      [sessionId, kind, exerciseIndex, setNumber],
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
    // exercises within a group likewise. This ordering is what "3 / 8" counts.
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
          [userId, day.id, config.reps, config.restPeriod, SETS_PER_EXERCISE],
        );
        const id = inserted.rows[0]?.id;
        if (id === undefined) {
          throw new Error('Could not create the workout session.');
        }

        for (const [position, exercise] of exercises.entries()) {
          await client.query(
            `INSERT INTO workout_session_exercises (session_id, position, exercise_id, name)
             VALUES ($1, $2, $3, $4)`,
            [id, position, exercise.id, exercise.name],
          );
        }

        await this.recordEvent(client, id, 'workout_started', 0, 1);
        await this.recordEvent(client, id, 'exercise_started', 0, 1);
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
      await client.query(
        `INSERT INTO workout_set_drafts (session_id, exercise_index, set_number, weight, reps)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (session_id, exercise_index, set_number) DO UPDATE
           SET weight = EXCLUDED.weight,
               reps = EXCLUDED.reps,
               updated_at = now()`,
        [
          session.id,
          session.exercise_index,
          session.set_number,
          draft.weight,
          draft.reps,
        ],
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
  ): Promise<WorkoutState> {
    return this.db.transaction(async (client) => {
      const session = await this.lockActiveSession(client, userId);

      // Fail safe: a set can only be finished from the set phase. Arriving here
      // while resting means the client is out of step with the database.
      if (session.resting_since !== null) {
        throw new BadRequestException(
          'Rest is in progress — start the next set first.',
        );
      }

      const exerciseCount = await this.countExercises(client, session.id);

      // Idempotent on the cursor: a retried tap overwrites the same row rather
      // than logging the set twice.
      await client.query(
        `INSERT INTO workout_sets
           (session_id, exercise_index, set_number, target_reps, reps, weight)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (session_id, exercise_index, set_number) DO UPDATE
           SET reps = EXCLUDED.reps,
               weight = EXCLUDED.weight,
               completed_at = now()`,
        [
          session.id,
          session.exercise_index,
          session.set_number,
          session.planned_reps,
          reps,
          weight,
        ],
      );
      await client.query(
        `DELETE FROM workout_set_drafts
          WHERE session_id = $1 AND exercise_index = $2 AND set_number = $3`,
        [session.id, session.exercise_index, session.set_number],
      );
      await this.recordEvent(
        client,
        session.id,
        'set_completed',
        session.exercise_index,
        session.set_number,
      );

      const isFinalSet = session.set_number >= session.sets_per_exercise;
      const isFinalExercise = session.exercise_index >= exerciseCount - 1;

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
          session.exercise_index,
          session.set_number,
        );
        return this.buildState(
          this.mergeSession(session, updated.rows[0]),
          client,
        );
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
        session.exercise_index,
        session.set_number,
      );
      return this.buildState(
        this.mergeSession(session, updated.rows[0]),
        client,
      );
    });
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

      await this.recordEvent(
        client,
        session.id,
        'rest_finished',
        session.exercise_index,
        session.set_number,
      );

      const movesToNextExercise =
        session.set_number >= session.sets_per_exercise;
      const nextExerciseIndex = movesToNextExercise
        ? session.exercise_index + 1
        : session.exercise_index;
      const nextSetNumber = movesToNextExercise ? 1 : session.set_number + 1;

      // The final set of the final exercise completes the workout in finishSet,
      // so the cursor can never be advanced past the last exercise here. Guard
      // anyway rather than trust that invariant from a mutating endpoint.
      const exerciseCount = await this.countExercises(client, session.id);
      if (nextExerciseIndex >= exerciseCount) {
        throw new BadRequestException('The workout has no further exercises.');
      }

      const updated = await client.query<SessionRow>(
        `UPDATE workout_sessions
            SET resting_since = NULL, exercise_index = $2, set_number = $3
          WHERE id = $1
        RETURNING *, now() AS server_now`,
        [session.id, nextExerciseIndex, nextSetNumber],
      );

      await this.recordEvent(
        client,
        session.id,
        movesToNextExercise ? 'exercise_started' : 'next_set_started',
        nextExerciseIndex,
        nextSetNumber,
      );

      return this.buildState(
        this.mergeSession(session, updated.rows[0]),
        client,
      );
    });
  }

  /**
   * Pushes the current exercise to the back of the queue — the machine was busy.
   * Everything behind it shifts forward one place, so the exercise that was next
   * becomes current and nothing is skipped: the deferred exercise comes round
   * again, and the workout cannot complete until it has been done.
   *
   * Only exercises with nothing logged against them may move. A completed set
   * records its `workout_sets.exercise_index` — a *position*, not an exercise id
   * — so moving a position that has sets under it would silently reattribute
   * them to a different lift. The cursor sits at the first unfinished exercise
   * and everything ahead of it is untouched by definition, so shifting the
   * cursor's tail is the one rewrite that cannot corrupt history. Refuse the
   * rest.
   */
  async deferExercise(userId: number): Promise<WorkoutState> {
    return this.db.transaction(async (client) => {
      const session = await this.lockActiveSession(client, userId);

      if (session.resting_since !== null) {
        throw new BadRequestException(
          'Rest is in progress — start the next set first.',
        );
      }

      const cursor = session.exercise_index;
      const exerciseCount = await this.countExercises(client, session.id);

      // Nothing to do first: deferring the last exercise would just re-present
      // it. Fail rather than pretend the tap did something.
      if (cursor >= exerciseCount - 1) {
        throw new BadRequestException(
          'This is the last exercise — there is nothing to do before it.',
        );
      }

      const logged = await client.query(
        'SELECT 1 FROM workout_sets WHERE session_id = $1 AND exercise_index = $2 LIMIT 1',
        [session.id, cursor],
      );
      if (logged.rowCount) {
        throw new BadRequestException(
          'This exercise is already underway — finish it before deferring.',
        );
      }

      const lastPosition = exerciseCount - 1;

      // The order the tail should end up in: everything after the cursor moves
      // up one, and the deferred exercise trails them.
      const tail: number[] = [];
      for (let position = cursor + 1; position <= lastPosition; position++) {
        tail.push(position);
      }
      tail.push(cursor);

      // Renumbered in two passes, because (session_id, position) is a primary
      // key: a single `SET position = position - 1` can collide with a row it
      // has not renumbered yet. Postgres checks the key per row, not at the end
      // of the statement, and the order it visits rows in is not ours to
      // choose — it happens to work on an ascending scan, which is exactly the
      // kind of luck not to build on. Park the tail on negatives (always free,
      // positions are non-negative), then land it on the final positions.
      await client.query(
        `UPDATE workout_session_exercises
            SET position = -position - 1
          WHERE session_id = $1 AND position >= $2`,
        [session.id, cursor],
      );
      for (const [offset, from] of tail.entries()) {
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
          WHERE session_id = $1 AND position = $2`,
        [session.id, lastPosition],
      );

      // Drafts are keyed by position, not by exercise. Any draft at or after the
      // cursor now names a different lift, so it is no longer the user's input.
      await client.query(
        'DELETE FROM workout_set_drafts WHERE session_id = $1 AND exercise_index >= $2',
        [session.id, cursor],
      );

      await this.recordEvent(
        client,
        session.id,
        'exercise_deferred',
        cursor,
        session.set_number,
      );
      // The cursor has not moved, but the exercise under it has: what is now at
      // `cursor` is the exercise the user is about to start.
      await this.recordEvent(
        client,
        session.id,
        'exercise_started',
        cursor,
        session.set_number,
      );

      return this.buildState(session, client);
    });
  }

  /**
   * Abandons the unfinished workout, freeing the user to start another. The row
   * is kept (never deleted) so the sets already logged remain part of history.
   */
  async abandonWorkout(userId: number): Promise<void> {
    await this.db.transaction(async (client) => {
      const session = await this.lockActiveSession(client, userId);
      await client.query(
        'UPDATE workout_sessions SET abandoned_at = now(), resting_since = NULL WHERE id = $1',
        [session.id],
      );
      await this.recordEvent(
        client,
        session.id,
        'workout_abandoned',
        session.exercise_index,
        session.set_number,
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
    const run = <T extends Record<string, unknown>>(
      text: string,
      params: unknown[],
    ) =>
      client ? client.query<T>(text, params) : this.db.query<T>(text, params);

    const exercisesResult = await run<{
      position: number;
      name: string;
      deferred_at: Date | null;
    }>(
      `SELECT position, name, deferred_at
         FROM workout_session_exercises
        WHERE session_id = $1
        ORDER BY position`,
      [session.id],
    );
    const exercises: WorkoutExercise[] = exercisesResult.rows.map((row) => ({
      position: row.position,
      name: row.name,
      deferred: row.deferred_at !== null,
    }));

    const totalsResult = await run<{
      sets_completed: string;
      exercises_completed: string;
      current_exercise_sets: string;
    }>(
      `SELECT count(*) AS sets_completed,
              count(DISTINCT exercise_index) AS exercises_completed,
              count(*) FILTER (WHERE exercise_index = $2) AS current_exercise_sets
         FROM workout_sets
        WHERE session_id = $1`,
      [session.id, session.exercise_index],
    );
    const setsCompleted = Number(totalsResult.rows[0]?.sets_completed ?? 0);
    const exercisesCompleted = Number(
      totalsResult.rows[0]?.exercises_completed ?? 0,
    );
    const currentExerciseSets = Number(
      totalsResult.rows[0]?.current_exercise_sets ?? 0,
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

    const exerciseName = exercises[session.exercise_index]?.name ?? '';

    // Mirrors the guards in `deferExercise`. The button is hidden when this is
    // false; the endpoint refuses anyway, since the client is untrusted.
    const canDefer =
      phase === 'set' &&
      currentExerciseSets === 0 &&
      session.exercise_index < exercises.length - 1;

    // Only the ones still waiting: once the cursor reaches a deferred exercise
    // it is no longer pending, it is the exercise being done.
    const deferredCount = completed
      ? 0
      : exercises.filter(
          (exercise) =>
            exercise.deferred && exercise.position > session.exercise_index,
        ).length;

    const { plannedWeight, draftReps } = completed
      ? { plannedWeight: null, draftReps: null }
      : await this.resolvePrefill(session, exerciseName, run);

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
      exerciseIndex: session.exercise_index,
      exerciseCount: exercises.length,
      exerciseName,
      canDefer,
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
    };
  }

  /**
   * What to show in the weight/reps inputs for the current set: the draft the
   * user already typed, falling back to the weight they last lifted on this
   * exercise (in any workout) so the common case needs no typing at all.
   */
  private async resolvePrefill(
    session: SessionRow,
    exerciseName: string,
    run: <T extends Record<string, unknown>>(
      text: string,
      params: unknown[],
    ) => Promise<{ rows: T[] }>,
  ): Promise<{ plannedWeight: number | null; draftReps: number | null }> {
    const draftResult = await run<{
      weight: number | null;
      reps: number | null;
    }>(
      `SELECT weight::float8 AS weight, reps
         FROM workout_set_drafts
        WHERE session_id = $1 AND exercise_index = $2 AND set_number = $3`,
      [session.id, session.exercise_index, session.set_number],
    );
    const draft = draftResult.rows[0];
    if (draft?.weight !== null && draft?.weight !== undefined) {
      return { plannedWeight: draft.weight, draftReps: draft.reps ?? null };
    }

    // No draft weight — reuse the last weight lifted on this exercise. Matched
    // by name, so a renamed exercise simply starts fresh rather than inheriting
    // a stranger's numbers.
    const lastResult = await run<{ weight: number }>(
      `SELECT ws.weight::float8 AS weight
         FROM workout_sets ws
         JOIN workout_sessions s ON s.id = ws.session_id
         JOIN workout_session_exercises e
           ON e.session_id = ws.session_id AND e.position = ws.exercise_index
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

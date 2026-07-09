import type { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { DatabaseService } from '../database/database.service';
import { TrainingConfigService } from '../training/training-config.service';
import { WorkoutService } from './workout.service';

/**
 * These run against a real Postgres, not a fake: the service leans on
 * `FOR UPDATE`, partial unique indexes, `ON CONFLICT`, and `count(*) FILTER`,
 * and the subject of the suite is the schema and its migration. An in-memory
 * stand-in that reimplemented those would only be testing the stand-in.
 *
 * Point `TEST_DATABASE_URL` at a throwaway Postgres to run them — the user needs
 * rights to create databases, since each group gets its own:
 *
 *     TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres npm test
 *
 * Without it the suite skips rather than failing, so `npm test` still works on a
 * machine with no database.
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

if (!TEST_DATABASE_URL) {
  console.warn(
    'Skipping WorkoutService database tests: set TEST_DATABASE_URL to run them.',
  );
}

jest.setTimeout(60_000);

const SETS_PER_EXERCISE = 4;

/** The queue as the user would read it, top to bottom. */
const names = (workout: { exercises: { name: string }[] }): string[] =>
  workout.exercises.map((exercise) => exercise.name);

/**
 * Sets logged against the exercise the cursor is on. This is the whole of what
 * the workout screen renders the "Machine busy — do this later" button from —
 * it shows while this is zero — so these assertions are what stands between a
 * queue change and the button disappearing from the UI again.
 */
const currentExerciseSets = (workout: {
  exercises: { completedSets: number }[];
  exerciseIndex: number;
}): number => workout.exercises[workout.exerciseIndex].completedSets;

/** The connection string for one of the test databases on the same server. */
function urlFor(database: string): string {
  const url = new URL(TEST_DATABASE_URL ?? '');
  url.pathname = `/${database}`;
  return url.toString();
}

function connect(database: string): DatabaseService {
  const config = { get: () => urlFor(database) } as unknown as ConfigService;
  return new DatabaseService(config);
}

/** A database of its own per group, so the two schemas cannot collide. */
async function createDatabase(name: string): Promise<void> {
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    // Identifiers cannot be parameterized; these are compile-time constants
    // from this file, never user input.
    await client.query(`DROP DATABASE IF EXISTS ${name}`);
    await client.query(`CREATE DATABASE ${name}`);
  } finally {
    await client.end();
  }
}

/** The tables the workout schema depends on but does not own. */
async function createDependencies(db: DatabaseService): Promise<void> {
  await db.query(
    'CREATE TABLE users (id SERIAL PRIMARY KEY, username TEXT NOT NULL UNIQUE)',
  );
  await db.query(`
    CREATE TABLE training_days (
      id SERIAL PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      day TEXT NOT NULL,
      focus TEXT NOT NULL,
      sort_order INTEGER NOT NULL
    )
  `);
  await db.query(`
    CREATE TABLE exercises (
      id SERIAL PRIMARY KEY,
      training_day_id INTEGER NOT NULL REFERENCES training_days(id) ON DELETE CASCADE,
      group_index INTEGER NOT NULL,
      item_index INTEGER NOT NULL,
      name TEXT NOT NULL,
      UNIQUE (training_day_id, group_index, item_index)
    )
  `);
}

/** A training day whose exercises are performed in the order given. */
async function createDay(
  db: DatabaseService,
  slug: string,
  exerciseNames: string[],
): Promise<void> {
  const day = await db.query<{ id: number }>(
    `INSERT INTO training_days (slug, day, focus, sort_order)
     VALUES ($1, 'Monday', 'Chest', 1) RETURNING id`,
    [slug],
  );
  const dayId = day.rows[0].id;
  for (const [index, name] of exerciseNames.entries()) {
    await db.query(
      `INSERT INTO exercises (training_day_id, group_index, item_index, name)
       VALUES ($1, 0, $2, $3)`,
      [dayId, index, name],
    );
  }
}

async function createUser(
  db: DatabaseService,
  username: string,
): Promise<number> {
  const result = await db.query<{ id: number }>(
    'INSERT INTO users (username) VALUES ($1) RETURNING id',
    [username],
  );
  return result.rows[0].id;
}

/**
 * How many sets are logged against each exercise, resolved through the set's
 * exercise identity. This is the question the whole refactor exists to answer
 * correctly, so every test asks it this way.
 */
async function setsByExerciseName(
  db: DatabaseService,
  sessionId: number,
): Promise<Record<string, number>> {
  const result = await db.query<{ name: string; count: string }>(
    `SELECT e.name, count(*) AS count
       FROM workout_sets ws
       JOIN workout_session_exercises e ON e.id = ws.exercise_id
      WHERE ws.workout_session_id = $1
      GROUP BY e.name`,
    [sessionId],
  );
  return Object.fromEntries(
    result.rows.map((row) => [row.name, Number(row.count)]),
  );
}

describeDb('WorkoutService — exercise identity outlives queue position', () => {
  let db: DatabaseService;
  let service: WorkoutService;
  let userId: number;
  let lifter = 0;

  const QUEUE = ['Bench Press', 'Chest Press Machine', 'Incline Press'];
  /** The queue the defer rules are specified against. */
  const SPEC_QUEUE = [
    'Bench Press',
    'Chest Press Machine',
    'Incline Press',
    'Pec Deck',
  ];

  beforeAll(async () => {
    await createDatabase('gymhelper_test_identity');
    db = connect('gymhelper_test_identity');
    await createDependencies(db);
    await createDay(db, 'chest', QUEUE);
    await createDay(db, 'four', [...QUEUE, 'Cable Fly']);
    await createDay(db, 'spec', SPEC_QUEUE);

    const trainingConfig = new TrainingConfigService(db);
    await trainingConfig.onModuleInit();
    service = new WorkoutService(db, trainingConfig);
    // Twice, because every boot runs it: the second must be a no-op on a
    // database that was created fresh by the first.
    await service.ensureSchema();
    await service.ensureSchema();
  });

  afterAll(async () => {
    await db.onModuleDestroy();
  });

  beforeEach(async () => {
    // A fresh user per test: one active workout per user is enforced by index.
    userId = await createUser(db, `lifter-${++lifter}`);
  });

  /**
   * Logs the sets the current exercise still owes, resting between each, and
   * leaves the cursor on the next exercise. Picks up from wherever the workout
   * currently stands.
   */
  async function completeCurrentExercise(weight: number): Promise<void> {
    const state = await service.getActiveWorkout(userId);
    if (!state) return;
    for (let set = state.setNumber; set <= SETS_PER_EXERCISE; set++) {
      const afterSet = await service.finishSet(userId, weight, 10);
      if (afterSet.phase === 'completed') return;
      await service.startNextSet(userId);
    }
  }

  it('reports the first exercise of a new workout as untouched', async () => {
    const started = await service.startWorkout(userId, 'chest');

    // A new workout opens on exercise 1, before its first set.
    expect(started.exerciseIndex).toBe(0);
    expect(started.exerciseName).toBe('Bench Press');
    expect(started.phase).toBe('set');
    expect(started.setsCompleted).toBe(0);
    expect(currentExerciseSets(started)).toBe(0);

    // And it still reads untouched when the screen reloads onto that workout,
    // since the state it renders is read back from the database, not remembered.
    const resumed = await service.getWorkout(userId, started.id);
    expect(resumed?.exerciseIndex).toBe(0);
    expect(resumed?.setsCompleted).toBe(0);
    expect(currentExerciseSets(resumed!)).toBe(0);
  });

  /**
   * The regression that shipped twice: the button appeared before the very
   * first exercise and never again. Walking a four-exercise workout end to end
   * is the only way to catch that — a test that stops after exercise 1 passes
   * either way. Asserted against the state each *mutation* returns, since that
   * is the object the workout screen renders, not a later read of the database.
   */
  it('reports every exercise as untouched until its own first set', async () => {
    await service.startWorkout(userId, 'four');
    const queue = ['Bench Press', 'Chest Press Machine', 'Incline Press'];

    for (const [position, name] of queue.entries()) {
      // Before the first set of this exercise: the machine may be busy.
      const opening = await service.getActiveWorkout(userId);
      expect(opening?.exerciseName).toBe(name);
      expect(opening?.exerciseIndex).toBe(position);
      expect(opening?.phase).toBe('set');
      expect(opening?.setNumber).toBe(1);
      expect(currentExerciseSets(opening!)).toBe(0);

      // The first set lands: the exercise is underway.
      const afterFirstSet = await service.finishSet(userId, 60, 10);
      expect(afterFirstSet.phase).toBe('rest');
      expect(currentExerciseSets(afterFirstSet)).toBe(1);

      // ...and its count only climbs for the rest of this exercise.
      for (let set = 2; set <= SETS_PER_EXERCISE; set++) {
        const nextSet = await service.startNextSet(userId);
        expect(nextSet.exerciseName).toBe(name);
        expect(nextSet.setNumber).toBe(set);
        expect(nextSet.phase).toBe('set');
        expect(currentExerciseSets(nextSet)).toBe(set - 1);

        await service.finishSet(userId, 60, 10);
      }

      // Crossing into the next exercise is what resets the count to zero, and
      // the state that mutation returns is what the screen renders.
      const nextExercise = await service.startNextSet(userId);
      expect(nextExercise.exerciseIndex).toBe(position + 1);
      expect(nextExercise.setNumber).toBe(1);
      expect(currentExerciseSets(nextExercise)).toBe(0);
    }

    // The fourth and last exercise is no different: untouched is untouched.
    const last = await service.getActiveWorkout(userId);
    expect(last?.exerciseName).toBe('Cable Fly');
    expect(last?.exerciseIndex).toBe(3);
    expect(currentExerciseSets(last!)).toBe(0);
  });

  /**
   * Counted per exercise, never per workout: a whole-workout count would report
   * exercise 2 as underway before it had a single set on it, which is exactly
   * the bug that hid the button everywhere after exercise 1.
   */
  it('counts sets against the current exercise, not the whole workout', async () => {
    await service.startWorkout(userId, 'chest');

    // Bench Press is done — four sets on the workout, none on the next lift.
    await completeCurrentExercise(60);

    const second = await service.getActiveWorkout(userId);
    expect(second?.exerciseName).toBe('Chest Press Machine');
    expect(second?.setsCompleted).toBe(SETS_PER_EXERCISE);
    expect(currentExerciseSets(second!)).toBe(0);

    // Resting does not change what is logged against the exercise, either.
    const resting = await service.finishSet(userId, 50, 10);
    expect(resting.phase).toBe('rest');
    expect(currentExerciseSets(resting)).toBe(1);

    const secondSet = await service.startNextSet(userId);
    expect(secondSet.phase).toBe('set');
    expect(secondSet.setNumber).toBe(2);
    expect(currentExerciseSets(secondSet)).toBe(1);
  });

  /**
   * The client is untrusted, so the endpoint re-checks the rule the button is
   * drawn from rather than relying on it having been hidden.
   */
  it('refuses to defer an exercise that already has a set on it', async () => {
    await service.startWorkout(userId, 'chest');

    // One set logged, then rest ended: the exercise is underway.
    await service.finishSet(userId, 60, 10);
    await service.startNextSet(userId);

    await expect(service.deferExercise(userId)).rejects.toThrow(
      /already underway/i,
    );

    // And the queue is exactly as it was.
    const state = await service.getActiveWorkout(userId);
    expect(names(state!)).toEqual(QUEUE);
    expect(state?.exerciseName).toBe('Bench Press');
  });

  it('refuses to defer while rest is in progress', async () => {
    await service.startWorkout(userId, 'chest');
    const resting = await service.finishSet(userId, 60, 10);
    expect(resting.phase).toBe('rest');

    await expect(service.deferExercise(userId)).rejects.toThrow(/Rest/i);
  });

  /**
   * Rests the current exercise out: logs every set it still owes and stops on
   * the rest that follows the last one, cursor still on the finished exercise.
   * This is the screen the user is on while walking to the next machine.
   */
  async function restAfterCurrentExercise(weight: number): Promise<void> {
    const state = await service.getActiveWorkout(userId);
    if (!state) return;
    for (let set = state.setNumber; set <= SETS_PER_EXERCISE; set++) {
      if (set > state.setNumber) await service.startNextSet(userId);
      await service.finishSet(userId, weight, 10);
    }
  }

  /**
   * The bug every abandoned workout died on: the rest after the last set of an
   * exercise announces the next one by name, but the cursor has not moved, so
   * there was no way to defer the machine the user is walking towards. That
   * rest is now a place to defer from — it ends, and the exercise it lands on
   * is the one pushed back.
   */
  it('defers the exercise coming up when the machine is found busy during rest', async () => {
    await service.startWorkout(userId, 'four');
    await restAfterCurrentExercise(60); // Bench Press, all four sets.

    const resting = await service.getActiveWorkout(userId);
    expect(resting?.phase).toBe('rest');
    expect(resting?.exerciseIndex).toBe(0);
    expect(resting?.exerciseName).toBe('Bench Press');

    // One tap, from the rest screen: rest ends, and the exercise it led into
    // goes behind the next available one.
    const deferred = await service.deferExercise(userId);

    expect(deferred.phase).toBe('set');
    expect(deferred.exerciseIndex).toBe(1);
    expect(deferred.setNumber).toBe(1);
    expect(deferred.exerciseName).toBe('Incline Press');
    expect(currentExerciseSets(deferred)).toBe(0);
    expect(deferred.deferredCount).toBe(1);
    expect(names(deferred)).toEqual([
      'Bench Press',
      'Incline Press',
      'Chest Press Machine',
      'Cable Fly',
    ]);

    // The sets already logged stayed with the exercise that earned them.
    await expect(setsByExerciseName(db, deferred.id)).resolves.toEqual({
      'Bench Press': SETS_PER_EXERCISE,
    });
  });

  /**
   * Fail safe: the rest leads into the last exercise, which has nothing behind
   * it to swap with. The tap is refused — and because ending the rest and
   * deferring are one transaction, the refusal leaves the workout resting
   * exactly where it was rather than half-advanced.
   */
  it('refuses to defer from the rest that leads into the last exercise', async () => {
    await service.startWorkout(userId, 'chest');
    await completeCurrentExercise(60); // Bench Press
    await restAfterCurrentExercise(50); // Chest Press Machine — Incline is last.

    await expect(service.deferExercise(userId)).rejects.toThrow(
      /last exercise/i,
    );

    const after = await service.getActiveWorkout(userId);
    expect(after?.phase).toBe('rest');
    expect(after?.exerciseIndex).toBe(1);
    expect(after?.setNumber).toBe(SETS_PER_EXERCISE);
    expect(names(after!)).toEqual(QUEUE);
  });

  /** Nothing to hop: the rotation would have no target. */
  it('refuses to defer the last exercise', async () => {
    await service.startWorkout(userId, 'chest');
    await completeCurrentExercise(60); // Bench Press
    await completeCurrentExercise(50); // Chest Press Machine

    const last = await service.getActiveWorkout(userId);
    expect(last?.exerciseName).toBe('Incline Press');
    expect(last?.exerciseIndex).toBe(QUEUE.length - 1);
    expect(currentExerciseSets(last!)).toBe(0);

    await expect(service.deferExercise(userId)).rejects.toThrow(
      /last exercise/i,
    );
  });

  it('keeps completed sets attached to their exercise across a defer', async () => {
    const started = await service.startWorkout(userId, 'chest');
    expect(names(started)).toEqual(QUEUE);

    // 1. Complete the sets for Bench Press.
    await completeCurrentExercise(60);

    // 2. The cursor is now on Chest Press Machine — defer it.
    const beforeDefer = await service.getActiveWorkout(userId);
    expect(beforeDefer?.exerciseName).toBe('Chest Press Machine');
    expect(currentExerciseSets(beforeDefer!)).toBe(0);

    const deferred = await service.deferExercise(userId);

    // 3. Only positions moved.
    expect(names(deferred)).toEqual([
      'Bench Press',
      'Incline Press',
      'Chest Press Machine',
    ]);
    expect(deferred.exerciseName).toBe('Incline Press');
    expect(deferred.deferredCount).toBe(1);

    // 4/5. History still resolves to the exercise actually performed — even
    // though position 1 now names a different lift than when it was logged.
    await expect(setsByExerciseName(db, started.id)).resolves.toEqual({
      'Bench Press': SETS_PER_EXERCISE,
    });
    expect(deferred.setsCompleted).toBe(SETS_PER_EXERCISE);
    expect(deferred.exercisesCompleted).toBe(1);
  });

  it('survives the order changing a hundred times', async () => {
    const started = await service.startWorkout(userId, 'chest');
    await completeCurrentExercise(60);

    // The cursor sits on an untouched exercise, so deferring just cycles the two
    // remaining lifts past each other. Bench Press never moves: it is done.
    for (let i = 0; i < 100; i++) {
      await service.deferExercise(userId);
    }

    const state = await service.getActiveWorkout(userId);
    expect(state?.exercises).toHaveLength(3);
    expect([...names(state!)].sort()).toEqual([...QUEUE].sort());
    expect(names(state!)[0]).toBe('Bench Press');

    await expect(setsByExerciseName(db, started.id)).resolves.toEqual({
      'Bench Press': SETS_PER_EXERCISE,
    });
  });

  it('tracks several deferred exercises at once', async () => {
    await service.startWorkout(userId, 'four');

    const first = await service.deferExercise(userId);
    expect(first.exerciseName).toBe('Chest Press Machine');
    expect(first.deferredCount).toBe(1);

    // Chest Press Machine hops Incline Press — the first exercise ahead that is
    // not itself deferred — rather than swapping with the deferred Bench Press.
    const second = await service.deferExercise(userId);
    expect(names(second)).toEqual([
      'Incline Press',
      'Chest Press Machine',
      'Bench Press',
      'Cable Fly',
    ]);
    expect(second.exerciseName).toBe('Incline Press');
    expect(second.deferredCount).toBe(2);
  });

  it('brings a deferred exercise back after exactly one exercise', async () => {
    const started = await service.startWorkout(userId, 'spec');
    expect(names(started)).toEqual(SPEC_QUEUE);

    await completeCurrentExercise(60); // Bench Press

    // Chest Press Machine is busy: it goes behind Incline Press only.
    const deferred = await service.deferExercise(userId);
    expect(names(deferred)).toEqual([
      'Bench Press',
      'Incline Press',
      'Chest Press Machine',
      'Pec Deck',
    ]);
    expect(deferred.exerciseName).toBe('Incline Press');

    // The whole point: after Incline Press comes Chest Press Machine, not Pec
    // Deck. A deferred exercise waits one exercise, not the rest of the workout.
    await completeCurrentExercise(40);
    const back = await service.getActiveWorkout(userId);
    expect(back?.exerciseName).toBe('Chest Press Machine');
    expect(back?.deferredCount).toBe(0);

    // Nothing was skipped and nothing was reattributed.
    await expect(setsByExerciseName(db, started.id)).resolves.toEqual({
      'Bench Press': SETS_PER_EXERCISE,
      'Incline Press': SETS_PER_EXERCISE,
    });
  });

  it('rotates each unavailable exercise past one available one', async () => {
    await service.startWorkout(userId, 'spec');
    await completeCurrentExercise(60); // Bench Press

    await service.deferExercise(userId); // Chest Press Machine is busy
    // Incline Press is busy too. It must land behind Pec Deck — the next
    // available exercise — and stay ahead of the already-deferred machine.
    const twice = await service.deferExercise(userId);
    expect(names(twice)).toEqual([
      'Bench Press',
      'Pec Deck',
      'Incline Press',
      'Chest Press Machine',
    ]);
    expect(twice.exerciseName).toBe('Pec Deck');
    expect(twice.deferredCount).toBe(2);

    // And the queue drains in exactly that order.
    await completeCurrentExercise(30); // Pec Deck
    expect((await service.getActiveWorkout(userId))?.exerciseName).toBe(
      'Incline Press',
    );
    await completeCurrentExercise(40); // Incline Press
    expect((await service.getActiveWorkout(userId))?.exerciseName).toBe(
      'Chest Press Machine',
    );
  });

  it('trades places when every exercise ahead is already deferred', async () => {
    await service.startWorkout(userId, 'chest');
    await completeCurrentExercise(60); // Bench Press

    // Two left, both pushed back: there is no available exercise to hop, so the
    // pair simply cycles and the user keeps moving.
    await service.deferExercise(userId);
    const second = await service.deferExercise(userId);
    expect(names(second)).toEqual([
      'Bench Press',
      'Chest Press Machine',
      'Incline Press',
    ]);
    expect(second.exerciseName).toBe('Chest Press Machine');
  });

  it('restores the reordered queue after the app restarts', async () => {
    const started = await service.startWorkout(userId, 'spec');
    await completeCurrentExercise(60); // Bench Press
    await service.deferExercise(userId); // Chest Press Machine is busy
    await service.deferExercise(userId); // so is Incline Press
    await service.finishSet(userId, 30, 10); // one set of Pec Deck

    // A restart is a new pool, a new service, and nothing carried over in
    // memory: the queue has to come back off the database exactly as it was.
    const restartedDb = connect('gymhelper_test_identity');
    const restartedConfig = new TrainingConfigService(restartedDb);
    const restarted = new WorkoutService(restartedDb, restartedConfig);
    await restarted.ensureSchema();
    try {
      const resumed = await restarted.getActiveWorkout(userId);
      expect(resumed?.id).toBe(started.id);
      expect(names(resumed!)).toEqual([
        'Bench Press',
        'Pec Deck',
        'Incline Press',
        'Chest Press Machine',
      ]);
      expect(resumed?.exerciseName).toBe('Pec Deck');
      expect(resumed?.deferredCount).toBe(2);
      expect(resumed?.setsCompleted).toBe(SETS_PER_EXERCISE + 1);

      await expect(setsByExerciseName(db, started.id)).resolves.toEqual({
        'Bench Press': SETS_PER_EXERCISE,
        'Pec Deck': 1,
      });
    } finally {
      await restartedDb.onModuleDestroy();
    }
  });

  it('restores the reordered queue when a workout is resumed', async () => {
    const started = await service.startWorkout(userId, 'chest');
    await completeCurrentExercise(60);
    await service.deferExercise(userId);
    await service.finishSet(userId, 40, 10);

    // A resume is just another read of the database.
    const resumed = await service.getActiveWorkout(userId);
    expect(resumed?.id).toBe(started.id);
    expect(names(resumed!)).toEqual([
      'Bench Press',
      'Incline Press',
      'Chest Press Machine',
    ]);
    expect(resumed?.exerciseName).toBe('Incline Press');
    expect(resumed?.setsCompleted).toBe(SETS_PER_EXERCISE + 1);

    await expect(setsByExerciseName(db, started.id)).resolves.toEqual({
      'Bench Press': SETS_PER_EXERCISE,
      'Incline Press': 1,
    });
  });

  it('summarises a completed workout by exercise, not by position', async () => {
    const started = await service.startWorkout(userId, 'chest');

    await completeCurrentExercise(60); // Bench Press
    await service.deferExercise(userId); // Chest Press Machine -> back
    await completeCurrentExercise(40); // Incline Press
    await completeCurrentExercise(50); // Chest Press Machine

    const finished = await service.getWorkout(userId, started.id);
    expect(finished?.phase).toBe('completed');
    expect(finished?.setsCompleted).toBe(3 * SETS_PER_EXERCISE);
    expect(finished?.exercisesCompleted).toBe(3);
    expect(finished?.deferredCount).toBe(0);

    // The historical summary: each lift owns exactly the sets performed on it,
    // regardless of where it ended up in the queue.
    await expect(setsByExerciseName(db, started.id)).resolves.toEqual({
      'Bench Press': SETS_PER_EXERCISE,
      'Incline Press': SETS_PER_EXERCISE,
      'Chest Press Machine': SETS_PER_EXERCISE,
    });

    // And the weights went with them.
    const weights = await db.query<{ name: string; weight: number }>(
      `SELECT DISTINCT e.name, ws.actual_weight::float8 AS weight
         FROM workout_sets ws
         JOIN workout_session_exercises e ON e.id = ws.exercise_id
        WHERE ws.workout_session_id = $1
        ORDER BY e.name`,
      [started.id],
    );
    expect(weights.rows).toEqual([
      { name: 'Bench Press', weight: 60 },
      { name: 'Chest Press Machine', weight: 50 },
      { name: 'Incline Press', weight: 40 },
    ]);
  });

  it('records planned and actual values, and the rest taken after a set', async () => {
    const started = await service.startWorkout(userId, 'chest');
    await service.finishSet(userId, 62.5, 9);
    await service.startNextSet(userId);

    const row = await db.query<{
      planned_reps: number;
      actual_reps: number;
      actual_weight: number;
      rest_duration: number | null;
      started_at: Date | null;
      created_at: Date;
    }>(
      `SELECT planned_reps, actual_reps, actual_weight::float8 AS actual_weight,
              rest_duration, started_at, created_at
         FROM workout_sets WHERE workout_session_id = $1`,
      [started.id],
    );
    expect(row.rows[0].planned_reps).toBe(12); // the config default
    expect(row.rows[0].actual_reps).toBe(9);
    expect(row.rows[0].actual_weight).toBe(62.5);
    expect(row.rows[0].started_at).toBeInstanceOf(Date);
    expect(row.rows[0].created_at).toBeInstanceOf(Date);
    expect(row.rows[0].rest_duration).toBeGreaterThanOrEqual(0);
  });

  it('does not leak a draft onto the exercise that takes over the position', async () => {
    await service.startWorkout(userId, 'chest');
    // Type a weight against Bench Press, then push it back.
    await service.saveDraft(userId, { weight: 77.5, reps: 8 });
    const deferred = await service.deferExercise(userId);

    // Position 0 is now Chest Press Machine, which has no draft and no history.
    // Under the old position-keyed drafts this is where 77.5 would surface.
    expect(deferred.exerciseName).toBe('Chest Press Machine');
    expect(deferred.plannedWeight).toBeNull();
    expect(deferred.draftReps).toBeNull();
  });

  it('still refuses to defer an exercise that is underway, or the last one', async () => {
    await service.startWorkout(userId, 'chest');
    await service.finishSet(userId, 60, 10);
    await service.startNextSet(userId);

    // Bench Press has a set on it now.
    await expect(service.deferExercise(userId)).rejects.toThrow(
      /already underway/,
    );

    await completeCurrentExercise(60);
    await service.deferExercise(userId); // Chest Press Machine -> back
    await completeCurrentExercise(40); // Incline Press

    // Only Chest Press Machine is left.
    await expect(service.deferExercise(userId)).rejects.toThrow(
      /last exercise/,
    );
  });

  it('prefills the weight last lifted on the same exercise, not the same slot', async () => {
    // A first, completed workout establishes the history.
    const first = await service.startWorkout(userId, 'chest');
    await completeCurrentExercise(60); // Bench Press
    await service.deferExercise(userId); // Chest Press Machine -> back
    await completeCurrentExercise(40); // Incline Press
    await completeCurrentExercise(50); // Chest Press Machine
    expect((await service.getWorkout(userId, first.id))?.phase).toBe(
      'completed',
    );

    // The next workout opens on Bench Press, whose last weight was 60 — not 50,
    // which is what the exercise that ended up in its old slot lifted.
    const second = await service.startWorkout(userId, 'chest');
    expect(second.exerciseName).toBe('Bench Press');
    expect(second.plannedWeight).toBe(60);
  });
});

describeDb('WorkoutService — migrating a position-keyed database', () => {
  let db: DatabaseService;
  let service: WorkoutService;
  let sessionId: number;
  let userId: number;

  beforeAll(async () => {
    await createDatabase('gymhelper_test_legacy');
    db = connect('gymhelper_test_legacy');
    await createDependencies(db);
    await createDay(db, 'chest', [
      'Bench Press',
      'Chest Press Machine',
      'Incline Press',
    ]);

    // The schema exactly as it stood before exercise identity existed.
    await db.query(`
      CREATE TABLE workout_sessions (
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
    await db.query(`
      CREATE TABLE workout_session_exercises (
        session_id  INTEGER NOT NULL REFERENCES workout_sessions(id) ON DELETE CASCADE,
        position    INTEGER NOT NULL,
        exercise_id INTEGER REFERENCES exercises(id) ON DELETE SET NULL,
        name        TEXT NOT NULL,
        deferred_at TIMESTAMPTZ,
        PRIMARY KEY (session_id, position)
      )
    `);
    await db.query(`
      CREATE TABLE workout_sets (
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
    await db.query(
      'CREATE INDEX workout_sets_session_id_idx ON workout_sets (session_id)',
    );
    await db.query(`
      CREATE TABLE workout_set_drafts (
        session_id     INTEGER NOT NULL REFERENCES workout_sessions(id) ON DELETE CASCADE,
        exercise_index INTEGER NOT NULL,
        set_number     INTEGER NOT NULL,
        weight         NUMERIC(6, 2) CHECK (weight >= 0 AND weight <= 1000),
        reps           INTEGER CHECK (reps BETWEEN 1 AND 100),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (session_id, exercise_index, set_number)
      )
    `);
    await db.query(`
      CREATE TABLE workout_events (
        id             SERIAL PRIMARY KEY,
        session_id     INTEGER NOT NULL REFERENCES workout_sessions(id) ON DELETE CASCADE,
        kind           TEXT NOT NULL,
        exercise_index INTEGER,
        set_number     INTEGER,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    userId = await createUser(db, 'legacy-lifter');
    const session = await db.query<{ id: number }>(
      `INSERT INTO workout_sessions
         (user_id, training_day_id, exercise_index, set_number, planned_reps, rest_seconds, sets_per_exercise)
       VALUES ($1, 1, 1, 1, 12, 90, 4) RETURNING id`,
      [userId],
    );
    sessionId = session.rows[0].id;

    // A workout in which Chest Press Machine was already deferred: the queue now
    // reads Bench, Incline, Chest — so position 1 no longer means what it meant
    // when the Bench Press sets were logged against position 0.
    const queue = ['Bench Press', 'Incline Press', 'Chest Press Machine'];
    for (const [position, name] of queue.entries()) {
      await db.query(
        `INSERT INTO workout_session_exercises (session_id, position, exercise_id, name)
         VALUES ($1, $2, NULL, $3)`,
        [sessionId, position, name],
      );
    }
    await db.query(
      `UPDATE workout_session_exercises SET deferred_at = now()
        WHERE session_id = $1 AND position = 2`,
      [sessionId],
    );

    // Four completed Bench Press sets, recorded against position 0.
    for (let set = 1; set <= 4; set++) {
      await db.query(
        `INSERT INTO workout_sets
           (session_id, exercise_index, set_number, target_reps, reps, weight)
         VALUES ($1, 0, $2, 12, 10, 60)`,
        [sessionId, set],
      );
    }
    // An in-flight draft against the current exercise, position 1 (Incline).
    await db.query(
      `INSERT INTO workout_set_drafts (session_id, exercise_index, set_number, weight, reps)
       VALUES ($1, 1, 1, 42.5, 9)`,
      [sessionId],
    );
    await db.query(
      `INSERT INTO workout_events (session_id, kind, exercise_index, set_number)
       VALUES ($1, 'set_completed', 0, 1)`,
      [sessionId],
    );

    const trainingConfig = new TrainingConfigService(db);
    await trainingConfig.onModuleInit();
    service = new WorkoutService(db, trainingConfig);

    // The migration under test.
    await service.ensureSchema();
  });

  afterAll(async () => {
    await db.onModuleDestroy();
  });

  it('drops exercise_index and points every historical set at its exercise', async () => {
    const columns = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'workout_sets'`,
    );
    const columnNames = columns.rows.map((row) => row.column_name);
    expect(columnNames).not.toContain('exercise_index');
    expect(columnNames.sort()).toEqual([
      'actual_reps',
      'actual_weight',
      'completed_at',
      'created_at',
      'exercise_id',
      'id',
      'planned_reps',
      'planned_weight',
      'rest_duration',
      'set_number',
      'started_at',
      'workout_session_id',
    ]);

    // The four sets were logged against position 0 and still belong to the lift
    // that occupies it — Bench Press — not to whatever a later defer moved there.
    await expect(setsByExerciseName(db, sessionId)).resolves.toEqual({
      'Bench Press': 4,
    });
  });

  it('preserves the values on migrated sets and dates them honestly', async () => {
    const rows = await db.query<{
      planned_reps: number;
      actual_reps: number;
      actual_weight: number;
      planned_weight: number | null;
      started_at: Date | null;
      rest_duration: number | null;
      same_created: boolean;
    }>(
      `SELECT planned_reps, actual_reps, actual_weight::float8 AS actual_weight,
              planned_weight, started_at, rest_duration,
              created_at = completed_at AS same_created
         FROM workout_sets WHERE workout_session_id = $1 ORDER BY set_number`,
      [sessionId],
    );
    expect(rows.rows).toHaveLength(4);
    for (const row of rows.rows) {
      expect(row.planned_reps).toBe(12);
      expect(row.actual_reps).toBe(10);
      expect(row.actual_weight).toBe(60);
      // Never recorded before the migration; not invented by it.
      expect(row.planned_weight).toBeNull();
      expect(row.started_at).toBeNull();
      expect(row.rest_duration).toBeNull();
      // created_at is the moment the set was completed, not the migration's.
      expect(row.same_created).toBe(true);
    }
  });

  it('re-keys in-flight drafts onto the exercise they were typed against', async () => {
    const draft = await db.query<{ name: string; weight: number }>(
      `SELECT e.name, d.weight::float8 AS weight
         FROM workout_set_drafts d
         JOIN workout_session_exercises e ON e.id = d.exercise_id
        WHERE d.session_id = $1`,
      [sessionId],
    );
    expect(draft.rows).toEqual([{ name: 'Incline Press', weight: 42.5 }]);
  });

  it('converges on the constraint names a fresh database would have', async () => {
    // Renaming a column leaves its constraints named after the old one. If the
    // two ever drift, a later `DROP CONSTRAINT` works on fresh databases and
    // fails on migrated ones — or the reverse. Not-null constraints are left
    // out: Postgres only names them from 17 on, and nothing ever refers to them.
    const constraints = await db.query<{ conname: string }>(
      `SELECT con.conname
         FROM pg_constraint con
         JOIN pg_class rel ON rel.oid = con.conrelid
        WHERE rel.relname = 'workout_sets' AND con.contype IN ('p', 'u', 'f', 'c')
        ORDER BY con.conname`,
    );
    expect(constraints.rows.map((row) => row.conname)).toEqual([
      'workout_sets_actual_reps_check',
      'workout_sets_actual_weight_check',
      'workout_sets_exercise_id_fkey',
      'workout_sets_pkey',
      'workout_sets_planned_weight_check',
      'workout_sets_rest_duration_check',
      'workout_sets_workout_session_id_exercise_id_set_number_key',
      'workout_sets_workout_session_id_fkey',
    ]);
  });

  it('keeps event history as the positional record it always was', async () => {
    const events = await db.query<{
      exercise_position: number;
      exercise_id: number | null;
    }>(
      'SELECT exercise_position, exercise_id FROM workout_events WHERE session_id = $1',
      [sessionId],
    );
    expect(events.rows).toEqual([{ exercise_position: 0, exercise_id: null }]);
  });

  it('renames the session cursor to the position it always held', async () => {
    const session = await db.query<{ exercise_position: number }>(
      'SELECT exercise_position FROM workout_sessions WHERE id = $1',
      [sessionId],
    );
    expect(session.rows[0].exercise_position).toBe(1);
  });

  it('serves the migrated workout without breaking its history', async () => {
    const workout = await service.getWorkout(userId, sessionId);

    expect(names(workout!)).toEqual([
      'Bench Press',
      'Incline Press',
      'Chest Press Machine',
    ]);
    expect(workout?.exerciseName).toBe('Incline Press');
    expect(workout?.setsCompleted).toBe(4);
    expect(workout?.exercisesCompleted).toBe(1);
    expect(workout?.deferredCount).toBe(1);
    // The draft typed against Incline Press comes back on the resumed screen.
    expect(workout?.plannedWeight).toBe(42.5);
    expect(workout?.draftReps).toBe(9);
  });

  it('carries the migrated workout forward: a defer still cannot rewrite history', async () => {
    // Resume the migrated workout and keep lifting.
    await service.finishSet(userId, 45, 10);
    await service.startNextSet(userId);

    await expect(setsByExerciseName(db, sessionId)).resolves.toEqual({
      'Bench Press': 4,
      'Incline Press': 1,
    });
  });

  it('is idempotent — a second boot changes nothing', async () => {
    await expect(service.ensureSchema()).resolves.toBeUndefined();
    await expect(setsByExerciseName(db, sessionId)).resolves.toEqual({
      'Bench Press': 4,
      'Incline Press': 1,
    });
  });
});

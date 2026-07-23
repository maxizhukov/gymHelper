import type { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { DatabaseService } from '../database/database.service';
import { AiProgressSummaryService } from './ai-progress-summary.service';

/**
 * Regression coverage for the AI *general progress* summary.
 *
 * The bug: `windowCounts()` grouped the days-trained breakdown with
 * `GROUP BY name`. Because `training_template_days` also has a column called
 * `name`, Postgres bound that bare name to the input column `td.name` rather
 * than the SELECT alias, leaving `d.day` in the COALESCE ungrouped and raising
 *
 *     42803: column "d.day" must appear in the GROUP BY clause ...
 *
 * on every call to GET /api/stats/ai-summary. The fix groups by the full
 * COALESCE expression. These run against a real Postgres so the grouping rule
 * is exercised for real — a fake would never reproduce 42803.
 *
 * Point `TEST_DATABASE_URL` at a throwaway Postgres to run them (the user needs
 * rights to create databases):
 *
 *     TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres npm test
 *
 * Without it the suite skips rather than failing.
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

if (!TEST_DATABASE_URL) {
  console.warn(
    'Skipping AiProgressSummaryService database tests: set TEST_DATABASE_URL to run them.',
  );
}

jest.setTimeout(60_000);

/** The `week` window config, as PERIODS.week defines it. */
const WEEK_CFG = {
  days: 7,
  label: 'the last week',
  bucket: 'day' as const,
  bucketFormat: 'Mon DD',
  compare: true,
};

/** The `all_time` window config — no day bound. */
const ALL_TIME_CFG = {
  days: null,
  label: 'all time',
  bucket: 'month' as const,
  bucketFormat: 'Mon YYYY',
  compare: false,
};

function urlFor(database: string): string {
  const url = new URL(TEST_DATABASE_URL ?? '');
  url.pathname = `/${database}`;
  return url.toString();
}

function connect(database: string): DatabaseService {
  const config = { get: () => urlFor(database) } as unknown as ConfigService;
  return new DatabaseService(config);
}

async function createDatabase(name: string): Promise<void> {
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    // Identifiers cannot be parameterized; `name` is a constant from this file.
    await client.query(`DROP DATABASE IF EXISTS ${name}`);
    await client.query(`CREATE DATABASE ${name}`);
  } finally {
    await client.end();
  }
}

/** The tables `windowCounts()` reads — minimal shapes, just what the joins need. */
async function createSchema(db: DatabaseService): Promise<void> {
  await db.query(
    'CREATE TABLE users (id SERIAL PRIMARY KEY, username TEXT NOT NULL UNIQUE)',
  );
  await db.query(
    'CREATE TABLE training_days (id SERIAL PRIMARY KEY, day TEXT NOT NULL)',
  );
  // The other table with a `name` column — the whole reason the bare
  // `GROUP BY name` was ambiguous.
  await db.query(
    'CREATE TABLE training_template_days (id SERIAL PRIMARY KEY, name TEXT NOT NULL)',
  );
  await db.query(`
    CREATE TABLE workout_sessions (
      id              SERIAL PRIMARY KEY,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      training_day_id INTEGER REFERENCES training_days(id) ON DELETE CASCADE,
      template_day_id INTEGER REFERENCES training_template_days(id) ON DELETE SET NULL,
      completed_at    TIMESTAMPTZ
    )
  `);
}

async function createUser(db: DatabaseService, username: string): Promise<number> {
  const result = await db.query<{ id: number }>(
    'INSERT INTO users (username) VALUES ($1) RETURNING id',
    [username],
  );
  return result.rows[0].id;
}

async function createTrainingDay(db: DatabaseService, day: string): Promise<number> {
  const result = await db.query<{ id: number }>(
    'INSERT INTO training_days (day) VALUES ($1) RETURNING id',
    [day],
  );
  return result.rows[0].id;
}

async function createTemplateDay(db: DatabaseService, name: string): Promise<number> {
  const result = await db.query<{ id: number }>(
    'INSERT INTO training_template_days (name) VALUES ($1) RETURNING id',
    [name],
  );
  return result.rows[0].id;
}

/** A session completed `daysAgo` ago, sourced from either a training day or a template day. */
async function completeSession(
  db: DatabaseService,
  userId: number,
  source: { trainingDayId?: number; templateDayId?: number },
  daysAgo: number,
): Promise<void> {
  await db.query(
    `INSERT INTO workout_sessions (user_id, training_day_id, template_day_id, completed_at)
     VALUES ($1, $2, $3, now() - make_interval(days => $4))`,
    [userId, source.trainingDayId ?? null, source.templateDayId ?? null, daysAgo],
  );
}

describeDb('AiProgressSummaryService.windowCounts — days-trained grouping', () => {
  let db: DatabaseService;
  let service: AiProgressSummaryService;
  let pushId: number;
  let pullId: number;
  let legTemplateId: number;

  beforeAll(async () => {
    await createDatabase('gymhelper_test_progress_summary');
    db = connect('gymhelper_test_progress_summary');
    await createSchema(db);
    // No OpenAI key: the service never makes a network call in these tests.
    const noKeyConfig = { get: () => undefined } as unknown as ConfigService;
    service = new AiProgressSummaryService(db, noKeyConfig);
    await service.onModuleInit();

    pushId = await createTrainingDay(db, 'Push');
    pullId = await createTrainingDay(db, 'Pull');
    legTemplateId = await createTemplateDay(db, 'Leg Day');
  });

  afterAll(async () => {
    await db.onModuleDestroy();
  });

  /** windowCounts is private; the SQL it runs is the subject of the suite. */
  function windowCounts(
    userId: number,
    cfg: typeof WEEK_CFG | typeof ALL_TIME_CFG,
  ): Promise<{
    workouts: number;
    daysTrained: { name: string; workouts: number }[];
    spanDays: number;
  }> {
    return (
      service as unknown as {
        windowCounts: (
          userId: number,
          cfg: typeof WEEK_CFG | typeof ALL_TIME_CFG,
        ) => Promise<{
          workouts: number;
          daysTrained: { name: string; workouts: number }[];
          spanDays: number;
        }>;
      }
    ).windowCounts(userId, cfg);
  }

  it('groups the days-trained breakdown across multiple workout days without a 42803 error', async () => {
    const userId = await createUser(db, 'multi-day');
    // Two Push (legacy training day), one Pull (legacy), one Leg Day (builder
    // template) — a mix that puts both d.day and td.name in play at once, the
    // exact shape that used to raise "column d.day must appear in the GROUP BY".
    await completeSession(db, userId, { trainingDayId: pushId }, 1);
    await completeSession(db, userId, { trainingDayId: pushId }, 2);
    await completeSession(db, userId, { trainingDayId: pullId }, 3);
    await completeSession(db, userId, { templateDayId: legTemplateId }, 4);

    const counts = await windowCounts(userId, WEEK_CFG);

    expect(counts.workouts).toBe(4);
    // Ordered by workouts DESC, then name ASC — deterministic.
    expect(counts.daysTrained).toEqual([
      { name: 'Push', workouts: 2 },
      { name: 'Leg Day', workouts: 1 },
      { name: 'Pull', workouts: 1 },
    ]);
  });

  it('returns a zero total and no days for an empty date window', async () => {
    const userId = await createUser(db, 'empty-window');
    // A single workout, but 100 days ago — outside the one-week window.
    await completeSession(db, userId, { trainingDayId: pushId }, 100);

    const counts = await windowCounts(userId, WEEK_CFG);

    expect(counts.workouts).toBe(0);
    expect(counts.daysTrained).toEqual([]);
    expect(counts.spanDays).toBe(0);

    // ...and that same out-of-window workout is counted under all-time.
    const allTime = await windowCounts(userId, ALL_TIME_CFG);
    expect(allTime.workouts).toBe(1);
    expect(allTime.daysTrained).toEqual([{ name: 'Push', workouts: 1 }]);
  });
});

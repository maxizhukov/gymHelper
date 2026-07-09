import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

/** A training day without its exercises, for the list view. */
export interface TrainingDaySummary {
  slug: string;
  day: string;
  focus: string;
}

/**
 * A training day with its exercises. `exerciseGroups` preserves the order the
 * exercises are performed in: groups run top to bottom, and exercises within a
 * group do too. A group is one block of the workout (e.g. the chest presses,
 * then triceps).
 */
export interface TrainingDayDetail extends TrainingDaySummary {
  exerciseGroups: string[][];
}

/**
 * The initial plan, written to the database once on first boot. This is seed
 * data, not the source of truth — the database is. Once rows exist, this array
 * is never consulted again, so edits made in the database survive restarts.
 */
const TRAINING_DAY_SEED: TrainingDayDetail[] = [
  {
    slug: 'monday',
    day: 'Monday',
    focus: 'Грудь и трицепс',
    exerciseGroups: [
      [
        'Жим штанги лежа',
        'Жим гантелями сидя',
        'Жим в тренажере',
        'Брусья',
        'Сведения на тренажере',
      ],
      [
        'Разгибание рук с верхнего блока',
        'Французский жим с гантелей',
        'Разгибание каждой руки с верхнего блока',
      ],
      [
        'Тренажер на основной пресс',
        'Наклоны с гантелями на боковой пресс',
        'Сгибание с верхнего блока на основной пресс',
        'Тренажер на боковой пресс',
        'Поднятие ног на стойке',
      ],
    ],
  },
  {
    slug: 'wednesday',
    day: 'Wednesday',
    focus: 'Спина и бицепс',
    exerciseGroups: [],
  },
  {
    slug: 'friday',
    day: 'Friday',
    focus: 'Ноги и плечи',
    exerciseGroups: [],
  },
];

interface TrainingDayRow {
  id: number;
  slug: string;
  day: string;
  focus: string;
}

interface ExerciseRow {
  group_index: number;
  name: string;
}

@Injectable()
export class TrainingService implements OnModuleInit {
  private readonly logger = new Logger(TrainingService.name);

  constructor(private readonly db: DatabaseService) {}

  async onModuleInit(): Promise<void> {
    // Bootstrap the schema and initial plan on startup. Tolerate an unavailable
    // database so the app can still boot (mirrors AuthService's behaviour).
    try {
      await this.ensureSchema();
      await this.seedTrainingDays();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      this.logger.warn(
        `Training bootstrap skipped (is the database reachable?): ${message}`,
      );
    }
  }

  private async ensureSchema(): Promise<void> {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS training_days (
        id         SERIAL PRIMARY KEY,
        slug       TEXT NOT NULL UNIQUE,
        day        TEXT NOT NULL,
        focus      TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    // group_index orders the blocks of a workout; item_index orders the
    // exercises inside a block. Together with the day they are unique, which
    // also makes the seed inserts below idempotent.
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS exercises (
        id              SERIAL PRIMARY KEY,
        training_day_id INTEGER NOT NULL REFERENCES training_days(id) ON DELETE CASCADE,
        group_index     INTEGER NOT NULL,
        item_index      INTEGER NOT NULL,
        name            TEXT NOT NULL,
        UNIQUE (training_day_id, group_index, item_index)
      )
    `);
    await this.db.query(
      'CREATE INDEX IF NOT EXISTS exercises_training_day_id_idx ON exercises (training_day_id)',
    );
  }

  /**
   * Writes the initial plan, but only when no training days exist yet. Skipping
   * a non-empty table keeps later edits (a removed exercise, a renamed focus)
   * from being silently resurrected on the next restart.
   */
  private async seedTrainingDays(): Promise<void> {
    const existing = await this.db.query('SELECT 1 FROM training_days LIMIT 1');
    if ((existing.rowCount ?? 0) > 0) {
      return;
    }

    for (const [sortOrder, seed] of TRAINING_DAY_SEED.entries()) {
      const inserted = await this.db.query<{ id: number }>(
        `INSERT INTO training_days (slug, day, focus, sort_order)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (slug) DO NOTHING
         RETURNING id`,
        [seed.slug, seed.day, seed.focus, sortOrder],
      );

      // Another instance seeded this day first; leave its exercises alone.
      const dayId = inserted.rows[0]?.id;
      if (dayId === undefined) {
        continue;
      }

      for (const [groupIndex, exercises] of seed.exerciseGroups.entries()) {
        for (const [itemIndex, name] of exercises.entries()) {
          await this.db.query(
            `INSERT INTO exercises (training_day_id, group_index, item_index, name)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (training_day_id, group_index, item_index) DO NOTHING`,
            [dayId, groupIndex, itemIndex, name],
          );
        }
      }
    }
    this.logger.log(`Seeded ${TRAINING_DAY_SEED.length} training days.`);
  }

  /** All training days in plan order, without their exercises. */
  async listTrainingDays(): Promise<TrainingDaySummary[]> {
    const result = await this.db.query<TrainingDayRow>(
      'SELECT id, slug, day, focus FROM training_days ORDER BY sort_order',
    );
    return result.rows.map(({ slug, day, focus }) => ({ slug, day, focus }));
  }

  /**
   * One training day with its exercises, or null when the slug is unknown.
   * Exercises come back grouped and ordered as they are performed.
   */
  async findTrainingDay(slug: string): Promise<TrainingDayDetail | null> {
    const days = await this.db.query<TrainingDayRow>(
      'SELECT id, slug, day, focus FROM training_days WHERE slug = $1',
      [slug],
    );
    const trainingDay = days.rows[0];
    if (!trainingDay) {
      return null;
    }

    const exercises = await this.db.query<ExerciseRow>(
      `SELECT group_index, name
         FROM exercises
        WHERE training_day_id = $1
        ORDER BY group_index, item_index`,
      [trainingDay.id],
    );

    // Rows arrive in order, so a new group starts whenever group_index changes.
    const exerciseGroups: string[][] = [];
    let currentGroupIndex: number | null = null;
    for (const row of exercises.rows) {
      if (row.group_index !== currentGroupIndex) {
        currentGroupIndex = row.group_index;
        exerciseGroups.push([]);
      }
      exerciseGroups[exerciseGroups.length - 1].push(row.name);
    }

    return {
      slug: trainingDay.slug,
      day: trainingDay.day,
      focus: trainingDay.focus,
      exerciseGroups,
    };
  }
}

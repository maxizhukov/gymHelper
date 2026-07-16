import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { bootstrapSchema } from '../database/bootstrap-schema';
import { DatabaseService } from '../database/database.service';

/**
 * One exercise in the reference library — the catalogue of movements the user
 * can pick from, distinct from the `exercises` table the training module owns
 * (that one stores the exercises placed inside a specific training day). This is
 * the source-of-truth list, later to be connected to training plans so a
 * workout exercise can be swapped for another from here.
 */
export interface LibraryExercise {
  id: number;
  name: string;
  category: string | null;
  muscleGroup: string | null;
  equipment: string | null;
  movementPattern: string | null;
  difficulty: string | null;
  isActive: boolean;
  sortOrder: number | null;
}

/** The seed row shape — the natural key is name + category + muscleGroup. */
interface ExerciseSeed {
  name: string;
  category: string;
  muscleGroup: string;
  equipment: string;
  movementPattern: string;
  difficulty: string | null;
}

const HIP_HINGE = 'hip hinge';
const SPINAL_EXTENSION = 'spinal extension / hip extension';
const CATEGORY = 'Back and Neck';
const MUSCLE_GROUP = 'Lower Back';

/**
 * The initial catalogue, written to the database once. This is seed data, not
 * the source of truth — the database is. Seeding is idempotent: a row whose
 * natural key (name + category + muscle group) already exists is left untouched,
 * so re-deploying never duplicates or overwrites, and later edits made in the
 * database survive restarts.
 */
const EXERCISE_SEED: ExerciseSeed[] = [
  { name: 'Hyperextension', equipment: 'bodyweight / hyperextension bench', movementPattern: SPINAL_EXTENSION },
  { name: 'Barbell Good Morning', equipment: 'barbell', movementPattern: HIP_HINGE },
  { name: 'Hack Squat Machine Good Morning', equipment: 'hack squat machine', movementPattern: HIP_HINGE },
  { name: 'Resistance Band Good Morning', equipment: 'resistance band', movementPattern: HIP_HINGE },
  { name: 'Sandbag Good Morning', equipment: 'sandbag', movementPattern: HIP_HINGE },
  { name: 'Smith Machine Good Morning', equipment: 'smith machine', movementPattern: HIP_HINGE },
  { name: 'Reverse Hyperextension', equipment: 'reverse hyperextension machine', movementPattern: SPINAL_EXTENSION },
  { name: 'Reverse Hyperextension Without a Machine', equipment: 'bodyweight / bench', movementPattern: SPINAL_EXTENSION },
  { name: 'Dumbbell Deadlift', equipment: 'dumbbells', movementPattern: HIP_HINGE },
  { name: 'Barbell Deadlift', equipment: 'barbell', movementPattern: HIP_HINGE },
  { name: 'Straight-Leg Deadlift', equipment: 'barbell', movementPattern: HIP_HINGE },
  { name: 'Single-Leg Barbell Deadlift', equipment: 'barbell', movementPattern: HIP_HINGE },
  { name: 'Single-Leg Smith Machine Deadlift', equipment: 'smith machine', movementPattern: HIP_HINGE },
  { name: 'Single-Leg Dumbbell Deadlift', equipment: 'dumbbells', movementPattern: HIP_HINGE },
  { name: 'Single-Leg Resistance Band Deadlift', equipment: 'resistance band', movementPattern: HIP_HINGE },
  { name: 'Smith Machine Straight-Leg Deadlift', equipment: 'smith machine', movementPattern: HIP_HINGE },
  { name: 'Sumo Deadlift', equipment: 'barbell', movementPattern: HIP_HINGE },
  { name: 'Deficit Deadlift', equipment: 'barbell / platform', movementPattern: HIP_HINGE },
  { name: 'Resistance Band Deadlift', equipment: 'resistance band', movementPattern: HIP_HINGE },
  { name: 'Isometric Deadlift Hold', equipment: 'barbell', movementPattern: HIP_HINGE },
  { name: 'Machine Back Extension', equipment: 'back extension machine', movementPattern: SPINAL_EXTENSION },
].map((row) => ({
  ...row,
  category: CATEGORY,
  muscleGroup: MUSCLE_GROUP,
  difficulty: null,
}));

interface ExerciseRow {
  id: number;
  name: string;
  category: string | null;
  muscle_group: string | null;
  equipment: string | null;
  movement_pattern: string | null;
  difficulty: string | null;
  is_active: boolean;
  sort_order: number | null;
}

/** The columns read back for a library exercise, in a stable order. */
const EXERCISE_SELECT = `
  id,
  name,
  category,
  muscle_group,
  equipment,
  movement_pattern,
  difficulty,
  is_active,
  sort_order
`;

@Injectable()
export class ExerciseLibraryService implements OnModuleInit {
  private readonly logger = new Logger(ExerciseLibraryService.name);

  constructor(private readonly db: DatabaseService) {}

  async onModuleInit(): Promise<void> {
    await bootstrapSchema(this.logger, 'Exercise library', async () => {
      await this.ensureSchema();
      await this.seedExercises();
    });
  }

  private async ensureSchema(): Promise<void> {
    // sort_order is a hint for future manual ordering; the API sorts by
    // category/muscle group/name so an unset sort_order never hides a row.
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS exercise_library (
        id               SERIAL PRIMARY KEY,
        name             TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
        category         TEXT,
        muscle_group     TEXT,
        equipment        TEXT,
        movement_pattern TEXT,
        difficulty       TEXT,
        is_active        BOOLEAN NOT NULL DEFAULT true,
        sort_order       INTEGER,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // The natural key is the normalized (case-insensitive, whitespace-trimmed)
    // name + category + muscle group. A unique index over that makes the seed
    // upsert idempotent and stops two callers creating the same exercise twice.
    // COALESCE keeps a null category/muscle group from being treated as always
    // distinct, so those rows collide as expected.
    await this.db.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS exercise_library_natural_key_idx
        ON exercise_library (
          lower(btrim(name)),
          lower(btrim(coalesce(category, ''))),
          lower(btrim(coalesce(muscle_group, '')))
        )
    `);
  }

  /**
   * Writes the initial catalogue. `ON CONFLICT DO NOTHING` against the natural
   * key index means an exercise that already exists is skipped, never
   * duplicated and never overwritten — so a row edited in the database keeps its
   * edits, and running the deploy any number of times leaves the table stable.
   */
  private async seedExercises(): Promise<void> {
    let inserted = 0;
    for (const [index, seed] of EXERCISE_SEED.entries()) {
      const result = await this.db.query(
        `INSERT INTO exercise_library
           (name, category, muscle_group, equipment, movement_pattern, difficulty, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT DO NOTHING`,
        [
          seed.name,
          seed.category,
          seed.muscleGroup,
          seed.equipment,
          seed.movementPattern,
          seed.difficulty,
          index,
        ],
      );
      inserted += result.rowCount ?? 0;
    }
    if (inserted > 0) {
      this.logger.log(`Seeded ${inserted} library exercise(s).`);
    }
  }

  /**
   * The active library, optionally narrowed to a category and/or muscle group.
   * Sorted by category, then muscle group, then name alphabetically — the order
   * the frontend renders directly.
   */
  async list(
    category?: string,
    muscleGroup?: string,
  ): Promise<LibraryExercise[]> {
    const conditions = ['is_active = true'];
    const params: unknown[] = [];
    if (category) {
      params.push(category);
      conditions.push(`category = $${params.length}`);
    }
    if (muscleGroup) {
      params.push(muscleGroup);
      conditions.push(`muscle_group = $${params.length}`);
    }
    const result = await this.db.query<ExerciseRow>(
      `SELECT ${EXERCISE_SELECT}
         FROM exercise_library
        WHERE ${conditions.join(' AND ')}
        ORDER BY category NULLS LAST, muscle_group NULLS LAST, name`,
      params,
    );
    return result.rows.map((row) => this.mapExercise(row));
  }

  /** One exercise by id, or null when it does not exist. */
  async findOne(id: number): Promise<LibraryExercise | null> {
    const result = await this.db.query<ExerciseRow>(
      `SELECT ${EXERCISE_SELECT} FROM exercise_library WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? this.mapExercise(row) : null;
  }

  private mapExercise(row: ExerciseRow): LibraryExercise {
    return {
      id: Number(row.id),
      name: row.name,
      category: row.category,
      muscleGroup: row.muscle_group,
      equipment: row.equipment,
      movementPattern: row.movement_pattern,
      difficulty: row.difficulty,
      isActive: row.is_active,
      sortOrder: row.sort_order === null ? null : Number(row.sort_order),
    };
  }
}

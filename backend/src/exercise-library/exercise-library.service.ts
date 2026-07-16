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
const VERTICAL_PULL = 'vertical pull';
const HORIZONTAL_PULL = 'horizontal pull';
const ISOMETRIC_HORIZONTAL_PULL = 'isometric horizontal pull';
const LAT_ISOLATION = 'shoulder extension / lat isolation';
const SCAPULAR_ELEVATION = 'scapular elevation';
const CATEGORY = 'Back and Neck';
const MUSCLE_GROUP_LOWER_BACK = 'Lower Back';
const MUSCLE_GROUP_LATS = 'Lats';
const MUSCLE_GROUP_TRAPEZIUS = 'Trapezius';

/** Attaches the shared category, muscle group, and null difficulty to a group. */
function withGroup(
  muscleGroup: string,
  rows: Pick<ExerciseSeed, 'name' | 'equipment' | 'movementPattern'>[],
): ExerciseSeed[] {
  return rows.map((row) => ({
    ...row,
    category: CATEGORY,
    muscleGroup,
    difficulty: null,
  }));
}

/**
 * The initial catalogue, written to the database once. This is seed data, not
 * the source of truth — the database is. Seeding is idempotent: a row whose
 * natural key (name + category + muscle group) already exists is left untouched,
 * so re-deploying never duplicates or overwrites, and later edits made in the
 * database survive restarts.
 */
const LOWER_BACK_SEED = withGroup(MUSCLE_GROUP_LOWER_BACK, [
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
]);

const LATS_SEED = withGroup(MUSCLE_GROUP_LATS, [
  { name: 'Side Pull-Ups Using a Sheet', equipment: 'sheet / bodyweight', movementPattern: VERTICAL_PULL },
  { name: 'Side TRX Pull-Ups', equipment: 'TRX / suspension trainer', movementPattern: VERTICAL_PULL },
  { name: 'Wide-Grip Pull-Ups to the Chest', equipment: 'bodyweight / pull-up bar', movementPattern: VERTICAL_PULL },
  { name: 'Wide-Grip Pull-Ups in a Gravitron Machine', equipment: 'assisted pull-up machine / gravitron', movementPattern: VERTICAL_PULL },
  { name: 'Wide-Grip Behind-the-Neck Pull-Ups', equipment: 'bodyweight / pull-up bar', movementPattern: VERTICAL_PULL },
  { name: 'Strap-Assisted Pull-Ups', equipment: 'straps / pull-up bar', movementPattern: VERTICAL_PULL },
  { name: 'Assisted Pull-Ups on Parallel Bars', equipment: 'parallel bars', movementPattern: VERTICAL_PULL },
  { name: 'Vertical TRX Pull-Ups', equipment: 'TRX / suspension trainer', movementPattern: VERTICAL_PULL },
  { name: 'Floor Pull-Ups', equipment: 'bodyweight / pull-up bar', movementPattern: VERTICAL_PULL },
  { name: 'Parallel-Bar Pull-Ups', equipment: 'parallel bars', movementPattern: VERTICAL_PULL },
  { name: 'Close-Grip Pull-Ups', equipment: 'bodyweight / pull-up bar', movementPattern: VERTICAL_PULL },
  { name: 'Smith Machine Inverted Rows', equipment: 'smith machine', movementPattern: HORIZONTAL_PULL },
  { name: 'Reverse-Grip Pull-Ups', equipment: 'bodyweight / pull-up bar', movementPattern: VERTICAL_PULL },
  { name: 'Reverse-Grip Pull-Ups in a Gravitron Machine', equipment: 'assisted pull-up machine / gravitron', movementPattern: VERTICAL_PULL },
  { name: 'Pull-Ups Using a Sheet', equipment: 'sheet / bodyweight', movementPattern: VERTICAL_PULL },
  { name: 'Plate-Loaded Row Machine', equipment: 'plate-loaded row machine', movementPattern: HORIZONTAL_PULL },
  { name: 'Behind-the-Neck Lat Pulldown', equipment: 'cable machine / lat pulldown machine', movementPattern: VERTICAL_PULL },
  { name: 'Seated Cable Row', equipment: 'cable machine', movementPattern: HORIZONTAL_PULL },
  { name: 'Bent-Over Dumbbell Row', equipment: 'dumbbell', movementPattern: HORIZONTAL_PULL },
  { name: 'Bent-Over Barbell Row', equipment: 'barbell', movementPattern: HORIZONTAL_PULL },
  { name: 'Smith Machine Bent-Over Barbell Row', equipment: 'smith machine', movementPattern: HORIZONTAL_PULL },
  { name: 'Wide-Grip Lat Pulldown to the Chest', equipment: 'cable machine / lat pulldown machine', movementPattern: VERTICAL_PULL },
  { name: 'Reverse-Grip Lat Pulldown to the Chest', equipment: 'cable machine / lat pulldown machine', movementPattern: VERTICAL_PULL },
  { name: 'Close-Grip Lat Pulldown', equipment: 'cable machine / lat pulldown machine', movementPattern: VERTICAL_PULL },
  { name: 'One-Arm Dumbbell Row', equipment: 'dumbbell', movementPattern: HORIZONTAL_PULL },
  { name: 'One-Arm Smith Machine Row', equipment: 'smith machine', movementPattern: HORIZONTAL_PULL },
  { name: 'Bent-Over Cable Row', equipment: 'cable machine', movementPattern: HORIZONTAL_PULL },
  { name: 'Bent-Over T-Bar Row', equipment: 'T-bar row', movementPattern: HORIZONTAL_PULL },
  { name: 'Chest-Supported T-Bar Row', equipment: 'T-bar row', movementPattern: HORIZONTAL_PULL },
  { name: 'Vertical Lever Row Machine', equipment: 'lever row machine', movementPattern: HORIZONTAL_PULL },
  { name: 'Lying Dumbbell Row', equipment: 'dumbbell', movementPattern: HORIZONTAL_PULL },
  { name: 'Bent-Over Low Cable Row', equipment: 'cable machine', movementPattern: HORIZONTAL_PULL },
  { name: 'Lying Low Cable Row', equipment: 'cable machine', movementPattern: HORIZONTAL_PULL },
  { name: 'Bent-Over Resistance Band Row', equipment: 'resistance band', movementPattern: HORIZONTAL_PULL },
  { name: 'One-Arm Bent-Over Resistance Band Row', equipment: 'resistance band', movementPattern: HORIZONTAL_PULL },
  { name: 'Bent-Over Low Resistance Band Row', equipment: 'resistance band', movementPattern: HORIZONTAL_PULL },
  { name: 'Seated Resistance Band Row', equipment: 'resistance band', movementPattern: HORIZONTAL_PULL },
  { name: 'Standing Resistance Band Row', equipment: 'resistance band', movementPattern: HORIZONTAL_PULL },
  { name: 'Bent-Over Sandbag Row', equipment: 'sandbag', movementPattern: HORIZONTAL_PULL },
  { name: 'Seated Towel Row', equipment: 'towel / bodyweight', movementPattern: HORIZONTAL_PULL },
  { name: 'Static Seated Row Hold', equipment: 'cable machine', movementPattern: ISOMETRIC_HORIZONTAL_PULL },
  { name: 'TRX Pullover', equipment: 'TRX / suspension trainer', movementPattern: LAT_ISOLATION },
  { name: 'Sheet Pullover', equipment: 'sheet / bodyweight', movementPattern: LAT_ISOLATION },
  { name: 'Kneeling Cable Pullover', equipment: 'cable machine', movementPattern: LAT_ISOLATION },
  { name: 'Lying Dumbbell Pullover', equipment: 'dumbbell', movementPattern: LAT_ISOLATION },
  { name: 'Lying Barbell Pullover', equipment: 'barbell', movementPattern: LAT_ISOLATION },
  { name: 'Lying Resistance Band Pullover', equipment: 'resistance band', movementPattern: LAT_ISOLATION },
  { name: 'Straight-Arm Lat Pulldown', equipment: 'cable machine', movementPattern: LAT_ISOLATION },
]);

const TRAPEZIUS_SEED = withGroup(MUSCLE_GROUP_TRAPEZIUS, [
  { name: 'Standing Dumbbell Shrugs', equipment: 'dumbbells', movementPattern: SCAPULAR_ELEVATION },
  { name: 'Standing Barbell Shrugs', equipment: 'barbell', movementPattern: SCAPULAR_ELEVATION },
  { name: 'Machine Shrugs', equipment: 'shrug machine', movementPattern: SCAPULAR_ELEVATION },
  { name: 'Standing Smith Machine Shrugs', equipment: 'smith machine', movementPattern: SCAPULAR_ELEVATION },
  { name: 'Resistance Band Shrugs', equipment: 'resistance band', movementPattern: SCAPULAR_ELEVATION },
]);

const EXERCISE_SEED: ExerciseSeed[] = [
  ...LOWER_BACK_SEED,
  ...LATS_SEED,
  ...TRAPEZIUS_SEED,
];

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

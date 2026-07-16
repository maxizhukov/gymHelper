import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { bootstrapSchema } from '../database/bootstrap-schema';
import { DatabaseService } from '../database/database.service';

/**
 * The Training Builder: the user's own repeatable training templates, the days
 * inside them, and the exercises placed on each day. The database is the single
 * source of truth — nothing here is held in memory between requests.
 *
 * Every exercise on a day points at a row in `exercise_library` by its id, never
 * by a copied name. That reference is what lets exercise history follow the
 * movement across time: a day exercise can be removed and added back, workouts
 * come and go, and the sets logged against that library id still resolve to the
 * same lift.
 *
 * Removal is a soft delete (`is_active = false`), not a row deletion, for two
 * reasons. First, a template edit must never reach into workout history — the
 * sets already logged live in `workout_*`, keyed by `exercise_library_id`, and
 * stay whatever the template does. Second, an exercise pulled off a day and put
 * back should return to the same movement, so its past results still show;
 * reactivating the same row keeps that identity rather than minting a new one.
 *
 * New selections must come from an *active* library row. Old, deactivated
 * library rows are never offered for new days and are never deleted, because
 * historical workouts still reference them.
 */

/** A template in the list view, without its days. */
export interface TemplateSummary {
  id: number;
  name: string;
}

/** One exercise placed on a day, resolved against the library for display. */
export interface TemplateDayExercise {
  /** The row id in `training_template_day_exercises`. */
  id: number;
  exerciseLibraryId: number;
  name: string;
  category: string | null;
  muscleGroup: string | null;
  position: number;
}

/** A day with its active exercises, in order. */
export interface TemplateDay {
  id: number;
  name: string;
  exercises: TemplateDayExercise[];
}

/** A template with its days and their exercises — the builder's detail view. */
export interface TemplateDetail extends TemplateSummary {
  days: TemplateDay[];
}

const NAME_MAX = 120;

interface TemplateRow {
  id: number;
  name: string;
}

interface DayRow {
  id: number;
  name: string;
  sort_order: number;
}

interface DayExerciseRow {
  id: number;
  day_id: number;
  exercise_library_id: number;
  name: string;
  category: string | null;
  muscle_group: string | null;
  position: number;
}

@Injectable()
export class TrainingBuilderService implements OnModuleInit {
  private readonly logger = new Logger(TrainingBuilderService.name);

  constructor(private readonly db: DatabaseService) {}

  async onModuleInit(): Promise<void> {
    await bootstrapSchema(this.logger, 'Training builder', () =>
      this.ensureSchema(),
    );
  }

  private async ensureSchema(): Promise<void> {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS training_templates (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name       TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS training_template_days (
        id          SERIAL PRIMARY KEY,
        template_id INTEGER NOT NULL REFERENCES training_templates(id) ON DELETE CASCADE,
        name        TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
        sort_order  INTEGER NOT NULL DEFAULT 0,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // exercise_library_id has no ON DELETE action on purpose: a library row that
    // any day references (active or not) must not be deletable, which enforces
    // "never delete inactive old exercise_library rows" at the database level.
    // is_active is the soft-remove flag; a removed exercise keeps its row so its
    // history stays intact and it can be added back to the same movement.
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS training_template_day_exercises (
        id                  SERIAL PRIMARY KEY,
        day_id              INTEGER NOT NULL REFERENCES training_template_days(id) ON DELETE CASCADE,
        exercise_library_id INTEGER NOT NULL REFERENCES exercise_library(id),
        position            INTEGER NOT NULL,
        is_active           BOOLEAN NOT NULL DEFAULT true,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(
      'CREATE INDEX IF NOT EXISTS training_template_days_template_id_idx ON training_template_days (template_id)',
    );
    await this.db.query(
      'CREATE INDEX IF NOT EXISTS training_template_day_exercises_day_id_idx ON training_template_day_exercises (day_id)',
    );
    // At most one row per (day, library exercise), so adding an exercise back
    // reuses its row rather than piling up duplicates.
    await this.db.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS training_template_day_exercises_day_library_idx
        ON training_template_day_exercises (day_id, exercise_library_id)
    `);
  }

  /** The user's templates, newest sort first. */
  async listTemplates(userId: number): Promise<TemplateSummary[]> {
    const result = await this.db.query<TemplateRow>(
      `SELECT id, name FROM training_templates
        WHERE user_id = $1
        ORDER BY sort_order, id`,
      [userId],
    );
    return result.rows.map((row) => ({ id: Number(row.id), name: row.name }));
  }

  /** Creates a template for the user and returns it. */
  async createTemplate(userId: number, name: string): Promise<TemplateSummary> {
    const trimmed = this.requireName(name);
    const result = await this.db.query<TemplateRow>(
      `INSERT INTO training_templates (user_id, name, sort_order)
       VALUES ($1, $2, COALESCE(
         (SELECT max(sort_order) + 1 FROM training_templates WHERE user_id = $1), 0))
       RETURNING id, name`,
      [userId, trimmed],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('Could not create the template.');
    }
    return { id: Number(row.id), name: row.name };
  }

  /** Renames one of the user's templates. 404 when it is not theirs. */
  async renameTemplate(
    userId: number,
    templateId: number,
    name: string,
  ): Promise<TemplateSummary> {
    const trimmed = this.requireName(name);
    const result = await this.db.query<TemplateRow>(
      `UPDATE training_templates
          SET name = $3, updated_at = now()
        WHERE id = $2 AND user_id = $1
      RETURNING id, name`,
      [userId, templateId, trimmed],
    );
    const row = result.rows[0];
    if (!row) {
      throw new NotFoundException('Template not found.');
    }
    return { id: Number(row.id), name: row.name };
  }

  /**
   * Deletes a template and its days/exercises. Workout history is untouched:
   * `workout_sessions.template_day_id` is ON DELETE SET NULL, and the sets keep
   * their snapshotted names and `exercise_library_id`.
   */
  async deleteTemplate(userId: number, templateId: number): Promise<void> {
    const result = await this.db.query(
      'DELETE FROM training_templates WHERE id = $1 AND user_id = $2',
      [templateId, userId],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new NotFoundException('Template not found.');
    }
  }

  /** One template with its days and active exercises. 404 when not the user's. */
  async getTemplate(
    userId: number,
    templateId: number,
  ): Promise<TemplateDetail> {
    const templateResult = await this.db.query<TemplateRow>(
      'SELECT id, name FROM training_templates WHERE id = $1 AND user_id = $2',
      [templateId, userId],
    );
    const template = templateResult.rows[0];
    if (!template) {
      throw new NotFoundException('Template not found.');
    }

    const daysResult = await this.db.query<DayRow>(
      `SELECT id, name, sort_order
         FROM training_template_days
        WHERE template_id = $1
        ORDER BY sort_order, id`,
      [templateId],
    );

    const exercisesResult = await this.db.query<DayExerciseRow>(
      `SELECT tde.id, tde.day_id, tde.exercise_library_id, tde.position,
              el.name, el.category, el.muscle_group
         FROM training_template_day_exercises tde
         JOIN training_template_days d ON d.id = tde.day_id
         JOIN exercise_library el ON el.id = tde.exercise_library_id
        WHERE d.template_id = $1 AND tde.is_active = true
        ORDER BY tde.day_id, tde.position, tde.id`,
      [templateId],
    );

    const byDay = new Map<number, TemplateDayExercise[]>();
    for (const row of exercisesResult.rows) {
      const list = byDay.get(row.day_id) ?? [];
      list.push({
        id: Number(row.id),
        exerciseLibraryId: Number(row.exercise_library_id),
        name: row.name,
        category: row.category,
        muscleGroup: row.muscle_group,
        position: Number(row.position),
      });
      byDay.set(row.day_id, list);
    }

    return {
      id: Number(template.id),
      name: template.name,
      days: daysResult.rows.map((day) => ({
        id: Number(day.id),
        name: day.name,
        exercises: byDay.get(Number(day.id)) ?? [],
      })),
    };
  }

  /** Adds a day to one of the user's templates. */
  async createDay(
    userId: number,
    templateId: number,
    name: string,
  ): Promise<TemplateDay> {
    const trimmed = this.requireName(name);
    await this.requireOwnedTemplate(userId, templateId);
    const result = await this.db.query<DayRow>(
      `INSERT INTO training_template_days (template_id, name, sort_order)
       VALUES ($1, $2, COALESCE(
         (SELECT max(sort_order) + 1 FROM training_template_days WHERE template_id = $1), 0))
       RETURNING id, name, sort_order`,
      [templateId, trimmed],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('Could not create the day.');
    }
    return { id: Number(row.id), name: row.name, exercises: [] };
  }

  /** Renames a day the user owns. */
  async renameDay(
    userId: number,
    dayId: number,
    name: string,
  ): Promise<void> {
    const trimmed = this.requireName(name);
    const result = await this.db.query(
      `UPDATE training_template_days d
          SET name = $3
         FROM training_templates t
        WHERE d.id = $2 AND d.template_id = t.id AND t.user_id = $1`,
      [userId, dayId, trimmed],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new NotFoundException('Training day not found.');
    }
  }

  /** Deletes a day the user owns. Workout history is untouched (SET NULL). */
  async deleteDay(userId: number, dayId: number): Promise<void> {
    const result = await this.db.query(
      `DELETE FROM training_template_days d
         USING training_templates t
        WHERE d.id = $2 AND d.template_id = t.id AND t.user_id = $1`,
      [userId, dayId],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new NotFoundException('Training day not found.');
    }
  }

  /**
   * Adds a library exercise to the end of a day. The library row must be active
   * — deactivated movements are history, not new choices. If the exercise was on
   * this day before and removed, its row is reactivated and moved to the end,
   * which is what keeps its accumulated history attached.
   */
  async addExercise(
    userId: number,
    dayId: number,
    exerciseLibraryId: number,
  ): Promise<TemplateDayExercise> {
    await this.requireOwnedDay(userId, dayId);

    const libResult = await this.db.query<{
      id: number;
      name: string;
      category: string | null;
      muscle_group: string | null;
      is_active: boolean;
    }>(
      'SELECT id, name, category, muscle_group, is_active FROM exercise_library WHERE id = $1',
      [exerciseLibraryId],
    );
    const lib = libResult.rows[0];
    if (!lib) {
      throw new NotFoundException('Exercise not found in the library.');
    }
    if (!lib.is_active) {
      throw new BadRequestException(
        'That exercise is no longer available for new selections.',
      );
    }

    return this.db.transaction(async (client) => {
      const nextPosition = await client.query<{ position: number }>(
        `SELECT COALESCE(max(position) + 1, 0) AS position
           FROM training_template_day_exercises WHERE day_id = $1`,
        [dayId],
      );
      const position = Number(nextPosition.rows[0]?.position ?? 0);

      // Reuse the existing row when the exercise was here before: reactivate it
      // and send it to the end. A fresh row otherwise. The unique (day, library)
      // index guarantees at most one row to reuse.
      const upserted = await client.query<{
        id: number;
        is_active: boolean;
      }>(
        `INSERT INTO training_template_day_exercises
           (day_id, exercise_library_id, position, is_active)
         VALUES ($1, $2, $3, true)
         ON CONFLICT (day_id, exercise_library_id) DO UPDATE
           SET is_active = true,
               position = CASE
                 WHEN training_template_day_exercises.is_active THEN training_template_day_exercises.position
                 ELSE EXCLUDED.position
               END
         RETURNING id, is_active`,
        [dayId, exerciseLibraryId, position],
      );
      const row = upserted.rows[0];
      if (!row) {
        throw new Error('Could not add the exercise.');
      }

      const resolved = await client.query<DayExerciseRow>(
        `SELECT tde.id, tde.day_id, tde.exercise_library_id, tde.position,
                el.name, el.category, el.muscle_group
           FROM training_template_day_exercises tde
           JOIN exercise_library el ON el.id = tde.exercise_library_id
          WHERE tde.id = $1`,
        [row.id],
      );
      const detail = resolved.rows[0];
      return {
        id: Number(detail.id),
        exerciseLibraryId: Number(detail.exercise_library_id),
        name: detail.name,
        category: detail.category,
        muscleGroup: detail.muscle_group,
        position: Number(detail.position),
      };
    });
  }

  /**
   * Removes an exercise from a day. Soft delete: the row is deactivated, never
   * dropped, so the sets already logged against this movement keep showing and
   * the exercise can be added back to the same history later.
   */
  async removeExercise(
    userId: number,
    dayId: number,
    exerciseId: number,
  ): Promise<void> {
    const result = await this.db.query(
      `UPDATE training_template_day_exercises tde
          SET is_active = false
         FROM training_template_days d
         JOIN training_templates t ON t.id = d.template_id
        WHERE tde.id = $3 AND tde.day_id = $2 AND d.id = tde.day_id
          AND t.user_id = $1 AND tde.is_active = true`,
      [userId, dayId, exerciseId],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new NotFoundException('Exercise not found on this day.');
    }
  }

  /**
   * Rewrites the order of a day's active exercises. The ids must be exactly the
   * day's current active exercises — no more, no fewer — so the client cannot
   * partially reorder against a stale view and leave positions ambiguous.
   */
  async reorderExercises(
    userId: number,
    dayId: number,
    orderedIds: number[],
  ): Promise<void> {
    await this.requireOwnedDay(userId, dayId);

    await this.db.transaction(async (client) => {
      const activeResult = await client.query<{ id: number }>(
        `SELECT id FROM training_template_day_exercises
          WHERE day_id = $1 AND is_active = true`,
        [dayId],
      );
      const active = new Set(activeResult.rows.map((row) => Number(row.id)));
      if (
        active.size !== orderedIds.length ||
        !orderedIds.every((id) => active.has(id))
      ) {
        throw new BadRequestException(
          'The exercise order must list exactly this day’s current exercises.',
        );
      }

      // Two passes to dodge any transient collision: park the rows on negative
      // positions (always free — real positions are non-negative), then land
      // them on their final indices.
      for (const [index, id] of orderedIds.entries()) {
        await client.query(
          'UPDATE training_template_day_exercises SET position = $2 WHERE id = $1',
          [id, -index - 1],
        );
      }
      for (const [index, id] of orderedIds.entries()) {
        await client.query(
          'UPDATE training_template_day_exercises SET position = $2 WHERE id = $1',
          [id, index],
        );
      }
    });
  }

  private requireName(name: string): string {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (trimmed.length === 0 || trimmed.length > NAME_MAX) {
      throw new BadRequestException('A name of 1–120 characters is required.');
    }
    return trimmed;
  }

  private async requireOwnedTemplate(
    userId: number,
    templateId: number,
  ): Promise<void> {
    const result = await this.db.query(
      'SELECT 1 FROM training_templates WHERE id = $1 AND user_id = $2',
      [templateId, userId],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new NotFoundException('Template not found.');
    }
  }

  private async requireOwnedDay(
    userId: number,
    dayId: number,
  ): Promise<void> {
    const result = await this.db.query(
      `SELECT 1
         FROM training_template_days d
         JOIN training_templates t ON t.id = d.template_id
        WHERE d.id = $1 AND t.user_id = $2`,
      [dayId, userId],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new NotFoundException('Training day not found.');
    }
  }
}

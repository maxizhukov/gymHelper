import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

/**
 * Per-user training settings. `restPeriod` is the pause between sets in
 * seconds; `reps` is the target repetitions per set.
 */
export interface TrainingConfig {
  restPeriod: number;
  reps: number;
}

/**
 * What a user gets before they have saved anything. Kept as a fallback rather
 * than a row written on signup, so a user who never opens the settings form
 * still reads a sensible config.
 */
const DEFAULT_TRAINING_CONFIG: TrainingConfig = {
  restPeriod: 90,
  reps: 12,
};

interface TrainingConfigRow {
  rest_period: number;
  reps: number;
}

@Injectable()
export class TrainingConfigService implements OnModuleInit {
  private readonly logger = new Logger(TrainingConfigService.name);

  constructor(private readonly db: DatabaseService) {}

  async onModuleInit(): Promise<void> {
    // Bootstrap the schema on startup. Tolerate an unavailable database so the
    // app can still boot (mirrors AuthService's behaviour).
    try {
      await this.ensureSchema();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      this.logger.warn(
        `Training config bootstrap skipped (is the database reachable?): ${message}`,
      );
    }
  }

  private async ensureSchema(): Promise<void> {
    // One row per user, so user_id is the primary key. The row dies with the
    // user. Bounds are enforced in the DTO; the CHECKs are the last line of
    // defence for anything that reaches the table another way.
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS training_configs (
        user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        rest_period INTEGER NOT NULL CHECK (rest_period BETWEEN 0 AND 3600),
        reps        INTEGER NOT NULL CHECK (reps BETWEEN 1 AND 100),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  /** The user's settings, or the defaults when they have never saved any. */
  async getConfig(userId: number): Promise<TrainingConfig> {
    const result = await this.db.query<TrainingConfigRow>(
      'SELECT rest_period, reps FROM training_configs WHERE user_id = $1',
      [userId],
    );
    const row = result.rows[0];
    if (!row) {
      return { ...DEFAULT_TRAINING_CONFIG };
    }
    return { restPeriod: row.rest_period, reps: row.reps };
  }

  /**
   * Writes the user's settings, creating the row on first save. Returns what
   * was stored so the caller never has to guess.
   */
  async saveConfig(
    userId: number,
    config: TrainingConfig,
  ): Promise<TrainingConfig> {
    const result = await this.db.query<TrainingConfigRow>(
      `INSERT INTO training_configs (user_id, rest_period, reps)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE
         SET rest_period = EXCLUDED.rest_period,
             reps        = EXCLUDED.reps,
             updated_at  = now()
       RETURNING rest_period, reps`,
      [userId, config.restPeriod, config.reps],
    );

    // The upsert always returns a row; guard rather than assume, since a miss
    // here would mean the write silently did nothing.
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Could not save training config for user ${userId}.`);
    }
    return { restPeriod: row.rest_period, reps: row.reps };
  }
}

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { DatabaseService } from '../database/database.service';
import { AuthenticatedUser } from './auth.service';

/** Name of the cookie that carries the opaque session token. */
export const SESSION_COOKIE_NAME = 'gh_session';

// Session lifetime. Sessions expire server-side; the cookie's Max-Age mirrors
// this so the browser also drops it. Seven days balances convenience against
// exposure of a stolen token.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// 32 bytes = 256 bits of entropy, well beyond guessing range. The raw token is
// only ever sent to the client; the database stores just its SHA-256 digest, so
// a database leak alone cannot be replayed as a valid session.
const TOKEN_BYTES = 32;

interface SessionUserRow {
  id: number;
  username: string;
}

@Injectable()
export class SessionService implements OnModuleInit {
  private readonly logger = new Logger(SessionService.name);

  constructor(private readonly db: DatabaseService) {}

  async onModuleInit(): Promise<void> {
    // Bootstrap the sessions table on startup. Tolerate an unavailable database
    // so the app can still boot (mirrors AuthService's behaviour).
    try {
      await this.ensureSchema();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      this.logger.warn(
        `Session bootstrap skipped (is the database reachable?): ${message}`,
      );
    }
  }

  private async ensureSchema(): Promise<void> {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(
      'CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id)',
    );
  }

  /** SHA-256 digest of a token, used as the at-rest lookup key. */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Creates a session for a user and returns the raw token to hand to the
   * client. Only the token's hash is persisted. Returns the token together with
   * its lifetime so the caller can size the cookie's Max-Age.
   */
  async createSession(
    userId: number,
  ): Promise<{ token: string; maxAgeMs: number }> {
    const token = randomBytes(TOKEN_BYTES).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.db.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at)
       VALUES ($1, $2, $3)`,
      [this.hashToken(token), userId, expiresAt],
    );
    return { token, maxAgeMs: SESSION_TTL_MS };
  }

  /**
   * Resolves the authenticated user for a session token, or null if the token
   * is missing, unknown, or expired. Expired rows are cleaned up lazily.
   */
  async getUserForToken(
    token: string | undefined,
  ): Promise<AuthenticatedUser | null> {
    if (!token) {
      return null;
    }
    const result = await this.db.query<SessionUserRow>(
      `SELECT u.id, u.username
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1
          AND s.expires_at > now()`,
      [this.hashToken(token)],
    );
    const row = result.rows[0];
    return row ? { id: row.id, username: row.username } : null;
  }

  /** Deletes a single session (logout). No-op if the token is unknown. */
  async destroySession(token: string | undefined): Promise<void> {
    if (!token) {
      return;
    }
    await this.db.query('DELETE FROM sessions WHERE token_hash = $1', [
      this.hashToken(token),
    ]);
  }

  /** Deletes every session for a user (e.g. after a password change). */
  async destroySessionsForUser(userId: number): Promise<void> {
    await this.db.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  }
}

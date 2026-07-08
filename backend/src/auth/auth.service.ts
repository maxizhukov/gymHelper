import {
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../database/database.service';
import { hashPassword, verifyPassword } from './password.util';

const DEFAULT_ADMIN_USERNAME = 'max';

// Bootstrap-only credential. Override with the MAX_DEFAULT_PASSWORD env var and
// change it after first login. This is a placeholder default, not a real secret,
// so it is safe to keep in this public repo.
const FALLBACK_DEFAULT_PASSWORD = 'ChangeMe123!';

// Well-formed hash used when the username is unknown, so an attacker cannot
// distinguish "no such user" from "wrong password" via response timing.
const DUMMY_HASH = `scrypt$${'0'.repeat(32)}$${'0'.repeat(128)}`;

export interface AuthenticatedUser {
  id: number;
  username: string;
}

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Bootstrap the schema and default user on startup. Tolerate an unavailable
    // database so the app can still boot (e.g. before DATABASE_URL is wired up).
    try {
      await this.ensureSchema();
      await this.seedDefaultUser();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      this.logger.warn(
        `Auth bootstrap skipped (is the database reachable?): ${message}`,
      );
    }
  }

  private async ensureSchema(): Promise<void> {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            SERIAL PRIMARY KEY,
        username      TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  private async seedDefaultUser(): Promise<void> {
    const existing = await this.db.query(
      'SELECT 1 FROM users WHERE username = $1',
      [DEFAULT_ADMIN_USERNAME],
    );
    if ((existing.rowCount ?? 0) > 0) {
      return;
    }

    const password =
      this.config.get<string>('MAX_DEFAULT_PASSWORD') ??
      FALLBACK_DEFAULT_PASSWORD;
    const passwordHash = await hashPassword(password);

    await this.db.query(
      `INSERT INTO users (username, password_hash)
       VALUES ($1, $2)
       ON CONFLICT (username) DO NOTHING`,
      [DEFAULT_ADMIN_USERNAME, passwordHash],
    );
    this.logger.log(`Seeded default user "${DEFAULT_ADMIN_USERNAME}".`);
  }

  /**
   * Verifies credentials against the database. Throws UnauthorizedException on
   * any failure without revealing whether the username or the password was wrong.
   */
  async validateUser(
    username: string,
    password: string,
  ): Promise<AuthenticatedUser> {
    const result = await this.db.query<UserRow>(
      'SELECT id, username, password_hash FROM users WHERE username = $1',
      [username],
    );
    const user = result.rows[0];

    // Always run a verification (even for unknown users) to keep timing uniform.
    const ok = await verifyPassword(
      password,
      user?.password_hash ?? DUMMY_HASH,
    );
    if (!user || !ok) {
      throw new UnauthorizedException('Invalid username or password.');
    }

    return { id: user.id, username: user.username };
  }

  /**
   * Changes a user's password. The current password must be supplied and verified
   * server-side (never trust the client) before the new hash is stored. Throws
   * UnauthorizedException if the current credentials are wrong.
   */
  async changePassword(
    username: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    // Reuse the constant-time credential check; this authorizes the change.
    const user = await this.validateUser(username, currentPassword);

    const newHash = await hashPassword(newPassword);
    await this.db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [
      newHash,
      user.id,
    ]);
    this.logger.log(`Password changed for user "${user.username}".`);
  }
}

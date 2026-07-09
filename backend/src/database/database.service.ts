import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly pool: Pool;

  constructor(config: ConfigService) {
    const connectionString = config.get<string>('DATABASE_URL')?.trim();
    if (!connectionString) {
      // In production an unconfigured database is not a degraded mode, it is a
      // misconfigured deploy: refuse to start rather than serve a broken app.
      if (process.env.NODE_ENV === 'production') {
        throw new Error(
          'DATABASE_URL is not set. Refusing to start in production without a database.',
        );
      }
      this.logger.warn(
        'DATABASE_URL is not set — database queries will fail until it is configured.',
      );
    }
    this.pool = new Pool({ connectionString });
  }

  /** Runs a trivial query to confirm the database is reachable. */
  async ping(): Promise<boolean> {
    const result = await this.pool.query<{ ok: number }>('SELECT 1 AS ok');
    return result.rows[0]?.ok === 1;
  }

  /**
   * Runs a parameterized query. Always pass user-supplied values via `params`
   * ($1, $2, …) — never string-concatenate them into `text`.
   */
  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, params);
  }

  /**
   * Runs `fn` inside a transaction on a single pooled connection, committing on
   * success and rolling back on any throw. Use this whenever one user action
   * writes more than one row — a partial write would leave the database, which
   * is the source of truth for an in-progress workout, describing a state the
   * user was never in.
   *
   * The callback must issue its queries on the `client` it is handed; a query
   * sent through `query()` above takes a different connection and would not be
   * part of the transaction.
   */
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      // A failed rollback must not mask the error that caused it.
      await client.query('ROLLBACK').catch((rollbackErr: unknown) => {
        const message =
          rollbackErr instanceof Error ? rollbackErr.message : 'unknown error';
        this.logger.error(`Rollback failed: ${message}`);
      });
      throw err;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

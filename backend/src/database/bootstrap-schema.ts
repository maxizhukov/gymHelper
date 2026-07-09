import { Logger } from '@nestjs/common';

/**
 * Errors `pg` raises when it never reached a server — as opposed to reaching one
 * and being told no. Only these mean "no database is running here".
 */
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ETIMEDOUT',
  'EAI_AGAIN',
]);

function isDatabaseUnreachable(err: unknown): boolean {
  const code: unknown = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && UNREACHABLE_CODES.has(code);
}

/**
 * Runs one service's schema bootstrap and decides what a failure means.
 *
 * Production has no degraded mode: any failure fails startup. Serving requests
 * against a schema that never finished being created — or that a migration
 * aborted halfway through on purpose — corrupts data far more quietly than a
 * container that refuses to come up.
 *
 * Locally we tolerate exactly one case: no database running at all, so the app
 * still boots for frontend work. Everything else — bad credentials, a syntax
 * error in the DDL, a migration that aborted rather than guess at data — is
 * fatal in every environment.
 */
export async function bootstrapSchema(
  logger: Logger,
  name: string,
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    if (process.env.NODE_ENV === 'production' || !isDatabaseUnreachable(err)) {
      logger.error(`${name} bootstrap failed: ${message}`);
      throw err;
    }
    logger.warn(
      `${name} bootstrap skipped (no database reachable): ${message}`,
    );
  }
}

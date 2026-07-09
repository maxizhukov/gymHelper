import { BadRequestException } from '@nestjs/common';

export interface TrainingConfigDto {
  restPeriod: number;
  reps: number;
}

// Bounds keep hostile or nonsensical input out of the database. Rest is in
// seconds; an hour is already far past anything a workout needs.
const REST_PERIOD_MIN = 0;
const REST_PERIOD_MAX = 3600;
const REPS_MIN = 1;
const REPS_MAX = 100;

/** Rejects anything that is not a whole number inside [min, max]. */
function requireInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  // Number.isInteger also rejects NaN, Infinity and non-numbers.
  if (!Number.isInteger(value)) {
    throw new BadRequestException(`${field} must be an integer.`);
  }
  const int = value as number;
  if (int < min || int > max) {
    throw new BadRequestException(
      `${field} must be between ${min} and ${max}.`,
    );
  }
  return int;
}

/**
 * Validates an untrusted training-config request body. Assumes hostile input:
 * rejects anything that is not a well-formed { restPeriod, reps } pair of
 * integers.
 *
 * The owning account is never taken from the body — it comes from the
 * authenticated session — so no user id is accepted here.
 */
export function validateTrainingConfigDto(body: unknown): TrainingConfigDto {
  if (typeof body !== 'object' || body === null) {
    throw new BadRequestException('Request body must be a JSON object.');
  }

  const { restPeriod, reps } = body as Record<string, unknown>;

  return {
    restPeriod: requireInteger(
      restPeriod,
      'restPeriod',
      REST_PERIOD_MIN,
      REST_PERIOD_MAX,
    ),
    reps: requireInteger(reps, 'reps', REPS_MIN, REPS_MAX),
  };
}

import { BadRequestException } from '@nestjs/common';
import { REPS_MAX, REPS_MIN, WEIGHT_MAX, WEIGHT_MIN } from '../workout.service';

/**
 * Validation for the workout endpoints. Assumes hostile input: nothing here
 * trusts a shape, a type, or a range. The acting user is never taken from a
 * body — it comes from the session cookie — so no user id is accepted.
 */

// Slugs are lowercase identifiers we generate ('monday'). Anything else is a
// malformed request, rejected before it reaches the database.
const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

// Weights are logged to the nearest 0.25 kg in practice; two decimal places is
// what the NUMERIC(6,2) column stores, so anything finer is a rounding error
// waiting to happen rather than a precision the user asked for.
const WEIGHT_DECIMALS = 2;

export interface FinishSetDto {
  weight: number;
  reps: number;
}

export interface SaveDraftDto {
  weight: number | null;
  reps: number | null;
}

function requireObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

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
 * Rejects anything that is not a finite number inside [min, max], rounding to
 * the precision the column stores. Bodyweight exercises are logged as 0.
 */
function requireDecimal(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BadRequestException(`${field} must be a number.`);
  }
  if (value < min || value > max) {
    throw new BadRequestException(
      `${field} must be between ${min} and ${max}.`,
    );
  }
  const factor = 10 ** WEIGHT_DECIMALS;
  return Math.round(value * factor) / factor;
}

/** A training day slug from the request body. */
export function validateStartWorkoutDto(body: unknown): { slug: string } {
  const { slug } = requireObject(body);
  if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) {
    throw new BadRequestException('Invalid training day.');
  }
  return { slug };
}

/** The weight and reps actually performed. Both are required to log a set. */
export function validateFinishSetDto(body: unknown): FinishSetDto {
  const { weight, reps } = requireObject(body);
  return {
    weight: requireDecimal(weight, 'weight', WEIGHT_MIN, WEIGHT_MAX),
    reps: requireInteger(reps, 'reps', REPS_MIN, REPS_MAX),
  };
}

/**
 * A partially-typed set. Either field may be null — that is an empty input, not
 * an error, because drafts are saved as the user types. `undefined` is treated
 * as null so an omitted key clears rather than silently keeping a stale value.
 */
export function validateSaveDraftDto(body: unknown): SaveDraftDto {
  const { weight, reps } = requireObject(body);
  return {
    weight:
      weight === null || weight === undefined
        ? null
        : requireDecimal(weight, 'weight', WEIGHT_MIN, WEIGHT_MAX),
    reps:
      reps === null || reps === undefined
        ? null
        : requireInteger(reps, 'reps', REPS_MIN, REPS_MAX),
  };
}

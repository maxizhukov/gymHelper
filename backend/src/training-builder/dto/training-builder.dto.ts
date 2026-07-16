import { BadRequestException } from '@nestjs/common';

/**
 * Validation for the Training Builder endpoints. Hostile input is assumed:
 * nothing here trusts a shape, a type, or a range. The acting user always comes
 * from the session cookie, never from a body, so no user id is ever accepted.
 */

const NAME_MAX = 120;

/** The most exercises one reorder request may name — a generous ceiling. */
const MAX_ORDER = 500;

function requireObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

/** A non-empty, bounded, trimmed name. */
export function validateNameDto(body: unknown): { name: string } {
  const { name } = requireObject(body);
  if (typeof name !== 'string') {
    throw new BadRequestException('A name is required.');
  }
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > NAME_MAX) {
    throw new BadRequestException('A name of 1–120 characters is required.');
  }
  return { name: trimmed };
}

/** A positive integer id from the request body under `field`. */
function requireId(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new BadRequestException(`${field} must be a positive integer.`);
  }
  return value as number;
}

/** The library exercise to add to a day. */
export function validateAddExerciseDto(body: unknown): {
  exerciseLibraryId: number;
} {
  const { exerciseLibraryId } = requireObject(body);
  return { exerciseLibraryId: requireId(exerciseLibraryId, 'exerciseLibraryId') };
}

/** The new order of a day's exercises, as a list of their row ids. */
export function validateReorderDto(body: unknown): { orderedIds: number[] } {
  const { orderedIds } = requireObject(body);
  if (!Array.isArray(orderedIds) || orderedIds.length > MAX_ORDER) {
    throw new BadRequestException('orderedIds must be an array of ids.');
  }
  const ids = orderedIds.map((id) => requireId(id, 'orderedIds[]'));
  if (new Set(ids).size !== ids.length) {
    throw new BadRequestException('orderedIds must not contain duplicates.');
  }
  return { orderedIds: ids };
}

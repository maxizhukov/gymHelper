import { BadRequestException } from '@nestjs/common';

/**
 * Validation for the food endpoints. Assumes hostile input: the free-text meal
 * description is the only thing the client sends, and it is bounded before it is
 * ever forwarded to the model. The acting user is never taken from the body — it
 * comes from the session cookie.
 */

// A meal description is a sentence or two ("2 eggs and a slice of toast"), not a
// document. Bounding it keeps a single request from spending an unbounded number
// of tokens on the OpenAI call it drives.
const DESCRIPTION_MAX = 500;

export interface ParseFoodDto {
  description: string;
}

function requireObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

/** The free-text meal to parse. Required, non-empty and length-bounded. */
export function validateParseFoodDto(body: unknown): ParseFoodDto {
  const { description } = requireObject(body);
  if (typeof description !== 'string') {
    throw new BadRequestException('A food description is required.');
  }
  const trimmed = description.trim();
  if (trimmed.length === 0) {
    throw new BadRequestException('A food description is required.');
  }
  if (trimmed.length > DESCRIPTION_MAX) {
    throw new BadRequestException(
      `A food description must be ${DESCRIPTION_MAX} characters or fewer.`,
    );
  }
  return { description: trimmed };
}

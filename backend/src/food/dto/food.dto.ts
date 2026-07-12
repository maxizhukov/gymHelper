import { BadRequestException } from '@nestjs/common';
import type { EntryInput } from '../food.service';
import {
  CONFIDENCE_LEVELS,
  FOOD_SOURCES,
  MEAL_TYPES,
  NUTRIENT_KEYS,
  TARGET_KEYS,
  type Confidence,
  type FoodSource,
  type MealType,
  type Nutrients,
  type Targets,
} from '../food.nutrients';

/**
 * Validation for the food endpoints. All input is treated as hostile: the
 * acting user is never read from the body (it comes from the session cookie),
 * every string is length-bounded before it reaches the model or the database,
 * and every number must be finite and non-negative. Unknown nutrients are kept
 * as explicit nulls rather than coerced to 0.
 */

const DESCRIPTION_MAX = 500;
const NOTE_MAX = 300;
const NAME_MAX = 200;
const SHORT_TEXT_MAX = 120;
const NOTES_MAX = 1000;
// A data URL for a phone photo is a few MB of base64; bound it so a single
// request cannot pin memory. The controller/body limit is the outer guard.
const IMAGE_MAX = 8_000_000;
const ASSUMPTIONS_MAX = 30;

function requireObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

function boundedString(
  value: unknown,
  field: string,
  max: number,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} must be text.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) {
    throw new BadRequestException(`${field} must be ${max} characters or fewer.`);
  }
  return trimmed;
}

/** A finite, non-negative number, or null. Rejects NaN/Infinity/negatives. */
function optionalNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new BadRequestException(`${field} must be a number.`);
  }
  if (n < 0) {
    throw new BadRequestException(`${field} cannot be negative.`);
  }
  return n;
}

// ── Parse endpoints ───────────────────────────────────────────────────────────

export interface ParseTextDto {
  description: string;
}

export function validateParseTextDto(body: unknown): ParseTextDto {
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

export interface ParsePhotoDto {
  image: string;
  note: string;
}

export function validateParsePhotoDto(body: unknown): ParsePhotoDto {
  const { image, note } = requireObject(body);
  if (typeof image !== 'string' || image.trim().length === 0) {
    throw new BadRequestException('A food photo is required.');
  }
  if (image.length > IMAGE_MAX) {
    throw new BadRequestException('That photo is too large. Use a smaller image.');
  }
  // Accept a data URL (data:image/...;base64,...) which the vision API consumes
  // directly. Reject anything that is not an inline image to avoid the model
  // being pointed at an arbitrary remote URL.
  if (!/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(image.trim())) {
    throw new BadRequestException('The photo must be an inline image.');
  }
  return {
    image: image.trim(),
    note: boundedString(note, 'Note', NOTE_MAX) ?? '',
  };
}

// ── Targets ───────────────────────────────────────────────────────────────────

export function validateTargetsDto(body: unknown): Targets {
  const obj = requireObject(body);
  const targets = {} as Targets;
  for (const key of TARGET_KEYS) {
    const value = optionalNumber(obj[key], key);
    if (value === null) {
      throw new BadRequestException(`Target "${key}" is required.`);
    }
    targets[key] = value;
  }
  return targets;
}

// ── Entries ───────────────────────────────────────────────────────────────────

function optionalDate(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequestException('Date must be in YYYY-MM-DD format.');
  }
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    throw new BadRequestException('Date is not a real calendar date.');
  }
  return value;
}

function optionalTime(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new BadRequestException('Time must be in HH:MM format.');
  }
  return value;
}

function optionalMeal(value: unknown): MealType | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !MEAL_TYPES.includes(value as MealType)) {
    throw new BadRequestException('Invalid meal type.');
  }
  return value as MealType;
}

function optionalSource(value: unknown): FoodSource {
  if (value === null || value === undefined || value === '') return 'manual';
  if (typeof value !== 'string' || !FOOD_SOURCES.includes(value as FoodSource)) {
    throw new BadRequestException('Invalid source.');
  }
  return value as FoodSource;
}

function optionalConfidence(value: unknown): Confidence | null {
  if (value === null || value === undefined || value === '') return null;
  if (
    typeof value !== 'string' ||
    !CONFIDENCE_LEVELS.includes(value as Confidence)
  ) {
    throw new BadRequestException('Invalid confidence.');
  }
  return value as Confidence;
}

function validateNutrients(value: unknown): Nutrients {
  const obj =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const nutrients = {} as Nutrients;
  for (const key of NUTRIENT_KEYS) {
    nutrients[key] = optionalNumber(obj[key], key);
  }
  return nutrients;
}

function validateAssumptions(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new BadRequestException('Assumptions must be a list.');
  }
  if (value.length > ASSUMPTIONS_MAX) {
    throw new BadRequestException('Too many assumptions.');
  }
  return value
    .map((v) => boundedString(v, 'Assumption', SHORT_TEXT_MAX))
    .filter((v): v is string => v !== null);
}

/** Validates a create/edit payload into a clean EntryInput. */
export function validateEntryDto(body: unknown): EntryInput {
  const obj = requireObject(body);
  const foodName = boundedString(obj.food_name, 'Food name', NAME_MAX);
  if (!foodName) {
    throw new BadRequestException('A food name is required.');
  }
  return {
    date: optionalDate(obj.date),
    time: optionalTime(obj.time),
    mealType: optionalMeal(obj.meal_type),
    foodName,
    brand: boundedString(obj.brand, 'Brand', SHORT_TEXT_MAX),
    quantity: optionalNumber(obj.quantity, 'Quantity'),
    unit: boundedString(obj.unit, 'Unit', SHORT_TEXT_MAX),
    nutrients: validateNutrients(obj.nutrients),
    source: optionalSource(obj.source),
    confidence: optionalConfidence(obj.confidence),
    rawInput: boundedString(obj.raw_input, 'Raw input', DESCRIPTION_MAX),
    assumptions: validateAssumptions(obj.assumptions),
    notes: boundedString(obj.notes, 'Notes', NOTES_MAX),
  };
}

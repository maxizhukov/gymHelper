/**
 * The single source of truth for what the food tracker measures.
 *
 * Every nutrient the app tracks is listed here once. The database columns, the
 * insert/update statements, the model prompt and the totals are all derived
 * from these arrays, so adding a nutrient is a one-line change that stays
 * consistent everywhere instead of a column that has to be threaded by hand
 * through a dozen call sites.
 *
 * All names are fixed compile-time constants — never user input — so building
 * SQL column lists from them is safe.
 */

/**
 * The per-item nutrient columns, in display order. Each becomes a nullable
 * NUMERIC column on `food_entries`: null means "unknown", which is distinct
 * from 0 ("known to contain none") and is treated as 0 only when totalling.
 */
export const NUTRIENT_KEYS = [
  'calories_kcal',
  'protein_g',
  'fat_g',
  'carbs_g',
  'fiber_g',
  'water_l',
  'salt_g',
  'added_sugar_g',
  'saturated_fat_g',
  'omega3_epa_dha_mg',
  'vitamin_d_iu',
  'magnesium_mg',
  'calcium_mg',
  'potassium_mg',
  'iron_mg',
  'zinc_mg',
  'creatine_g',
] as const;

export type NutrientKey = (typeof NUTRIENT_KEYS)[number];

/** A full set of nutrient values for one item; unknown values are null. */
export type Nutrients = Record<NutrientKey, number | null>;

/**
 * The default daily targets, and the exact set of target columns. Some
 * nutrients are a single goal (protein), some a healthy range (fiber, water),
 * and some only an upper bound (added sugar) — that shape is encoded in the
 * key suffix (`_min` / `_max`) so the frontend can render the right kind of
 * progress without a second lookup table.
 */
export const DEFAULT_TARGETS = {
  calories_kcal: 2300,
  protein_g: 180,
  fat_g: 70,
  carbs_g: 220,
  fiber_g_min: 35,
  fiber_g_max: 40,
  water_l_min: 3,
  water_l_max: 3.5,
  salt_g_min: 4,
  salt_g_max: 5,
  added_sugar_g_max: 30,
  saturated_fat_g_max: 20,
  omega3_epa_dha_mg_min: 1000,
  omega3_epa_dha_mg_max: 2000,
  vitamin_d_iu_min: 1000,
  vitamin_d_iu_max: 2000,
  magnesium_mg_min: 400,
  magnesium_mg_max: 450,
  calcium_mg: 1000,
  potassium_mg_min: 3500,
  potassium_mg_max: 4700,
  iron_mg: 10,
  zinc_mg_min: 11,
  zinc_mg_max: 15,
  creatine_g: 5,
} as const;

export type TargetKey = keyof typeof DEFAULT_TARGETS;
export type Targets = Record<TargetKey, number>;

export const TARGET_KEYS = Object.keys(DEFAULT_TARGETS) as TargetKey[];

/** Meal buckets the UI groups entries into. */
export const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
export type MealType = (typeof MEAL_TYPES)[number];

/** How an entry's numbers were produced. */
export const FOOD_SOURCES = ['text', 'photo', 'manual'] as const;
export type FoodSource = (typeof FOOD_SOURCES)[number];

/** The model's self-reported confidence in an estimate. */
export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

import { errorMessage } from './api'

/**
 * Data access and shared metadata for the food tracker. The browser only ever
 * talks to our own backend: it posts text or a photo and gets back an editable
 * draft, and it reads and writes saved entries and targets. The OpenAI key
 * lives on the server and never reaches this code, and PostgreSQL — not the
 * browser — is the source of truth, so this module holds no persistent copy of
 * anything. The session cookie goes with every request.
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
] as const

export type NutrientKey = (typeof NUTRIENT_KEYS)[number]
export type Nutrients = Record<NutrientKey, number | null>

export const TARGET_KEYS = [
  'calories_kcal',
  'protein_g',
  'fat_g',
  'carbs_g',
  'fiber_g_min',
  'fiber_g_max',
  'water_l_min',
  'water_l_max',
  'salt_g_min',
  'salt_g_max',
  'added_sugar_g_max',
  'saturated_fat_g_max',
  'omega3_epa_dha_mg_min',
  'omega3_epa_dha_mg_max',
  'vitamin_d_iu_min',
  'vitamin_d_iu_max',
  'magnesium_mg_min',
  'magnesium_mg_max',
  'calcium_mg',
  'potassium_mg_min',
  'potassium_mg_max',
  'iron_mg',
  'zinc_mg_min',
  'zinc_mg_max',
  'creatine_g',
] as const

export type TargetKey = (typeof TARGET_KEYS)[number]
export type Targets = Record<TargetKey, number>

export const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'] as const
export type MealType = (typeof MEAL_TYPES)[number]

export type Confidence = 'high' | 'medium' | 'low'
export type FoodSource = 'text' | 'photo' | 'manual'

/**
 * How each nutrient relates to its goal, so the UI knows what "on track" means:
 * a plain `target` is a number to reach, a `range` is a healthy band, and a
 * `max` is a ceiling to stay under. `decimals` controls display precision.
 */
export type NutrientMeta = {
  key: NutrientKey
  label: string
  unit: string
  decimals: number
} & (
  | { kind: 'target'; target: TargetKey }
  | { kind: 'range'; min: TargetKey; max: TargetKey }
  | { kind: 'max'; max: TargetKey }
)

export const NUTRIENT_META: NutrientMeta[] = [
  { key: 'calories_kcal', label: 'Calories', unit: 'kcal', decimals: 0, kind: 'target', target: 'calories_kcal' },
  { key: 'protein_g', label: 'Protein', unit: 'g', decimals: 0, kind: 'target', target: 'protein_g' },
  { key: 'fat_g', label: 'Fat', unit: 'g', decimals: 0, kind: 'target', target: 'fat_g' },
  { key: 'carbs_g', label: 'Carbs', unit: 'g', decimals: 0, kind: 'target', target: 'carbs_g' },
  { key: 'fiber_g', label: 'Fiber', unit: 'g', decimals: 0, kind: 'range', min: 'fiber_g_min', max: 'fiber_g_max' },
  { key: 'water_l', label: 'Water', unit: 'L', decimals: 2, kind: 'range', min: 'water_l_min', max: 'water_l_max' },
  { key: 'salt_g', label: 'Salt', unit: 'g', decimals: 1, kind: 'range', min: 'salt_g_min', max: 'salt_g_max' },
  { key: 'added_sugar_g', label: 'Added sugar', unit: 'g', decimals: 0, kind: 'max', max: 'added_sugar_g_max' },
  { key: 'saturated_fat_g', label: 'Saturated fat', unit: 'g', decimals: 0, kind: 'max', max: 'saturated_fat_g_max' },
  { key: 'omega3_epa_dha_mg', label: 'Omega-3 (EPA+DHA)', unit: 'mg', decimals: 0, kind: 'range', min: 'omega3_epa_dha_mg_min', max: 'omega3_epa_dha_mg_max' },
  { key: 'vitamin_d_iu', label: 'Vitamin D', unit: 'IU', decimals: 0, kind: 'range', min: 'vitamin_d_iu_min', max: 'vitamin_d_iu_max' },
  { key: 'magnesium_mg', label: 'Magnesium', unit: 'mg', decimals: 0, kind: 'range', min: 'magnesium_mg_min', max: 'magnesium_mg_max' },
  { key: 'calcium_mg', label: 'Calcium', unit: 'mg', decimals: 0, kind: 'target', target: 'calcium_mg' },
  { key: 'potassium_mg', label: 'Potassium', unit: 'mg', decimals: 0, kind: 'range', min: 'potassium_mg_min', max: 'potassium_mg_max' },
  { key: 'iron_mg', label: 'Iron', unit: 'mg', decimals: 0, kind: 'target', target: 'iron_mg' },
  { key: 'zinc_mg', label: 'Zinc', unit: 'mg', decimals: 0, kind: 'range', min: 'zinc_mg_min', max: 'zinc_mg_max' },
  { key: 'creatine_g', label: 'Creatine', unit: 'g', decimals: 0, kind: 'target', target: 'creatine_g' },
]

/** The four macros shown as headline progress; the rest render as a list. */
export const MACRO_KEYS: NutrientKey[] = [
  'calories_kcal',
  'protein_g',
  'fat_g',
  'carbs_g',
]

export type DraftItem = {
  foodName: string
  brand: string | null
  quantity: number | null
  unit: string | null
  mealType: MealType | null
  nutrients: Nutrients
  confidence: Confidence | null
  assumptions: string[]
  needsUserReview: boolean
}

export type FoodEntry = {
  id: number
  date: string
  time: string | null
  mealType: MealType | null
  foodName: string
  brand: string | null
  quantity: number | null
  unit: string | null
  nutrients: Nutrients
  source: FoodSource
  confidence: Confidence | null
  rawInput: string | null
  assumptions: string[]
  notes: string | null
  createdAt: string
  updatedAt: string
}

export type DayLog = {
  date: string
  entries: FoodEntry[]
  totals: Nutrients
  targets: Targets
}

/** The payload the create/edit endpoints accept (snake_case, like the DB). */
export type EntryPayload = {
  date: string | null
  time: string | null
  meal_type: MealType | null
  food_name: string
  brand: string | null
  quantity: number | null
  unit: string | null
  nutrients: Nutrients
  source: FoodSource
  confidence: Confidence | null
  raw_input: string | null
  assumptions: string[]
  notes: string | null
}

const GENERIC_ERROR = 'Something went wrong. Please try again.'

/** An empty nutrient set — every value unknown (null). */
export function emptyNutrients(): Nutrients {
  return Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, null])) as Nutrients
}

/** Formats a nutrient value for display, or a dash when it is unknown. */
export function formatNutrient(value: number | null, decimals: number): string {
  if (value === null || Number.isNaN(value)) return '—'
  return value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) throw new Error(await errorMessage(res, GENERIC_ERROR))
  return (await res.json()) as T
}

async function sendJson<T>(
  url: string,
  method: 'POST' | 'PUT',
  body: unknown,
): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await errorMessage(res, GENERIC_ERROR))
  return (await res.json()) as T
}

export async function fetchToday(): Promise<DayLog> {
  return (await getJson<{ day: DayLog }>('/api/food/today')).day
}

export async function fetchDay(date: string): Promise<DayLog> {
  return (
    await getJson<{ day: DayLog }>(
      `/api/food/history?date=${encodeURIComponent(date)}`,
    )
  ).day
}

export async function fetchTargets(): Promise<Targets> {
  return (await getJson<{ targets: Targets }>('/api/food/targets')).targets
}

export async function saveTargets(targets: Targets): Promise<Targets> {
  return (
    await sendJson<{ targets: Targets }>('/api/food/targets', 'PUT', targets)
  ).targets
}

export async function parseFoodText(description: string): Promise<DraftItem[]> {
  return (
    await sendJson<{ items: DraftItem[] }>('/api/food/parse-text', 'POST', {
      description,
    })
  ).items
}

export async function parseFoodPhoto(
  image: string,
  note: string,
): Promise<DraftItem[]> {
  return (
    await sendJson<{ items: DraftItem[] }>('/api/food/parse-photo', 'POST', {
      image,
      note,
    })
  ).items
}

export async function createEntry(payload: EntryPayload): Promise<FoodEntry> {
  return (
    await sendJson<{ entry: FoodEntry }>('/api/food/entries', 'POST', payload)
  ).entry
}

export async function updateEntry(
  id: number,
  payload: EntryPayload,
): Promise<FoodEntry> {
  return (
    await sendJson<{ entry: FoodEntry }>(
      `/api/food/entries/${id}`,
      'PUT',
      payload,
    )
  ).entry
}

export async function deleteEntry(id: number): Promise<void> {
  const res = await fetch(`/api/food/entries/${id}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!res.ok && res.status !== 204) {
    throw new Error(await errorMessage(res, GENERIC_ERROR))
  }
}

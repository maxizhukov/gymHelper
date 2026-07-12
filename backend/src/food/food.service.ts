import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { bootstrapSchema } from '../database/bootstrap-schema';
import { DatabaseService } from '../database/database.service';
import {
  CONFIDENCE_LEVELS,
  DEFAULT_TARGETS,
  FOOD_SOURCES,
  MEAL_TYPES,
  NUTRIENT_KEYS,
  TARGET_KEYS,
  type Confidence,
  type FoodSource,
  type MealType,
  type NutrientKey,
  type Nutrients,
  type Targets,
} from './food.nutrients';

/**
 * The food tracker's data layer. PostgreSQL is the single source of truth: every
 * saved item lives in `food_entries` and every per-user goal in
 * `food_daily_targets`. The model is used only to turn text or a label photo
 * into an *editable draft* — nothing is persisted until the user confirms it
 * through the create endpoint, and the daily totals the app shows are summed
 * here from the stored rows, never trusted from the client.
 *
 * The OpenAI key is read from the backend environment and used only for the
 * server-to-server call; it is never returned to the caller or sent to the
 * browser.
 */

/** The chat-completions endpoint (vision-capable models included). */
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

/** Cheap, reliable, and vision-capable — enough for label reading and text. */
const OPENAI_MODEL = 'gpt-4o-mini';

/** Bound the wait so a hung upstream cannot hold a request open forever. */
const REQUEST_TIMEOUT_MS = 30_000;

/** One editable draft item the model produced; not yet saved. */
export interface DraftItem {
  foodName: string;
  brand: string | null;
  quantity: number | null;
  unit: string | null;
  mealType: MealType | null;
  nutrients: Nutrients;
  confidence: Confidence | null;
  assumptions: string[];
  needsUserReview: boolean;
}

/** A saved food item as it is read back from the database. */
export interface FoodEntry {
  id: number;
  date: string;
  time: string | null;
  mealType: MealType | null;
  foodName: string;
  brand: string | null;
  quantity: number | null;
  unit: string | null;
  nutrients: Nutrients;
  source: FoodSource;
  confidence: Confidence | null;
  rawInput: string | null;
  assumptions: string[];
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Everything the Today / History view renders for one date. */
export interface DayLog {
  date: string;
  entries: FoodEntry[];
  totals: Nutrients;
  targets: Targets;
}

/** The fields the caller may supply when saving or editing an entry. */
export interface EntryInput {
  date: string | null;
  time: string | null;
  mealType: MealType | null;
  foodName: string;
  brand: string | null;
  quantity: number | null;
  unit: string | null;
  nutrients: Nutrients;
  source: FoodSource;
  confidence: Confidence | null;
  rawInput: string | null;
  assumptions: string[];
  notes: string | null;
}

/** Kept for the legacy /food/parse endpoint the old frontend still calls. */
export interface ParsedMeal {
  items: {
    name: string;
    quantity: string;
    calories: number;
    proteinGrams: number;
    carbsGrams: number;
    fatGrams: number;
  }[];
  totals: {
    calories: number;
    proteinGrams: number;
    carbsGrams: number;
    fatGrams: number;
  };
}

/** The columns read back for an entry, formatting date/time as stable strings. */
const ENTRY_SELECT = `
  id,
  to_char(date, 'YYYY-MM-DD') AS date,
  to_char(time, 'HH24:MI') AS time,
  meal_type,
  food_name,
  brand,
  quantity,
  unit,
  ${NUTRIENT_KEYS.join(',\n  ')},
  source,
  confidence,
  raw_input,
  assumptions,
  notes,
  created_at,
  updated_at
`;

@Injectable()
export class FoodService implements OnModuleInit {
  private readonly logger = new Logger(FoodService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly db: DatabaseService,
  ) {}

  async onModuleInit(): Promise<void> {
    await bootstrapSchema(this.logger, 'Food', () => this.ensureSchema());
  }

  private async ensureSchema(): Promise<void> {
    // Per-item nutrient columns are nullable NUMERIC: null is "unknown" (the
    // model could not tell), which the app must keep distinct from a real 0.
    const nutrientCols = NUTRIENT_KEYS.map(
      (key) => `${key} NUMERIC CHECK (${key} IS NULL OR ${key} >= 0)`,
    ).join(',\n        ');

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS food_entries (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        date        DATE NOT NULL DEFAULT CURRENT_DATE,
        time        TIME,
        meal_type   TEXT,
        food_name   TEXT NOT NULL CHECK (length(food_name) BETWEEN 1 AND 200),
        brand       TEXT,
        quantity    NUMERIC CHECK (quantity IS NULL OR quantity >= 0),
        unit        TEXT,
        ${nutrientCols},
        source      TEXT NOT NULL DEFAULT 'manual',
        confidence  TEXT,
        raw_input   TEXT,
        assumptions JSONB NOT NULL DEFAULT '[]'::jsonb,
        notes       TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // The hot path is "all of one user's entries for one day", so index it.
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS food_entries_user_date_idx
         ON food_entries (user_id, date)`,
    );

    // One target row per user; the row dies with the user. Every column carries
    // its default so a partial write can never leave a goal unset.
    const targetCols = TARGET_KEYS.map(
      (key) =>
        `${key} NUMERIC NOT NULL DEFAULT ${DEFAULT_TARGETS[key]} CHECK (${key} >= 0)`,
    ).join(',\n        ');

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS food_daily_targets (
        user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        ${targetCols},
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  /** The log for the server's current date. */
  async getToday(userId: number): Promise<DayLog> {
    const today = await this.currentDate();
    return this.getDay(userId, today);
  }

  /** The log for a specific date (YYYY-MM-DD). */
  async getDay(userId: number, date: string): Promise<DayLog> {
    const result = await this.db.query(
      `SELECT ${ENTRY_SELECT}
         FROM food_entries
        WHERE user_id = $1 AND date = $2
        ORDER BY time NULLS LAST, created_at`,
      [userId, date],
    );
    const entries = result.rows.map((row) => this.mapEntry(row));
    return {
      date,
      entries,
      totals: this.total(entries),
      targets: await this.getTargets(userId),
    };
  }

  /** The user's targets, or the defaults when they have never saved any. */
  async getTargets(userId: number): Promise<Targets> {
    const result = await this.db.query(
      `SELECT ${TARGET_KEYS.join(', ')}
         FROM food_daily_targets WHERE user_id = $1`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) return { ...DEFAULT_TARGETS };
    const targets = {} as Targets;
    for (const key of TARGET_KEYS) {
      targets[key] = this.num(row[key]) ?? DEFAULT_TARGETS[key];
    }
    return targets;
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  /** Replaces the user's daily targets, creating the row on first save. */
  async saveTargets(userId: number, targets: Targets): Promise<Targets> {
    const assignments = TARGET_KEYS.map(
      (key, i) => `${key} = $${i + 2}`,
    ).join(', ');
    const values = [userId, ...TARGET_KEYS.map((key) => targets[key])];
    await this.db.query(
      `INSERT INTO food_daily_targets (user_id, ${TARGET_KEYS.join(', ')})
       VALUES ($1, ${TARGET_KEYS.map((_, i) => `$${i + 2}`).join(', ')})
       ON CONFLICT (user_id) DO UPDATE
         SET ${assignments}, updated_at = now()`,
      values,
    );
    return this.getTargets(userId);
  }

  /** Saves a reviewed entry for the user and returns it as stored. */
  async createEntry(userId: number, input: EntryInput): Promise<FoodEntry> {
    const cols = [
      'user_id',
      'date',
      'time',
      'meal_type',
      'food_name',
      'brand',
      'quantity',
      'unit',
      ...NUTRIENT_KEYS,
      'source',
      'confidence',
      'raw_input',
      'assumptions',
      'notes',
    ];
    const values = this.entryValues(userId, input);
    const placeholders = cols.map((col, i) =>
      col === 'assumptions' ? `$${i + 1}::jsonb` : `$${i + 1}`,
    );

    const result = await this.db.query(
      `INSERT INTO food_entries (${cols.join(', ')})
       VALUES (${placeholders.join(', ')})
       RETURNING ${ENTRY_SELECT}`,
      values,
    );
    const row = result.rows[0];
    if (!row) throw new Error('Could not save food entry.');
    return this.mapEntry(row);
  }

  /** Edits one of the user's own entries; 404 if it is not theirs. */
  async updateEntry(
    userId: number,
    id: number,
    input: EntryInput,
  ): Promise<FoodEntry> {
    const cols = [
      'date',
      'time',
      'meal_type',
      'food_name',
      'brand',
      'quantity',
      'unit',
      ...NUTRIENT_KEYS,
      'source',
      'confidence',
      'raw_input',
      'assumptions',
      'notes',
    ];
    // $1 is the id and $2 the user_id; column values follow from $3.
    const assignments = cols.map((col, i) =>
      col === 'assumptions' ? `${col} = $${i + 3}::jsonb` : `${col} = $${i + 3}`,
    );
    // entryValues starts with userId, which the UPDATE does not reassign.
    const [, ...colValues] = this.entryValues(userId, input);
    const result = await this.db.query(
      `UPDATE food_entries
          SET ${assignments.join(', ')}, updated_at = now()
        WHERE id = $1 AND user_id = $2
        RETURNING ${ENTRY_SELECT}`,
      [id, userId, ...colValues],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Food entry not found.');
    return this.mapEntry(row);
  }

  /** Deletes one of the user's own entries; 404 if it is not theirs. */
  async deleteEntry(userId: number, id: number): Promise<void> {
    const result = await this.db.query(
      'DELETE FROM food_entries WHERE id = $1 AND user_id = $2',
      [id, userId],
    );
    if (result.rowCount === 0) {
      throw new NotFoundException('Food entry not found.');
    }
  }

  // ── Model-backed drafts ─────────────────────────────────────────────────────

  /** Turns free text into editable draft items. Saves nothing. */
  async parseText(description: string): Promise<DraftItem[]> {
    const content = await this.callOpenAI([
      { role: 'system', content: this.textSystemPrompt() },
      { role: 'user', content: description },
    ]);
    return this.parseDraftItems(content);
  }

  /**
   * Reads a nutrition-label photo into editable draft items, scaled to the
   * amount actually consumed. Saves nothing.
   */
  async parsePhoto(imageDataUrl: string, note: string): Promise<DraftItem[]> {
    const userContent: unknown[] = [
      {
        type: 'text',
        text:
          note.length > 0
            ? `Amount actually consumed / package detail: ${note}`
            : 'Read the nutrition label. If the consumed amount is unclear, ' +
              'assume the whole package and set needs_user_review.',
      },
      { type: 'image_url', image_url: { url: imageDataUrl } },
    ];
    const content = await this.callOpenAI([
      { role: 'system', content: this.photoSystemPrompt() },
      { role: 'user', content: userContent },
    ]);
    return this.parseDraftItems(content);
  }

  /** Legacy shape for the old /food/parse endpoint: macros only. */
  async parse(description: string): Promise<ParsedMeal> {
    const items = await this.parseText(description);
    const mapped = items.map((item) => ({
      name: item.foodName,
      quantity: this.quantityLabel(item),
      calories: Math.round(item.nutrients.calories_kcal ?? 0),
      proteinGrams: Math.round(item.nutrients.protein_g ?? 0),
      carbsGrams: Math.round(item.nutrients.carbs_g ?? 0),
      fatGrams: Math.round(item.nutrients.fat_g ?? 0),
    }));
    return {
      items: mapped,
      totals: mapped.reduce(
        (totals, item) => ({
          calories: totals.calories + item.calories,
          proteinGrams: totals.proteinGrams + item.proteinGrams,
          carbsGrams: totals.carbsGrams + item.carbsGrams,
          fatGrams: totals.fatGrams + item.fatGrams,
        }),
        { calories: 0, proteinGrams: 0, carbsGrams: 0, fatGrams: 0 },
      ),
    };
  }

  // ── OpenAI plumbing ─────────────────────────────────────────────────────────

  private async callOpenAI(messages: unknown[]): Promise<string> {
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      throw new ServiceUnavailableException(
        'Food parsing is not configured on the server.',
      );
    }

    let res: Response;
    try {
      res = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ServiceUnavailableException(
        'Could not reach the food parsing service. Please try again.',
      );
    }

    if (!res.ok) {
      throw new ServiceUnavailableException(
        'The food parsing service returned an error. Please try again.',
      );
    }

    const payload = (await res.json().catch(() => null)) as {
      choices?: { message?: { content?: string } }[];
    } | null;
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new ServiceUnavailableException(
        'The food parsing service returned an unexpected response.',
      );
    }
    return content;
  }

  /** The nutrient key list, annotated with units, for the model prompt. */
  private nutrientSchemaLines(): string {
    const units: Record<NutrientKey, string> = {
      calories_kcal: 'kilocalories',
      protein_g: 'grams',
      fat_g: 'grams',
      carbs_g: 'grams',
      fiber_g: 'grams',
      water_l: 'litres',
      salt_g: 'grams',
      added_sugar_g: 'grams',
      saturated_fat_g: 'grams',
      omega3_epa_dha_mg: 'milligrams EPA+DHA',
      vitamin_d_iu: 'international units',
      magnesium_mg: 'milligrams',
      calcium_mg: 'milligrams',
      potassium_mg: 'milligrams',
      iron_mg: 'milligrams',
      zinc_mg: 'milligrams',
      creatine_g: 'grams',
    };
    return NUTRIENT_KEYS.map((key) => `"${key}" (${units[key]})`).join(', ');
  }

  private textSystemPrompt(): string {
    return (
      'You are a nutrition estimator. Given a free-text description of food, ' +
      'return STRICT JSON: {"items":[ ITEM, ... ]}. One ITEM per distinct food. ' +
      'Each ITEM has: "food_name" (string), "brand" (string or null), ' +
      '"quantity" (number or null), "unit" (string or null, e.g. g, ml, piece), ' +
      '"meal_type" (one of breakfast|lunch|dinner|snack or null), ' +
      'the nutrient fields ' +
      this.nutrientSchemaLines() +
      ' — each a number for the ACTUAL amount described, or null if genuinely ' +
      'unknown, "confidence" (high|medium|low), "assumptions" (array of short ' +
      'strings), and "needs_user_review" (boolean). Compute nutrients for the ' +
      'quantity described, not per 100g. Use null for micronutrients you cannot ' +
      'reasonably estimate rather than guessing. If quantity is ambiguous, note ' +
      'it in assumptions and use medium or low confidence. If no food is named, ' +
      'return {"items":[]}.'
    );
  }

  private photoSystemPrompt(): string {
    return (
      'You read nutrition-label photos. Return STRICT JSON: ' +
      '{"items":[ ITEM, ... ]}. Usually one ITEM for the product in the photo. ' +
      'Each ITEM has: "food_name" (string), "brand" (string or null), ' +
      '"quantity" (number or null = amount consumed), "unit" (string or null), ' +
      '"meal_type" (breakfast|lunch|dinner|snack or null), the nutrient fields ' +
      this.nutrientSchemaLines() +
      ', "confidence" (high|medium|low), "assumptions" (array of strings), and ' +
      '"needs_user_review" (boolean). CRITICAL: the label lists values per ' +
      'serving or per 100g/100ml. Scale them to the amount ACTUALLY consumed. ' +
      'Example: label is per 100ml and the item is a 330ml can -> multiply by ' +
      '3.3. If the label is per serving and the package holds several servings ' +
      'and the whole package was eaten, multiply by the number of servings. ' +
      'Record how you scaled in assumptions. Use null for nutrients not on the ' +
      'label. If the amount consumed is uncertain, set needs_user_review to ' +
      'true and explain in assumptions. If the image has no readable label, ' +
      'return {"items":[]}.'
    );
  }

  private parseDraftItems(content: string): DraftItem[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new ServiceUnavailableException(
        'The food parsing service returned an unexpected response.',
      );
    }
    const rawItems =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { items?: unknown }).items
        : undefined;
    if (!Array.isArray(rawItems)) return [];

    return rawItems
      .filter(
        (item): item is Record<string, unknown> =>
          typeof item === 'object' && item !== null,
      )
      .map((item) => this.mapDraftItem(item))
      .filter((item) => item.foodName.length > 0);
  }

  private mapDraftItem(item: Record<string, unknown>): DraftItem {
    const nutrients = {} as Nutrients;
    for (const key of NUTRIENT_KEYS) {
      nutrients[key] = this.num(item[key]);
    }
    return {
      foodName: this.text(item.food_name),
      brand: this.textOrNull(item.brand),
      quantity: this.num(item.quantity),
      unit: this.textOrNull(item.unit),
      mealType: this.meal(item.meal_type),
      nutrients,
      confidence: this.confidence(item.confidence),
      assumptions: this.stringList(item.assumptions),
      needsUserReview: item.needs_user_review === true,
    };
  }

  // ── Row mapping and coercion ────────────────────────────────────────────────

  private mapEntry(row: Record<string, unknown>): FoodEntry {
    const nutrients = {} as Nutrients;
    for (const key of NUTRIENT_KEYS) {
      nutrients[key] = this.num(row[key]);
    }
    return {
      id: Number(row.id),
      date: String(row.date),
      time: this.textOrNull(row.time),
      mealType: this.meal(row.meal_type),
      foodName: this.text(row.food_name),
      brand: this.textOrNull(row.brand),
      quantity: this.num(row.quantity),
      unit: this.textOrNull(row.unit),
      nutrients,
      source: this.source(row.source),
      confidence: this.confidence(row.confidence),
      rawInput: this.textOrNull(row.raw_input),
      assumptions: this.stringList(row.assumptions),
      notes: this.textOrNull(row.notes),
      createdAt: this.isoDate(row.created_at),
      updatedAt: this.isoDate(row.updated_at),
    };
  }

  /** Ordered values for an insert/update, aligned with the column lists. */
  private entryValues(userId: number, input: EntryInput): unknown[] {
    return [
      userId,
      input.date,
      input.time,
      input.mealType,
      input.foodName,
      input.brand,
      input.quantity,
      input.unit,
      ...NUTRIENT_KEYS.map((key) => input.nutrients[key]),
      input.source,
      input.confidence,
      input.rawInput,
      JSON.stringify(input.assumptions ?? []),
      input.notes,
    ];
  }

  private total(entries: FoodEntry[]): Nutrients {
    const totals = {} as Nutrients;
    for (const key of NUTRIENT_KEYS) {
      let sum = 0;
      for (const entry of entries) {
        sum += entry.nutrients[key] ?? 0;
      }
      // Round to a sane precision so summed floats do not show 0.30000004.
      totals[key] = Math.round(sum * 1000) / 1000;
    }
    return totals;
  }

  /** The server's current date as YYYY-MM-DD, decided by the database. */
  private async currentDate(): Promise<string> {
    const result = await this.db.query<{ today: string }>(
      "SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today",
    );
    return result.rows[0]?.today ?? '';
  }

  private quantityLabel(item: DraftItem): string {
    if (item.quantity === null) return '';
    return item.unit ? `${item.quantity} ${item.unit}` : `${item.quantity}`;
  }

  private text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private textOrNull(value: unknown): string | null {
    const text = this.text(value);
    return text.length > 0 ? text : null;
  }

  /** A finite non-negative number, or null. NUMERIC arrives from pg as text. */
  private num(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const n = typeof value === 'string' ? Number(value) : value;
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
  }

  private meal(value: unknown): MealType | null {
    return typeof value === 'string' && MEAL_TYPES.includes(value as MealType)
      ? (value as MealType)
      : null;
  }

  private source(value: unknown): FoodSource {
    return typeof value === 'string' && FOOD_SOURCES.includes(value as FoodSource)
      ? (value as FoodSource)
      : 'manual';
  }

  private confidence(value: unknown): Confidence | null {
    return typeof value === 'string' &&
      CONFIDENCE_LEVELS.includes(value as Confidence)
      ? (value as Confidence)
      : null;
  }

  private stringList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }

  private isoDate(value: unknown): string {
    if (value instanceof Date) return value.toISOString();
    return typeof value === 'string' ? value : '';
  }
}

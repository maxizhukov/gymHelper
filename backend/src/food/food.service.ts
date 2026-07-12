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
    return this.parseDraftItems(content, true);
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
      '"meal_type" (breakfast|lunch|dinner|snack or null), ' +
      '"label_basis_amount" (number or null = the reference amount the label ' +
      'nutrients are stated for, e.g. 100 for "per 100ml"/"pro 100ml", or the ' +
      'portion size for a per-portion table), "label_basis_unit" (string or ' +
      'null = unit of that reference amount, e.g. "ml" or "g"), ' +
      '"consumed_quantity" (number or null = how much the user actually ' +
      'consumed), "consumed_unit" (string or null = unit of the consumed ' +
      'amount, e.g. "ml" or "g"), "energy_kj" (number or null = energy in ' +
      'KILOJOULES from the label, for the label basis amount), the nutrient ' +
      'fields ' +
      this.nutrientSchemaLines() +
      ' — each stated FOR THE LABEL BASIS AMOUNT (e.g. the "per 100ml" value), ' +
      'NOT pre-multiplied, or null if not on the label, "confidence" ' +
      '(high|medium|low), "assumptions" (array of strings), and ' +
      '"needs_user_review" (boolean).\n' +
      'ENERGY — read this carefully. Labels (including German "Brennwert" / ' +
      '"Nährwertdeklaration") print energy TWICE: kilojoules (kJ) and ' +
      'kilocalories (kcal). "calories_kcal" MUST be the kcal value, NEVER the ' +
      'kJ value. Example label "Energy 194 kJ / 46 kcal" -> calories_kcal is ' +
      '46, not 194; put 194 in energy_kj. If BOTH kJ and kcal are shown, always ' +
      'use the kcal number for calories_kcal. If ONLY kJ is shown, convert with ' +
      'kcal = kJ / 4.184 and add an assumption saying you converted from kJ. ' +
      'Never copy a kJ number into calories_kcal.\n' +
      'BASIS & AMOUNT — read "label_basis_amount"/"label_basis_unit" from the ' +
      'label, e.g. "per 100ml"/"pro 100ml"/"je 100ml"/"per 100 ml" -> 100 + ' +
      '"ml"; "per 100g"/"pro 100g"/"je 100g" -> 100 + "g". If only a ' +
      'per-portion table is shown, use the portion size as the basis. If BOTH a ' +
      'per-100 and a per-portion column are shown, PREFER the per-100 basis ' +
      'because it is more reliable. Put the RAW per-basis numbers in the ' +
      'nutrient fields; do NOT multiply them yourself — the server scales them ' +
      'to the consumed amount. Set "consumed_quantity"/"consumed_unit" from the ' +
      'note or package (e.g. a 330ml can -> 330 + "ml"). If the consumed amount ' +
      'is unclear, set "consumed_quantity" to null and "needs_user_review" to ' +
      'true.\n' +
      'Use null for nutrients not on the label. Prefer exact label numbers over ' +
      'guessing. If the image has no readable label, return {"items":[]}.'
    );
  }

  private parseDraftItems(content: string, isLabel = false): DraftItem[] {
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
      .map((item) => this.mapDraftItem(item, isLabel))
      .filter((item) => item.foodName.length > 0);
  }

  private mapDraftItem(
    item: Record<string, unknown>,
    isLabel: boolean,
  ): DraftItem {
    const nutrients = {} as Nutrients;
    for (const key of NUTRIENT_KEYS) {
      nutrients[key] = this.num(item[key]);
    }
    const draft: DraftItem = {
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
    // Nutrition labels list energy as both kJ and kcal; only the second is a
    // calorie. The model can grab the larger kJ number by mistake, so correct
    // it server-side before the draft is ever shown or saved.
    if (isLabel) {
      this.correctLabelEnergy(draft, this.num(item.energy_kj));
      // Label nutrients arrive per the label basis (e.g. per 100ml). Scale them
      // deterministically to the amount actually consumed — never rely on the
      // model to do the multiplication.
      this.scaleLabelToConsumed(draft, item);
    }
    return draft;
  }

  /**
   * Turns per-basis label values (e.g. "per 100ml") into the values for the
   * amount actually consumed, so the draft always represents what was eaten.
   *
   *   multiplier = consumed_quantity / label_basis_amount
   *
   * Every non-null nutrient is multiplied; nulls stay null. Rounding keeps up
   * to three decimals so display is clean but decimals are preserved
   * (e.g. 10.5g sugar × 2.5 = 26.25g). Cases:
   *  - basis + consumed known: scale, set quantity/unit to the consumed amount.
   *  - basis known, consumed unclear: keep per-basis values, set quantity to
   *    the basis amount, flag needs_user_review.
   *  - no usable basis: the numbers already represent the consumed amount
   *    (model fallback), so leave them untouched.
   */
  private scaleLabelToConsumed(
    draft: DraftItem,
    item: Record<string, unknown>,
  ): void {
    const basisAmount = this.num(item.label_basis_amount);
    const basisUnit = this.textOrNull(item.label_basis_unit);
    const consumedQuantity = this.num(item.consumed_quantity) ?? draft.quantity;
    const consumedUnit = this.textOrNull(item.consumed_unit) ?? draft.unit;

    // Reflect the consumed amount on the draft whenever we know it.
    if (consumedQuantity !== null) {
      draft.quantity = consumedQuantity;
      if (consumedUnit !== null) draft.unit = consumedUnit;
    }

    // No usable label basis: the model's numbers already represent the amount
    // consumed, so there is nothing to scale.
    if (basisAmount === null || basisAmount <= 0) return;

    // Consumed amount unclear: keep the per-basis values but say so and ask the
    // user to confirm rather than silently treating per-100 as the total.
    if (consumedQuantity === null || consumedQuantity <= 0) {
      draft.quantity = basisAmount;
      draft.unit = basisUnit ?? draft.unit;
      draft.needsUserReview = true;
      draft.assumptions.push(
        `Consumed amount was unclear; values are per ${this.amountLabel(basisAmount, basisUnit)}.`,
      );
      return;
    }

    const multiplier = consumedQuantity / basisAmount;
    if (multiplier !== 1) {
      for (const key of NUTRIENT_KEYS) {
        const value = draft.nutrients[key];
        if (value !== null) {
          draft.nutrients[key] = Math.round(value * multiplier * 1000) / 1000;
        }
      }
      draft.assumptions.push(
        `Nutrition label values were per ${this.amountLabel(basisAmount, basisUnit)} ` +
          `and were scaled to ${this.amountLabel(consumedQuantity, consumedUnit ?? basisUnit)} consumed amount.`,
      );
    }
    draft.unit = consumedUnit ?? basisUnit ?? draft.unit;
  }

  /** A compact "250ml" / "100g" amount label, or just the number if unitless. */
  private amountLabel(amount: number, unit: string | null): string {
    return unit ? `${amount}${unit}` : `${amount}`;
  }

  /**
   * Keeps `calories_kcal` a true kilocalorie value, never a kilojoule one.
   *
   * European "Nährwertdeklaration" / "Brennwert" labels print energy twice,
   * e.g. `194 kJ / 46 kcal`. 1 kcal = 4.184 kJ, so a genuine kcal figure is
   * roughly a quarter of the kJ figure. This runs on the raw per-basis label
   * values, before scaleLabelToConsumed multiplies to the consumed amount:
   *  - kcal present and clearly a real kcal (≈ kJ ÷ 4.184): keep it.
   *  - kcal present but ≈ the kJ number (model misread kJ as kcal): replace it
   *    with kJ ÷ 4.184 and record the correction.
   *  - only kJ present: convert kJ ÷ 4.184 and record the assumption.
   * Never stores kJ directly as calories.
   *
   * Worked examples (per-100ml label; scaling to the consumed amount happens
   * afterwards):
   *  - 194 kJ / 46 kcal → 46 kcal   (not 194)
   *  - 180 kJ only      → 180 ÷ 4.184 ≈ 43 kcal
   */
  private correctLabelEnergy(draft: DraftItem, energyKj: number | null): void {
    if (energyKj === null || energyKj <= 0) return;
    const convertedKcal = Math.round((energyKj / 4.184) * 10) / 10;
    const kcal = draft.nutrients.calories_kcal;

    if (kcal === null) {
      draft.nutrients.calories_kcal = convertedKcal;
      draft.assumptions.push(
        `Label showed only ${energyKj} kJ; converted to ${convertedKcal} kcal (kJ ÷ 4.184).`,
      );
      return;
    }

    // A real kcal is ~24% of the kJ number. If the reported "kcal" is within
    // 15% of the kJ number instead, it is the kJ value mislabeled — correct it.
    if (Math.abs(kcal - energyKj) <= energyKj * 0.15) {
      draft.nutrients.calories_kcal = convertedKcal;
      draft.assumptions.push(
        `Reported ${kcal} kcal matched the ${energyKj} kJ figure; corrected to ${convertedKcal} kcal (kJ ÷ 4.184).`,
      );
    }
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

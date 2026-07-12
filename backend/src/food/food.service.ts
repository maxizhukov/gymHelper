import {
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Turns a free-text meal description into structured nutrition, by asking the
 * OpenAI API directly.
 *
 * The API key lives only here: it is read from the backend environment
 * (`OPENAI_API_KEY`) through the config service and used to authenticate the
 * server-to-server call. It is never returned to the caller and never reaches
 * the browser — the frontend posts a description to our own endpoint and gets
 * back parsed nutrition, nothing else. This is a runtime HTTPS call to OpenAI;
 * it deliberately does not shell out to the Codex CLI.
 */

/** The chat-completions endpoint. */
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

/** A small, cheap model is plenty for structured nutrition estimates. */
const OPENAI_MODEL = 'gpt-4o-mini';

/** Bound the wait: a hung upstream must not hold a request open indefinitely. */
const REQUEST_TIMEOUT_MS = 20_000;

const SYSTEM_PROMPT =
  'You estimate nutrition for meals. Given a free-text description of food, ' +
  'return strict JSON of the form ' +
  '{"items":[{"name":string,"quantity":string,"calories":number,' +
  '"proteinGrams":number,"carbsGrams":number,"fatGrams":number}]}. ' +
  'One entry per distinct food. Numbers are grams or kilocalories, rounded to ' +
  'whole numbers, never null. If the text names no food, return {"items":[]}.';

/** One parsed food line. Every figure is the model's best estimate. */
export interface FoodItem {
  name: string;
  quantity: string;
  calories: number;
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
}

/** The parsed meal plus its summed macros, so the client renders both. */
export interface ParsedMeal {
  items: FoodItem[];
  totals: {
    calories: number;
    proteinGrams: number;
    carbsGrams: number;
    fatGrams: number;
  };
}

@Injectable()
export class FoodService {
  constructor(private readonly config: ConfigService) {}

  /** Parses a meal description into structured, totalled nutrition. */
  async parse(description: string): Promise<ParsedMeal> {
    const items = await this.requestParse(description);
    return { items, totals: this.total(items) };
  }

  /** Calls OpenAI and returns the validated list of items. */
  private async requestParse(description: string): Promise<FoodItem[]> {
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      // A missing key is a server misconfiguration, not the client's fault.
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
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: description },
          ],
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // Timeout or network failure reaching OpenAI. Never leak the key or the
      // upstream detail; the client only needs to know it can retry.
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

    return this.parseItems(content);
  }

  /** Reads the model's JSON content into clean, bounded FoodItems. */
  private parseItems(content: string): FoodItem[] {
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
      .map((item) => ({
        name: this.text(item.name),
        quantity: this.text(item.quantity),
        calories: this.number(item.calories),
        proteinGrams: this.number(item.proteinGrams),
        carbsGrams: this.number(item.carbsGrams),
        fatGrams: this.number(item.fatGrams),
      }))
      .filter((item) => item.name.length > 0);
  }

  private text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  /** A non-negative whole number; anything else becomes 0. */
  private number(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? Math.round(value)
      : 0;
  }

  private total(items: FoodItem[]): ParsedMeal['totals'] {
    return items.reduce(
      (totals, item) => ({
        calories: totals.calories + item.calories,
        proteinGrams: totals.proteinGrams + item.proteinGrams,
        carbsGrams: totals.carbsGrams + item.carbsGrams,
        fatGrams: totals.fatGrams + item.fatGrams,
      }),
      { calories: 0, proteinGrams: 0, carbsGrams: 0, fatGrams: 0 },
    );
  }
}

import { errorMessage } from './api'

/**
 * Data access for food parsing. The browser only ever sends a description to our
 * own backend and receives structured nutrition back — the OpenAI key lives on
 * the server and never reaches this code. The session cookie goes with the
 * request; the server gates the call behind it.
 */

export type FoodItem = {
  name: string
  quantity: string
  calories: number
  proteinGrams: number
  carbsGrams: number
  fatGrams: number
}

export type ParsedMeal = {
  items: FoodItem[]
  totals: {
    calories: number
    proteinGrams: number
    carbsGrams: number
    fatGrams: number
  }
}

const GENERIC_ERROR = 'Could not parse that food. Please try again.'

/** Posts a meal description to the backend and returns the parsed nutrition. */
export async function parseFood(description: string): Promise<ParsedMeal> {
  const res = await fetch('/api/food/parse', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description }),
  })
  if (!res.ok) {
    throw new Error(await errorMessage(res, GENERIC_ERROR))
  }
  const data = (await res.json()) as { meal: ParsedMeal }
  return data.meal
}

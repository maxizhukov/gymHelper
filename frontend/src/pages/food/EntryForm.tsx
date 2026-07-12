import { useState } from 'react'
import {
  MACRO_KEYS,
  MEAL_TYPES,
  NUTRIENT_META,
  createEntry,
  updateEntry,
  type Confidence,
  type DraftItem,
  type EntryPayload,
  type FoodEntry,
  type FoodSource,
  type MealType,
  type NutrientKey,
  type Nutrients,
} from '../../food'

/**
 * The one editor used for both a model draft and an already-saved entry. To
 * stay approachable it shows only the basics up front — food name, brand,
 * quantity, and the four headline macros — and tucks the meal, date/time, every
 * micronutrient and notes behind an "Edit all nutrients" disclosure. Nothing is
 * persisted until the user presses the save button, which posts to the create
 * or update endpoint; the server stores it and returns the stored row, which
 * the caller renders.
 */

/** The four macros shown as editable fields up front: calories, protein, carbs, fat. */
const BASIC_NUTRIENTS = (['calories_kcal', 'protein_g', 'carbs_g', 'fat_g'] as const)
  .map((key) => NUTRIENT_META.find((m) => m.key === key))
  .filter((m): m is (typeof NUTRIENT_META)[number] => m !== undefined)
/** Everything else — micronutrients — lives behind the disclosure. */
const ADVANCED_NUTRIENTS = NUTRIENT_META.filter(
  (m) => !MACRO_KEYS.includes(m.key),
)

type NutrientStrings = Record<NutrientKey, string>

type FormState = {
  date: string
  time: string
  mealType: MealType | ''
  foodName: string
  brand: string
  quantity: string
  unit: string
  nutrients: NutrientStrings
  notes: string
}

/** A number as an input value: unknown (null) shows as empty, not "0". */
function numToStr(value: number | null): string {
  return value === null || Number.isNaN(value) ? '' : String(value)
}

/** An input value back to a number: empty or invalid becomes null (unknown). */
function strToNum(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function nutrientsToStrings(nutrients: Nutrients): NutrientStrings {
  return Object.fromEntries(
    NUTRIENT_META.map((meta) => [meta.key, numToStr(nutrients[meta.key])]),
  ) as NutrientStrings
}

export type EntrySeed = {
  id?: number
  source: FoodSource
  confidence: Confidence | null
  rawInput: string | null
  assumptions: string[]
  needsUserReview?: boolean
  form: FormState
}

/** Builds the editor's initial state from a fresh model draft. */
export function seedFromDraft(
  draft: DraftItem,
  date: string,
  source: FoodSource,
  rawInput: string | null,
): EntrySeed {
  return {
    source,
    confidence: draft.confidence,
    rawInput,
    assumptions: draft.assumptions,
    needsUserReview: draft.needsUserReview,
    form: {
      date,
      time: '',
      mealType: draft.mealType ?? '',
      foodName: draft.foodName,
      brand: draft.brand ?? '',
      quantity: numToStr(draft.quantity),
      unit: draft.unit ?? '',
      nutrients: nutrientsToStrings(draft.nutrients),
      notes: '',
    },
  }
}

/** Builds the editor's initial state from an existing saved entry. */
export function seedFromEntry(entry: FoodEntry): EntrySeed {
  return {
    id: entry.id,
    source: entry.source,
    confidence: entry.confidence,
    rawInput: entry.rawInput,
    assumptions: entry.assumptions,
    form: {
      date: entry.date,
      time: entry.time ?? '',
      mealType: entry.mealType ?? '',
      foodName: entry.foodName,
      brand: entry.brand ?? '',
      quantity: numToStr(entry.quantity),
      unit: entry.unit ?? '',
      nutrients: nutrientsToStrings(entry.nutrients),
      notes: entry.notes ?? '',
    },
  }
}

/** A blank entry for manual entry with no model help. */
export function seedBlank(date: string): EntrySeed {
  return {
    source: 'manual',
    confidence: null,
    rawInput: null,
    assumptions: [],
    form: {
      date,
      time: '',
      mealType: '',
      foodName: '',
      brand: '',
      quantity: '',
      unit: '',
      nutrients: Object.fromEntries(
        NUTRIENT_META.map((meta) => [meta.key, '']),
      ) as NutrientStrings,
      notes: '',
    },
  }
}

export default function EntryForm({
  seed,
  onSaved,
  onCancel,
  saveLabel = 'Save',
  cancelLabel = 'Cancel',
}: {
  seed: EntrySeed
  onSaved: (entry: FoodEntry) => void
  onCancel: () => void
  saveLabel?: string
  cancelLabel?: string
}) {
  const [form, setForm] = useState<FormState>(seed.form)
  const [status, setStatus] = useState<'idle' | 'saving'>('idle')
  const [error, setError] = useState('')

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function setNutrient(key: NutrientKey, value: string) {
    setForm((prev) => ({
      ...prev,
      nutrients: { ...prev.nutrients, [key]: value },
    }))
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (status === 'saving') return
    const foodName = form.foodName.trim()
    if (foodName.length === 0) {
      setError('A food name is required.')
      return
    }

    const nutrients = Object.fromEntries(
      NUTRIENT_META.map((meta) => [meta.key, strToNum(form.nutrients[meta.key])]),
    ) as Nutrients

    const payload: EntryPayload = {
      date: form.date || null,
      time: form.time || null,
      meal_type: form.mealType || null,
      food_name: foodName,
      brand: form.brand.trim() || null,
      quantity: strToNum(form.quantity),
      unit: form.unit.trim() || null,
      nutrients,
      source: seed.source,
      confidence: seed.confidence,
      raw_input: seed.rawInput,
      assumptions: seed.assumptions,
      notes: form.notes.trim() || null,
    }

    setStatus('saving')
    setError('')
    try {
      const entry =
        seed.id === undefined
          ? await createEntry(payload)
          : await updateEntry(seed.id, payload)
      onSaved(entry)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.')
      setStatus('idle')
    }
  }

  return (
    <form className="food-entry-form" onSubmit={onSubmit}>
      {seed.needsUserReview && (
        <p className="food-review-flag" role="status">
          Please double-check these numbers before saving.
        </p>
      )}

      <label className="label" htmlFor="entry-name">
        Food name
      </label>
      <input
        id="entry-name"
        className="food-text-input"
        value={form.foodName}
        maxLength={200}
        onChange={(e) => setField('foodName', e.target.value)}
      />

      <div className="food-form-row">
        <div className="food-form-col">
          <label className="label" htmlFor="entry-brand">
            Brand
          </label>
          <input
            id="entry-brand"
            className="food-text-input"
            value={form.brand}
            maxLength={120}
            onChange={(e) => setField('brand', e.target.value)}
          />
        </div>
        <div className="food-form-col">
          <label className="label" htmlFor="entry-quantity">
            Quantity
          </label>
          <input
            id="entry-quantity"
            className="food-text-input"
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={form.quantity}
            onChange={(e) => setField('quantity', e.target.value)}
          />
        </div>
        <div className="food-form-col">
          <label className="label" htmlFor="entry-unit">
            Unit
          </label>
          <input
            id="entry-unit"
            className="food-text-input"
            value={form.unit}
            maxLength={120}
            placeholder="g, ml, piece"
            onChange={(e) => setField('unit', e.target.value)}
          />
        </div>
      </div>

      <div className="food-nutrient-grid">
        {BASIC_NUTRIENTS.map((meta) => (
          <div className="food-nutrient-field" key={meta.key}>
            <label className="food-nutrient-label" htmlFor={`n-${meta.key}`}>
              {meta.label} <span className="food-nutrient-unit">{meta.unit}</span>
            </label>
            <input
              id={`n-${meta.key}`}
              className="food-text-input"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={form.nutrients[meta.key]}
              onChange={(e) => setNutrient(meta.key, e.target.value)}
            />
          </div>
        ))}
      </div>

      <details className="food-advanced">
        <summary>Edit all nutrients</summary>
        <div className="food-advanced-body">
          <div className="food-form-row">
            <div className="food-form-col">
              <label className="label" htmlFor="entry-meal">
                Meal
              </label>
              <select
                id="entry-meal"
                className="food-text-input"
                value={form.mealType}
                onChange={(e) =>
                  setField('mealType', e.target.value as MealType | '')
                }
              >
                <option value="">—</option>
                {MEAL_TYPES.map((meal) => (
                  <option key={meal} value={meal}>
                    {meal}
                  </option>
                ))}
              </select>
            </div>
            <div className="food-form-col">
              <label className="label" htmlFor="entry-date">
                Date
              </label>
              <input
                id="entry-date"
                className="food-text-input"
                type="date"
                value={form.date}
                onChange={(e) => setField('date', e.target.value)}
              />
            </div>
            <div className="food-form-col">
              <label className="label" htmlFor="entry-time">
                Time
              </label>
              <input
                id="entry-time"
                className="food-text-input"
                type="time"
                value={form.time}
                onChange={(e) => setField('time', e.target.value)}
              />
            </div>
          </div>

          <p className="label food-nutrient-heading">
            Other nutrients (leave blank if unknown)
          </p>
          <div className="food-nutrient-grid">
            {ADVANCED_NUTRIENTS.map((meta) => (
              <div className="food-nutrient-field" key={meta.key}>
                <label className="food-nutrient-label" htmlFor={`n-${meta.key}`}>
                  {meta.label}{' '}
                  <span className="food-nutrient-unit">{meta.unit}</span>
                </label>
                <input
                  id={`n-${meta.key}`}
                  className="food-text-input"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  value={form.nutrients[meta.key]}
                  onChange={(e) => setNutrient(meta.key, e.target.value)}
                />
              </div>
            ))}
          </div>

          <label className="label" htmlFor="entry-notes">
            Notes
          </label>
          <textarea
            id="entry-notes"
            className="food-text-input"
            rows={2}
            maxLength={1000}
            value={form.notes}
            onChange={(e) => setField('notes', e.target.value)}
          />
        </div>
      </details>

      {seed.assumptions.length > 0 && (
        <div className="food-assumptions">
          <p className="label">Assumptions</p>
          <ul>
            {seed.assumptions.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="food-form-actions">
        <button
          type="button"
          className="nav-button food-button-secondary"
          onClick={onCancel}
          disabled={status === 'saving'}
        >
          {cancelLabel}
        </button>
        <button
          type="submit"
          className="nav-button food-button-primary"
          disabled={status === 'saving'}
        >
          {status === 'saving' ? 'Saving…' : saveLabel}
        </button>
      </div>
    </form>
  )
}

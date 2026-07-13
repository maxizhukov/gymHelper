import { useCallback, useEffect, useState } from 'react'
import { isAbort, type Loadable } from '../api'
import {
  MACRO_KEYS,
  MEAL_TYPES,
  NUTRIENT_META,
  deleteEntry,
  fetchDay,
  fetchToday,
  formatNutrient,
  type DayLog,
  type FoodEntry,
  type MealType,
  type NutrientKey,
  type NutrientMeta,
  type Nutrients,
  type Targets,
} from '../food'
import AddFood from './food/AddFood'
import EntryForm, { seedFromEntry } from './food/EntryForm'
import NutritionAssistant from './food/NutritionAssistant'
import TargetsForm from './food/TargetsForm'

/**
 * The Food tab: a full nutrition tracker backed entirely by the database. It
 * shows the selected day's saved items grouped by meal, the running totals for
 * every tracked nutrient measured against the user's targets, and lets the user
 * add (by text or label photo), edit, and delete items and set their targets.
 * All source-of-truth data is read from and written to the backend — this
 * component keeps only the transient view state.
 */

type View = 'day' | 'add' | 'targets'

/** Shifts a YYYY-MM-DD date by whole days without tripping over time zones. */
function addDays(date: string, delta: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const shifted = new Date(Date.UTC(y, m - 1, d + delta))
  return shifted.toISOString().slice(0, 10)
}

function friendlyDate(date: string, today: string): string {
  if (date === today) return 'Today'
  if (date === addDays(today, -1)) return 'Yesterday'
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

type Progress = {
  pct: number
  state: 'under' | 'good' | 'over'
  goalText: string
}

/** Where a running total sits against its goal, range, or ceiling. */
function progressFor(
  meta: NutrientMeta,
  value: number,
  targets: Targets,
): Progress {
  if (meta.kind === 'target') {
    const goal = targets[meta.target]
    return {
      pct: goal > 0 ? (value / goal) * 100 : 0,
      state: value > goal * 1.2 ? 'over' : value >= goal * 0.99 ? 'good' : 'under',
      goalText: `/ ${formatNutrient(goal, meta.decimals)} ${meta.unit}`,
    }
  }
  if (meta.kind === 'max') {
    const max = targets[meta.max]
    return {
      pct: max > 0 ? (value / max) * 100 : 0,
      state: value > max ? 'over' : 'good',
      goalText: `≤ ${formatNutrient(max, meta.decimals)} ${meta.unit}`,
    }
  }
  const min = targets[meta.min]
  const max = targets[meta.max]
  return {
    pct: max > 0 ? (value / max) * 100 : 0,
    state: value > max ? 'over' : value >= min ? 'good' : 'under',
    goalText: `${formatNutrient(min, meta.decimals)}–${formatNutrient(max, meta.decimals)} ${meta.unit}`,
  }
}

function Meter({
  meta,
  totals,
  targets,
}: {
  meta: NutrientMeta
  totals: Nutrients
  targets: Targets
}) {
  const value = totals[meta.key] ?? 0
  const progress = progressFor(meta, value, targets)
  return (
    <div className="food-meter">
      <div className="food-meter-head">
        <span className="food-meter-label">{meta.label}</span>
        <span className="food-meter-value">
          <strong>{formatNutrient(value, meta.decimals)}</strong>{' '}
          <span className="food-meter-goal">{progress.goalText}</span>
        </span>
      </div>
      <div className="food-meter-track">
        <div
          className="food-meter-fill"
          data-state={progress.state}
          style={{ width: `${Math.min(100, Math.max(0, progress.pct))}%` }}
        />
      </div>
    </div>
  )
}

/** The headline calories card: eaten vs. goal, with the remainder spelled out. */
function CaloriesCard({
  title,
  totals,
  targets,
}: {
  title: string
  totals: Nutrients
  targets: Targets
}) {
  const value = totals.calories_kcal ?? 0
  const goal = targets.calories_kcal
  const remaining = goal - value
  const pct = goal > 0 ? Math.min(100, Math.max(0, (value / goal) * 100)) : 0
  return (
    <div className="food-calorie-card">
      <p className="food-calorie-title">{title}</p>
      <p className="food-calorie-value">
        <strong>{formatNutrient(value, 0)}</strong>
        <span className="food-calorie-goal"> / {formatNutrient(goal, 0)} kcal</span>
      </p>
      <div className="food-meter-track">
        <div
          className="food-meter-fill"
          data-state={value > goal * 1.05 ? 'over' : 'good'}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="food-calorie-remaining">
        {remaining >= 0
          ? `${formatNutrient(remaining, 0)} kcal remaining`
          : `${formatNutrient(-remaining, 0)} kcal over`}
      </p>
    </div>
  )
}

/** A compact macro chip: eaten vs. goal for one of protein / carbs / fat. */
function MacroChip({
  meta,
  totals,
  targets,
}: {
  meta: NutrientMeta
  totals: Nutrients
  targets: Targets
}) {
  const value = totals[meta.key] ?? 0
  const goal = meta.kind === 'target' ? targets[meta.target] : 0
  return (
    <div className="food-macro-chip">
      <span className="food-macro-chip-label">{meta.label}</span>
      <span className="food-macro-chip-value">
        <strong>{formatNutrient(value, meta.decimals)}</strong>
        <span className="food-macro-chip-goal">
          {' '}
          / {formatNutrient(goal, meta.decimals)}
          {meta.unit}
        </span>
      </span>
    </div>
  )
}

/** The three macro chips shown under the calories card. */
const MACRO_CHIP_KEYS: NutrientKey[] = ['protein_g', 'carbs_g', 'fat_g']

/** The full detail line for one saved item: every tracked nutrient it has. */
function nutrientDetail(entry: FoodEntry): string {
  return NUTRIENT_META.filter((meta) => entry.nutrients[meta.key] !== null)
    .map(
      (meta) =>
        `${meta.label} ${formatNutrient(entry.nutrients[meta.key], meta.decimals)}${meta.unit === 'kcal' ? '' : meta.unit}`,
    )
    .join(' · ')
}

function EntryRow({
  entry,
  onEdit,
  onDelete,
}: {
  entry: FoodEntry
  onEdit: () => void
  onDelete: () => void
}) {
  const quantity =
    entry.quantity !== null
      ? `${formatNutrient(entry.quantity, 0)}${entry.unit ? ` ${entry.unit}` : ''}`
      : entry.unit ?? ''
  return (
    <li className="food-entry-row">
      <div className="stat-row-main">
        <p className="stat-row-title">
          {entry.foodName}
          {entry.brand && <span className="food-entry-brand"> · {entry.brand}</span>}
        </p>
        {quantity && <p className="stat-row-note">{quantity}</p>}
        <p className="stat-row-note food-entry-detail">{nutrientDetail(entry)}</p>
      </div>
      <div className="stat-row-figures">
        <p className="stat-row-value">
          {formatNutrient(entry.nutrients.calories_kcal, 0)} kcal
        </p>
        <div className="food-entry-actions">
          <button type="button" className="food-link-button" onClick={onEdit}>
            Edit
          </button>
          <button
            type="button"
            className="food-link-button food-link-danger"
            onClick={onDelete}
          >
            Delete
          </button>
        </div>
      </div>
    </li>
  )
}

export default function FoodPanel() {
  const [view, setView] = useState<View>('day')
  const [date, setDate] = useState<string | null>(null)
  const [today, setToday] = useState<string>('')
  const [day, setDay] = useState<Loadable<DayLog>>({ status: 'loading' })
  const [editingId, setEditingId] = useState<number | null>(null)
  // A brief confirmation shown after a save; it clears itself so the day view
  // never carries a stale banner.
  const [toast, setToast] = useState('')

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(''), 2500)
    return () => clearTimeout(timer)
  }, [toast])

  const load = useCallback(
    async (target: string | null, signal: AbortSignal) => {
      setDay({ status: 'loading' })
      try {
        const data = target === null ? await fetchToday() : await fetchDay(target)
        if (signal.aborted) return
        if (target === null) setToday(data.date)
        setDay({ status: 'ready', data })
      } catch (err) {
        if (isAbort(err) || signal.aborted) return
        setDay({
          status: 'error',
          message: err instanceof Error ? err.message : 'Could not load food.',
        })
      }
    },
    [],
  )

  useEffect(() => {
    const controller = new AbortController()
    load(date, controller.signal)
    return () => controller.abort()
  }, [date, load])

  function reload() {
    const controller = new AbortController()
    load(date, controller.signal)
  }

  async function onDelete(entry: FoodEntry) {
    if (!window.confirm(`Delete "${entry.foodName}"?`)) return
    try {
      await deleteEntry(entry.id)
      reload()
    } catch {
      reload()
    }
  }

  const currentDate = date ?? today

  if (view === 'add') {
    return (
      <div className="food">
        {toast && (
          <p className="food-toast" role="status">
            {toast}
          </p>
        )}
        <AddFood
          date={currentDate || today}
          onEntrySaved={() => {
            reload()
            setToast('Saved to today')
          }}
          onDone={() => {
            setView('day')
            reload()
          }}
        />
      </div>
    )
  }

  if (view === 'targets' && day.status === 'ready') {
    return (
      <div className="food">
        <TargetsForm
          targets={day.data.targets}
          onSaved={() => {
            setView('day')
            reload()
          }}
          onCancel={() => setView('day')}
        />
      </div>
    )
  }

  return (
    <div className="food">
      {toast && (
        <p className="food-toast" role="status">
          {toast}
        </p>
      )}
      <div className="food-date-nav">
        <button
          type="button"
          className="food-nav-arrow"
          aria-label="Previous day"
          onClick={() => setDate(addDays(currentDate, -1))}
          disabled={!currentDate}
        >
          ‹
        </button>
        <div className="food-date-label">
          {currentDate ? friendlyDate(currentDate, today) : '…'}
          <input
            className="food-date-input"
            type="date"
            value={currentDate}
            max={today || undefined}
            onChange={(e) => setDate(e.target.value || null)}
          />
        </div>
        <button
          type="button"
          className="food-nav-arrow"
          aria-label="Next day"
          onClick={() => setDate(addDays(currentDate, 1))}
          disabled={!currentDate || currentDate >= today}
        >
          ›
        </button>
      </div>

      {day.status === 'loading' && <p className="subtitle">Loading…</p>}

      {day.status === 'error' && (
        <p className="error" role="alert">
          {day.message}
        </p>
      )}

      {day.status === 'ready' && (
        <>
          <div className="food-actions">
            <button
              type="button"
              className="nav-button"
              onClick={() => setView('add')}
            >
              + Add food
            </button>
            <button
              type="button"
              className="nav-button food-button-secondary"
              onClick={() => setView('targets')}
            >
              Targets
            </button>
          </div>

          <section className="food-summary">
            <CaloriesCard
              title={currentDate ? friendlyDate(currentDate, today) : 'Today'}
              totals={day.data.totals}
              targets={day.data.targets}
            />

            <div className="food-macro-chips">
              {MACRO_CHIP_KEYS.map((key) => {
                const meta = NUTRIENT_META.find((m) => m.key === key)
                if (!meta) return null
                return (
                  <MacroChip
                    key={key}
                    meta={meta}
                    totals={day.data.totals}
                    targets={day.data.targets}
                  />
                )
              })}
            </div>

            <details className="food-micros">
              <summary>More nutrients</summary>
              <div className="food-micros-list">
                {NUTRIENT_META.filter((m) => !MACRO_KEYS.includes(m.key)).map(
                  (meta) => (
                    <Meter
                      key={meta.key}
                      meta={meta}
                      totals={day.data.totals}
                      targets={day.data.targets}
                    />
                  ),
                )}
              </div>
            </details>
          </section>

          <NutritionAssistant date={date} />

          {day.data.entries.length === 0 ? (
            <p className="subtitle">No food logged for this day yet.</p>
          ) : (
            <section className="food-entries">
              {[...MEAL_TYPES, null].map((meal) => {
                const items = day.data.entries.filter(
                  (e) => (e.mealType ?? null) === meal,
                )
                if (items.length === 0) return null
                return (
                  <div className="food-meal-group" key={meal ?? 'other'}>
                    <h3 className="food-meal-heading">
                      {meal ? mealLabel(meal) : 'Other'}
                    </h3>
                    <ul className="stat-list">
                      {items.map((entry) =>
                        editingId === entry.id ? (
                          <li key={entry.id}>
                            <EntryForm
                              seed={seedFromEntry(entry)}
                              onSaved={() => {
                                setEditingId(null)
                                reload()
                              }}
                              onCancel={() => setEditingId(null)}
                            />
                          </li>
                        ) : (
                          <EntryRow
                            key={entry.id}
                            entry={entry}
                            onEdit={() => setEditingId(entry.id)}
                            onDelete={() => onDelete(entry)}
                          />
                        ),
                      )}
                    </ul>
                  </div>
                )
              })}
            </section>
          )}
        </>
      )}
    </div>
  )
}

function mealLabel(meal: MealType): string {
  return meal.charAt(0).toUpperCase() + meal.slice(1)
}

import { useCallback, useEffect, useState } from 'react'
import { isAbort, type Loadable } from '../../api'
import {
  NUTRIENT_META,
  addFavouriteToday,
  deleteFavourite,
  fetchFavourites,
  formatNutrient,
  updateFavourite,
  type Favourite,
  type FavouritePayload,
  type FoodEntry,
  type Nutrients,
} from '../../food'

/**
 * The favourites / saved foods view. A favourite is a reusable template: the
 * user saves foods they eat often (captured from a logged entry, or edited
 * here) and taps "Add today" to drop a fresh copy into the current day with all
 * nutrition already filled. The favourite itself never moves into a day —
 * adding one always creates a new entry — and editing a favourite never
 * rewrites entries already logged from it. PostgreSQL is the source of truth;
 * this component only holds transient view state.
 */

/** The four macros summarised on each card and editable in the mini form. */
const MACROS = (['calories_kcal', 'protein_g', 'carbs_g', 'fat_g'] as const).map(
  (key) => {
    const meta = NUTRIENT_META.find((m) => m.key === key)
    if (!meta) throw new Error(`Missing nutrient meta for ${key}`)
    return meta
  },
)

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

/** The one-line macro summary shown under a favourite's name. */
function macroSummary(fav: Favourite): string {
  return MACROS.map((meta) => {
    const value = formatNutrient(fav.nutrients[meta.key], meta.decimals)
    return meta.key === 'calories_kcal'
      ? `${value} kcal`
      : `${meta.label} ${value}${meta.unit}`
  }).join(' · ')
}

/** The compact edit form for one favourite. Preserves any micronutrients the
 *  favourite already carries — only the shown fields are editable here. */
function FavouriteForm({
  favourite,
  onSaved,
  onCancel,
}: {
  favourite: Favourite
  onSaved: (favourite: Favourite) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(favourite.name)
  const [brand, setBrand] = useState(favourite.brand ?? '')
  const [quantity, setQuantity] = useState(numToStr(favourite.quantity))
  const [unit, setUnit] = useState(favourite.unit ?? '')
  const [notes, setNotes] = useState(favourite.notes ?? '')
  const [macros, setMacros] = useState<Record<string, string>>(
    Object.fromEntries(
      MACROS.map((meta) => [meta.key, numToStr(favourite.nutrients[meta.key])]),
    ),
  )
  const [status, setStatus] = useState<'idle' | 'saving'>('idle')
  const [error, setError] = useState('')

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (status === 'saving') return
    const trimmed = name.trim()
    if (trimmed.length === 0) {
      setError('A name is required.')
      return
    }
    // Keep every micronutrient the favourite already has; only overwrite the
    // macros the user can see and edit here.
    const nutrients: Nutrients = { ...favourite.nutrients }
    for (const meta of MACROS) nutrients[meta.key] = strToNum(macros[meta.key])

    const payload: FavouritePayload = {
      name: trimmed,
      brand: brand.trim() || null,
      quantity: strToNum(quantity),
      unit: unit.trim() || null,
      nutrients,
      notes: notes.trim() || null,
      source_entry_id: favourite.sourceEntryId,
    }
    setStatus('saving')
    setError('')
    try {
      onSaved(await updateFavourite(favourite.id, payload))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.')
      setStatus('idle')
    }
  }

  return (
    <form className="food-entry-form" onSubmit={onSubmit}>
      <label className="label" htmlFor={`fav-name-${favourite.id}`}>
        Name
      </label>
      <input
        id={`fav-name-${favourite.id}`}
        className="food-text-input"
        value={name}
        maxLength={200}
        onChange={(e) => setName(e.target.value)}
      />

      <div className="food-form-row">
        <div className="food-form-col">
          <label className="label" htmlFor={`fav-brand-${favourite.id}`}>
            Brand
          </label>
          <input
            id={`fav-brand-${favourite.id}`}
            className="food-text-input"
            value={brand}
            maxLength={120}
            onChange={(e) => setBrand(e.target.value)}
          />
        </div>
        <div className="food-form-col">
          <label className="label" htmlFor={`fav-qty-${favourite.id}`}>
            Serving
          </label>
          <input
            id={`fav-qty-${favourite.id}`}
            className="food-text-input"
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </div>
        <div className="food-form-col">
          <label className="label" htmlFor={`fav-unit-${favourite.id}`}>
            Unit
          </label>
          <input
            id={`fav-unit-${favourite.id}`}
            className="food-text-input"
            value={unit}
            maxLength={120}
            placeholder="g, ml, piece"
            onChange={(e) => setUnit(e.target.value)}
          />
        </div>
      </div>

      <div className="food-nutrient-grid">
        {MACROS.map((meta) => (
          <div className="food-nutrient-field" key={meta.key}>
            <label
              className="food-nutrient-label"
              htmlFor={`fav-n-${favourite.id}-${meta.key}`}
            >
              {meta.label} <span className="food-nutrient-unit">{meta.unit}</span>
            </label>
            <input
              id={`fav-n-${favourite.id}-${meta.key}`}
              className="food-text-input"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={macros[meta.key]}
              onChange={(e) =>
                setMacros((prev) => ({ ...prev, [meta.key]: e.target.value }))
              }
            />
          </div>
        ))}
      </div>

      <label className="label" htmlFor={`fav-notes-${favourite.id}`}>
        Notes
      </label>
      <textarea
        id={`fav-notes-${favourite.id}`}
        className="food-text-input"
        rows={2}
        maxLength={1000}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />

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
          Cancel
        </button>
        <button
          type="submit"
          className="nav-button food-button-primary"
          disabled={status === 'saving'}
        >
          {status === 'saving' ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  )
}

/** One favourite row: name, macros, an optional quantity, and its actions. */
function FavouriteCard({
  favourite,
  onEdit,
  onAdded,
  onDeleted,
}: {
  favourite: Favourite
  onEdit: () => void
  onAdded: (entry: FoodEntry) => void
  onDeleted: () => void
}) {
  const [qty, setQty] = useState('')
  const [busy, setBusy] = useState<'add' | 'delete' | null>(null)
  const [error, setError] = useState('')

  async function onAddToday() {
    if (busy) return
    setBusy('add')
    setError('')
    try {
      const { entry } = await addFavouriteToday(favourite.id, strToNum(qty))
      onAdded(entry)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add.')
    } finally {
      setBusy(null)
    }
  }

  async function onDelete() {
    if (busy) return
    if (!window.confirm(`Remove "${favourite.name}" from favourites?`)) return
    setBusy('delete')
    setError('')
    try {
      await deleteFavourite(favourite.id)
      onDeleted()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove.')
      setBusy(null)
    }
  }

  return (
    <div className="food-fav-card">
      <div className="food-fav-main">
        <p className="food-fav-name">
          {favourite.name}
          {favourite.brand && (
            <span className="food-entry-brand"> · {favourite.brand}</span>
          )}
        </p>
        <p className="food-fav-macros">{macroSummary(favourite)}</p>
        {favourite.quantity !== null && (
          <p className="stat-row-note">
            per {formatNutrient(favourite.quantity, 0)}
            {favourite.unit ? ` ${favourite.unit}` : ''}
          </p>
        )}
      </div>
      <div className="food-fav-side">
        <div className="food-fav-add">
          <input
            className="food-text-input food-fav-qty"
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            placeholder={
              favourite.quantity !== null
                ? String(favourite.quantity)
                : 'qty'
            }
            aria-label="Quantity to add"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
          />
          <button
            type="button"
            className="nav-button food-button-primary food-button-small"
            onClick={onAddToday}
            disabled={busy !== null}
          >
            {busy === 'add' ? 'Adding…' : 'Add today'}
          </button>
        </div>
        <div className="food-entry-actions">
          <button
            type="button"
            className="food-link-button"
            onClick={onEdit}
            disabled={busy !== null}
          >
            Edit
          </button>
          <button
            type="button"
            className="food-link-button food-link-danger"
            onClick={onDelete}
            disabled={busy !== null}
          >
            Delete
          </button>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}

export default function Favourites({
  onAdded,
  onDone,
}: {
  onAdded: (entry: FoodEntry) => void
  onDone: () => void
}) {
  const [search, setSearch] = useState('')
  const [list, setList] = useState<Loadable<Favourite[]>>({ status: 'loading' })
  const [editingId, setEditingId] = useState<number | null>(null)

  const load = useCallback(async (query: string, signal: AbortSignal) => {
    try {
      const favourites = await fetchFavourites(query)
      if (signal.aborted) return
      setList({ status: 'ready', data: favourites })
    } catch (err) {
      if (isAbort(err) || signal.aborted) return
      setList({
        status: 'error',
        message:
          err instanceof Error ? err.message : 'Could not load favourites.',
      })
    }
  }, [])

  // Refetch as the search changes; a short debounce keeps typing snappy.
  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => load(search, controller.signal), 200)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [search, load])

  function reload() {
    const controller = new AbortController()
    load(search, controller.signal)
  }

  return (
    <div className="food-add">
      <div className="food-add-head">
        <button type="button" className="food-link-button" onClick={onDone}>
          ‹ Back to today
        </button>
      </div>

      <section className="food-add-card">
        <h2 className="food-add-title">Saved foods</h2>
        <input
          className="food-text-input"
          type="search"
          placeholder="Search saved foods"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </section>

      {list.status === 'loading' && <p className="subtitle">Loading…</p>}

      {list.status === 'error' && (
        <p className="error" role="alert">
          {list.message}
        </p>
      )}

      {list.status === 'ready' &&
        (list.data.length === 0 ? (
          <div className="food-fav-empty">
            <p className="food-fav-empty-title">
              {search.trim()
                ? 'No saved foods match your search.'
                : 'No favourite foods yet'}
            </p>
            {!search.trim() && (
              <p className="subtitle">
                Save foods you eat often to add them quickly. Use “★ Favourite”
                on a logged food to save it here.
              </p>
            )}
          </div>
        ) : (
          <section className="food-fav-list">
            {list.data.map((fav) =>
              editingId === fav.id ? (
                <FavouriteForm
                  key={fav.id}
                  favourite={fav}
                  onSaved={() => {
                    setEditingId(null)
                    reload()
                  }}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <FavouriteCard
                  key={fav.id}
                  favourite={fav}
                  onEdit={() => setEditingId(fav.id)}
                  onAdded={onAdded}
                  onDeleted={reload}
                />
              ),
            )}
          </section>
        ))}
    </div>
  )
}

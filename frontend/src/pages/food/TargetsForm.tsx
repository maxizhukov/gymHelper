import { useState } from 'react'
import {
  NUTRIENT_META,
  TARGET_KEYS,
  saveTargets,
  type NutrientMeta,
  type TargetKey,
  type Targets,
} from '../../food'

/**
 * Edits the user's daily targets. Every target is stored per-user in the
 * database; this form loads the current values, lets the user change any of
 * them, and writes them back through PUT /api/food/targets. Ranges (min/max)
 * and single goals are laid out per nutrient so the numbers stay legible.
 */

/** The target fields that belong to one nutrient, in the order to show them. */
function targetFields(meta: NutrientMeta): { key: TargetKey; suffix: string }[] {
  if (meta.kind === 'target') return [{ key: meta.target, suffix: 'goal' }]
  if (meta.kind === 'max') return [{ key: meta.max, suffix: 'max' }]
  return [
    { key: meta.min, suffix: 'min' },
    { key: meta.max, suffix: 'max' },
  ]
}

export default function TargetsForm({
  targets,
  onSaved,
  onCancel,
}: {
  targets: Targets
  onSaved: (targets: Targets) => void
  onCancel: () => void
}) {
  const [values, setValues] = useState<Record<TargetKey, string>>(
    () =>
      Object.fromEntries(
        TARGET_KEYS.map((key) => [key, String(targets[key])]),
      ) as Record<TargetKey, string>,
  )
  const [status, setStatus] = useState<'idle' | 'saving'>('idle')
  const [error, setError] = useState('')

  function set(key: TargetKey, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }))
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (status === 'saving') return

    const parsed = {} as Targets
    for (const key of TARGET_KEYS) {
      const n = Number(values[key])
      if (!Number.isFinite(n) || n < 0) {
        setError(`"${key}" must be a number of 0 or more.`)
        return
      }
      parsed[key] = n
    }

    setStatus('saving')
    setError('')
    try {
      onSaved(await saveTargets(parsed))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save targets.')
      setStatus('idle')
    }
  }

  return (
    <form className="food-entry-form" onSubmit={onSubmit}>
      <p className="label food-nutrient-heading">Daily targets</p>
      <div className="food-nutrient-grid">
        {NUTRIENT_META.map((meta) =>
          targetFields(meta).map(({ key, suffix }) => (
            <div className="food-nutrient-field" key={key}>
              <label className="food-nutrient-label" htmlFor={`t-${key}`}>
                {meta.label} {suffix}{' '}
                <span className="food-nutrient-unit">{meta.unit}</span>
              </label>
              <input
                id={`t-${key}`}
                className="food-text-input"
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                value={values[key]}
                onChange={(e) => set(key, e.target.value)}
              />
            </div>
          )),
        )}
      </div>

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
        <button type="submit" className="nav-button" disabled={status === 'saving'}>
          {status === 'saving' ? 'Saving…' : 'Save targets'}
        </button>
      </div>
    </form>
  )
}

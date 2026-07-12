import { useState } from 'react'
import { parseFood, type ParsedMeal } from '../food'

/**
 * The Food tab. The user types a meal in plain language and the backend — using
 * its own OpenAI key — returns estimated nutrition. This component sends the
 * description and renders what comes back; it never sees or holds a key, and it
 * derives no numbers itself.
 */
export default function FoodPanel() {
  const [description, setDescription] = useState('')
  const [meal, setMeal] = useState<ParsedMeal | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [error, setError] = useState('')

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    const trimmed = description.trim()
    if (trimmed.length === 0 || status === 'loading') return

    setStatus('loading')
    setError('')
    try {
      setMeal(await parseFood(trimmed))
      setStatus('idle')
    } catch (err) {
      setMeal(null)
      setError(err instanceof Error ? err.message : 'Something went wrong.')
      setStatus('error')
    }
  }

  return (
    <div className="food">
      <form className="food-form" onSubmit={onSubmit}>
        <label className="label" htmlFor="food-description">
          Describe your meal
        </label>
        <textarea
          id="food-description"
          className="food-input"
          rows={3}
          maxLength={500}
          placeholder="e.g. 2 scrambled eggs, a slice of toast and a banana"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        <button
          className="nav-button"
          type="submit"
          disabled={status === 'loading' || description.trim().length === 0}
        >
          {status === 'loading' ? 'Parsing…' : 'Parse food'}
        </button>
      </form>

      {status === 'error' && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {meal !== null &&
        (meal.items.length === 0 ? (
          <p className="subtitle">No food found in that description.</p>
        ) : (
          <ul className="stat-list">
            {meal.items.map((item, index) => (
              <li className="stat-row" key={`${item.name}-${index}`}>
                <div className="stat-row-main">
                  <p className="stat-row-title">{item.name}</p>
                  <p className="stat-row-note">
                    {item.quantity ? `${item.quantity} · ` : ''}P{' '}
                    {item.proteinGrams}g · C {item.carbsGrams}g · F{' '}
                    {item.fatGrams}g
                  </p>
                </div>
                <div className="stat-row-figures">
                  <p className="stat-row-value">{item.calories} kcal</p>
                </div>
              </li>
            ))}
            <li className="stat-row" key="__totals">
              <div className="stat-row-main">
                <p className="stat-row-title">Total</p>
                <p className="stat-row-note">
                  P {meal.totals.proteinGrams}g · C {meal.totals.carbsGrams}g · F{' '}
                  {meal.totals.fatGrams}g
                </p>
              </div>
              <div className="stat-row-figures">
                <p className="stat-row-value">{meal.totals.calories} kcal</p>
              </div>
            </li>
          </ul>
        ))}
    </div>
  )
}

import { useState } from 'react'
import {
  NUTRIENT_META,
  formatNutrient,
  parseFoodPhoto,
  parseFoodText,
  type DraftItem,
  type FoodEntry,
  type FoodSource,
} from '../../food'
import EntryForm, { seedBlank, seedFromDraft } from './EntryForm'

/**
 * Adds food to a day. The user describes a meal in text or photographs a
 * nutrition label; the backend (using its own OpenAI key) returns editable
 * drafts — never saved rows. The user reviews each draft in the shared editor
 * and only then does a Save write it to the database. A blank manual entry is
 * offered too, for when there is nothing to parse.
 */

type Mode = 'text' | 'photo'

/** A one-line macro summary so a draft is scannable before it is opened. */
function draftSummary(draft: DraftItem): string {
  const macros = NUTRIENT_META.filter((m) =>
    ['calories_kcal', 'protein_g', 'carbs_g', 'fat_g'].includes(m.key),
  )
    .map(
      (m) =>
        `${m.label} ${formatNutrient(draft.nutrients[m.key], m.decimals)}${m.unit === 'kcal' ? ' kcal' : m.unit}`,
    )
    .join(' · ')
  return macros
}

export default function AddFood({
  date,
  onEntrySaved,
  onDone,
}: {
  date: string
  onEntrySaved: (entry: FoodEntry) => void
  onDone: () => void
}) {
  const [mode, setMode] = useState<Mode>('text')
  const [description, setDescription] = useState('')
  const [image, setImage] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [status, setStatus] = useState<'idle' | 'parsing'>('idle')
  const [error, setError] = useState('')

  // Parsed drafts awaiting review, and which one is open in the editor.
  const [drafts, setDrafts] = useState<DraftItem[]>([])
  const [source, setSource] = useState<FoodSource>('text')
  const [rawInput, setRawInput] = useState<string | null>(null)
  const [editing, setEditing] = useState<number | 'manual' | null>(null)

  function onPickFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setError('Please choose an image file.')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      setImage(typeof reader.result === 'string' ? reader.result : null)
      setError('')
    }
    reader.onerror = () => setError('Could not read that image.')
    reader.readAsDataURL(file)
  }

  async function onParse() {
    if (status === 'parsing') return
    setStatus('parsing')
    setError('')
    setEditing(null)
    try {
      let items: DraftItem[]
      if (mode === 'text') {
        const trimmed = description.trim()
        if (trimmed.length === 0) {
          setError('Describe your food first.')
          setStatus('idle')
          return
        }
        items = await parseFoodText(trimmed)
        setSource('text')
        setRawInput(trimmed)
      } else {
        if (!image) {
          setError('Add a photo first.')
          setStatus('idle')
          return
        }
        items = await parseFoodPhoto(image, note.trim())
        setSource('photo')
        setRawInput(note.trim() || null)
      }
      setDrafts(items)
      if (items.length === 0) {
        setError('No food found. Try adding it manually.')
      }
      setStatus('idle')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not parse that.')
      setStatus('idle')
    }
  }

  function onDraftSaved(index: number, entry: FoodEntry) {
    setDrafts((prev) => prev.filter((_, i) => i !== index))
    setEditing(null)
    onEntrySaved(entry)
  }

  return (
    <div className="food-add">
      <div className="food-mode-toggle">
        <button
          type="button"
          className="tab"
          data-selected={mode === 'text' ? '' : undefined}
          onClick={() => setMode('text')}
        >
          Text
        </button>
        <button
          type="button"
          className="tab"
          data-selected={mode === 'photo' ? '' : undefined}
          onClick={() => setMode('photo')}
        >
          Photo
        </button>
      </div>

      {mode === 'text' ? (
        <textarea
          className="food-input"
          rows={3}
          maxLength={500}
          placeholder="e.g. 2 scrambled eggs, a slice of toast and a banana"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      ) : (
        <div className="food-photo-picker">
          <input
            type="file"
            accept="image/*"
            capture="environment"
            onChange={onPickFile}
          />
          {image && (
            <img className="food-photo-preview" src={image} alt="Selected food" />
          )}
          <input
            className="food-text-input"
            placeholder="Amount consumed, e.g. whole 330ml can"
            maxLength={300}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      )}

      <div className="food-form-actions">
        <button
          type="button"
          className="nav-button food-button-secondary"
          onClick={onDone}
        >
          Back
        </button>
        <button
          type="button"
          className="nav-button"
          onClick={onParse}
          disabled={status === 'parsing'}
        >
          {status === 'parsing' ? 'Analysing…' : 'Analyse'}
        </button>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {editing === 'manual' && (
        <EntryForm
          seed={seedBlank(date)}
          onSaved={(entry) => {
            setEditing(null)
            onEntrySaved(entry)
          }}
          onCancel={() => setEditing(null)}
        />
      )}

      {drafts.length > 0 && (
        <ul className="stat-list food-draft-list">
          {drafts.map((draft, index) =>
            editing === index ? (
              <li key={index}>
                <EntryForm
                  seed={seedFromDraft(draft, date, source, rawInput)}
                  onSaved={(entry) => onDraftSaved(index, entry)}
                  onCancel={() => setEditing(null)}
                />
              </li>
            ) : (
              <li className="stat-row" key={index}>
                <div className="stat-row-main">
                  <p className="stat-row-title">
                    {draft.foodName}
                    {draft.confidence && (
                      <span
                        className="food-confidence"
                        data-level={draft.confidence}
                      >
                        {draft.confidence}
                      </span>
                    )}
                  </p>
                  <p className="stat-row-note">{draftSummary(draft)}</p>
                </div>
                <div className="stat-row-figures">
                  <button
                    type="button"
                    className="nav-button food-button-small"
                    onClick={() => setEditing(index)}
                  >
                    Review
                  </button>
                </div>
              </li>
            ),
          )}
        </ul>
      )}

      {editing !== 'manual' && (
        <button
          type="button"
          className="food-link-button"
          onClick={() => setEditing('manual')}
        >
          + Add manually instead
        </button>
      )}
    </div>
  )
}

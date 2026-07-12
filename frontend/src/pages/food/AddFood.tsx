import { useRef, useState } from 'react'
import {
  parseFoodPhoto,
  parseFoodText,
  type DraftItem,
  type FoodEntry,
  type FoodSource,
} from '../../food'
import EntryForm, { seedBlank, seedFromDraft } from './EntryForm'

/**
 * Adds food to a day in a deliberately simple three-step flow: describe a meal
 * in text or scan a nutrition label, review the AI's result, then save it to
 * the day. The backend (using its own OpenAI key) returns editable *drafts* —
 * never saved rows. Each draft is shown as its own review card with a big
 * "Save to today" button; nothing reaches the database until the user presses
 * it. A blank manual entry is offered too, for when there is nothing to parse.
 */

type Mode = 'text' | 'photo'

/** A parsed draft paired with a stable key so removing one never remounts the
 *  others onto stale form state. */
type KeyedDraft = { key: number; draft: DraftItem }

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

  // Parsed drafts awaiting review, and the context they carry once saved.
  const [drafts, setDrafts] = useState<KeyedDraft[]>([])
  const [source, setSource] = useState<FoodSource>('text')
  const [rawInput, setRawInput] = useState<string | null>(null)
  const [addingManual, setAddingManual] = useState(false)
  const keyRef = useRef(0)

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

  function keyDrafts(items: DraftItem[]): KeyedDraft[] {
    return items.map((draft) => ({ key: keyRef.current++, draft }))
  }

  async function onParse() {
    if (status === 'parsing') return
    setStatus('parsing')
    setError('')
    setAddingManual(false)
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
      setDrafts(keyDrafts(items))
      if (items.length === 0) {
        setError('No food found. Try adding it manually.')
      }
      setStatus('idle')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not analyze that.')
      setStatus('idle')
    }
  }

  function discardDraft(key: number) {
    setDrafts((prev) => prev.filter((d) => d.key !== key))
  }

  function onDraftSaved(key: number, entry: FoodEntry) {
    setDrafts((prev) => prev.filter((d) => d.key !== key))
    onEntrySaved(entry)
  }

  const parsing = status === 'parsing'

  return (
    <div className="food-add">
      <div className="food-add-head">
        <button
          type="button"
          className="food-link-button"
          onClick={onDone}
        >
          ‹ Back to today
        </button>
      </div>

      <section className="food-add-card">
        <h2 className="food-add-title">Add food</h2>

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
            placeholder="Example: 3 eggs, 2 slices bread, 1 Red Bull 330ml"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        ) : (
          <div className="food-photo-picker">
            <label className="food-scan-button">
              {image ? 'Choose a different photo' : 'Scan nutrition label'}
              <input
                type="file"
                accept="image/*"
                capture="environment"
                onChange={onPickFile}
              />
            </label>
            <p className="food-helper-text">
              Best for packaged foods. Take a clear photo of the nutrition table.
            </p>
            {image && (
              <img
                className="food-photo-preview"
                src={image}
                alt="Selected food"
              />
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

        <button
          type="button"
          className="nav-button food-button-primary food-analyze-button"
          onClick={onParse}
          disabled={parsing}
        >
          {parsing
            ? 'Analyzing…'
            : mode === 'text'
              ? 'Analyze food'
              : 'Scan label'}
        </button>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>

      {drafts.length > 0 && (
        <section className="food-review">
          <h3 className="food-review-title">Review before saving</h3>
          {drafts.map(({ key, draft }) => (
            <EntryForm
              key={key}
              seed={seedFromDraft(draft, date, source, rawInput)}
              saveLabel="Save to today"
              cancelLabel="Discard"
              onSaved={(entry) => onDraftSaved(key, entry)}
              onCancel={() => discardDraft(key)}
            />
          ))}
        </section>
      )}

      {addingManual ? (
        <section className="food-review">
          <h3 className="food-review-title">Add manually</h3>
          <EntryForm
            seed={seedBlank(date)}
            saveLabel="Save to today"
            cancelLabel="Discard"
            onSaved={(entry) => {
              setAddingManual(false)
              onEntrySaved(entry)
            }}
            onCancel={() => setAddingManual(false)}
          />
        </section>
      ) : (
        <button
          type="button"
          className="food-link-button"
          onClick={() => setAddingManual(true)}
        >
          + Add manually instead
        </button>
      )}
    </div>
  )
}

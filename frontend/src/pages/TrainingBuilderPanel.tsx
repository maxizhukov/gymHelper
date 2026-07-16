import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useExerciseLibrary, type LibraryExercise } from '../exercise-library'
import {
  addExercise,
  createDay,
  createTemplate,
  deleteDay,
  deleteTemplate,
  removeExercise,
  renameDay,
  renameTemplate,
  reorderExercises,
  useTemplate,
  useTemplates,
  type TemplateDay,
  type TemplateDayExercise,
} from '../training-builder'
import { startWorkoutFromTemplateDay } from '../workout'

/**
 * The Training Builder tab. Templates, their days, and the library exercises on
 * each day all live in Postgres; this component reads them back and re-reads the
 * open template after every edit, so the screen never drifts from the database.
 *
 * Exercises can only be added from the *active* library, removed (soft — history
 * is kept), reordered, and a day can be started as a workout.
 */
export default function TrainingBuilderPanel() {
  const { state: templates, reload: reloadTemplates } = useTemplates()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [newName, setNewName] = useState('')
  const [error, setError] = useState('')

  async function handleCreate() {
    const name = newName.trim()
    if (!name) return
    try {
      const created = await createTemplate(name)
      setNewName('')
      setError('')
      reloadTemplates()
      setSelectedId(created.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create template.')
    }
  }

  if (templates.status === 'loading') return <p className="subtitle">Loading…</p>
  if (templates.status === 'error') {
    return (
      <p className="error" role="alert">
        {templates.message}
      </p>
    )
  }
  if (templates.status === 'not-found') return null

  return (
    <div className="builder">
      <section className="builder-templates" aria-label="Templates">
        <div className="builder-create">
          <input
            className="builder-input"
            placeholder="New template name"
            value={newName}
            maxLength={120}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void handleCreate()
            }}
          />
          <button
            type="button"
            className="nav-button"
            onClick={() => void handleCreate()}
          >
            Add template
          </button>
        </div>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        {templates.data.length === 0 ? (
          <p className="subtitle">No templates yet. Create one above.</p>
        ) : (
          <ul className="builder-template-list">
            {templates.data.map((template) => (
              <li key={template.id}>
                <button
                  type="button"
                  className={`card builder-template-card${
                    template.id === selectedId ? ' builder-template-selected' : ''
                  }`}
                  onClick={() =>
                    setSelectedId((current) =>
                      current === template.id ? null : template.id,
                    )
                  }
                >
                  <span className="label">{template.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {selectedId !== null && (
        <TemplateEditor
          key={selectedId}
          templateId={selectedId}
          onDeleted={() => {
            setSelectedId(null)
            reloadTemplates()
          }}
          onRenamed={reloadTemplates}
        />
      )}
    </div>
  )
}

/** The open template: its name, its days, and everything editable on them. */
function TemplateEditor({
  templateId,
  onDeleted,
  onRenamed,
}: {
  templateId: number
  onDeleted: () => void
  onRenamed: () => void
}) {
  const { state, reload } = useTemplate(templateId)
  const library = useExerciseLibrary()
  const [dayName, setDayName] = useState('')
  const [error, setError] = useState('')

  async function act(action: () => Promise<unknown>, reloadList = false) {
    try {
      await action()
      setError('')
      reload()
      if (reloadList) onRenamed()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that.')
    }
  }

  async function handleAddDay() {
    const name = dayName.trim()
    if (!name) return
    await act(async () => {
      await createDay(templateId, name)
      setDayName('')
    })
  }

  if (state.status === 'loading') return <p className="subtitle">Loading…</p>
  if (state.status === 'not-found') return null
  if (state.status === 'error') {
    return (
      <p className="error" role="alert">
        {state.message}
      </p>
    )
  }

  const template = state.data
  const activeLibrary =
    library.status === 'ready' ? library.data : ([] as LibraryExercise[])

  return (
    <section className="builder-editor" aria-label={`Template ${template.name}`}>
      <header className="builder-editor-header">
        <InlineName
          value={template.name}
          label="template name"
          onSave={(name) => act(() => renameTemplate(templateId, name), true)}
        />
        <button
          type="button"
          className="builder-danger"
          onClick={() => {
            if (
              window.confirm(
                'Delete this template? Its days are removed, but your workout history is kept.',
              )
            ) {
              void deleteTemplate(templateId).then(onDeleted).catch(() => {})
            }
          }}
        >
          Delete template
        </button>
      </header>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="builder-create">
        <input
          className="builder-input"
          placeholder="New day name"
          value={dayName}
          maxLength={120}
          onChange={(event) => setDayName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void handleAddDay()
          }}
        />
        <button
          type="button"
          className="nav-button"
          onClick={() => void handleAddDay()}
        >
          Add day
        </button>
      </div>

      {template.days.length === 0 ? (
        <p className="subtitle">No days yet. Add one above.</p>
      ) : (
        <ul className="builder-day-list">
          {template.days.map((day) => (
            <DayCard
              key={day.id}
              day={day}
              library={activeLibrary}
              onChange={reload}
              onError={setError}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

/** One day: its name, its exercises (remove / reorder), an add picker, and Start. */
function DayCard({
  day,
  library,
  onChange,
  onError,
}: {
  day: TemplateDay
  library: LibraryExercise[]
  onChange: () => void
  onError: (message: string) => void
}) {
  const navigate = useNavigate()
  const [picked, setPicked] = useState('')
  const [starting, setStarting] = useState(false)

  async function act(action: () => Promise<unknown>) {
    try {
      await action()
      onError('')
      onChange()
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not save that.')
    }
  }

  /** Moves an exercise one place in the list and persists the new order. */
  async function move(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= day.exercises.length) return
    const ids = day.exercises.map((exercise) => exercise.id)
    ;[ids[index], ids[target]] = [ids[target], ids[index]]
    await act(() => reorderExercises(day.id, ids))
  }

  async function handleStart() {
    setStarting(true)
    try {
      const result = await startWorkoutFromTemplateDay(day.id)
      void navigate(`/workout/${result.workout.id}`)
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not start the workout.')
      setStarting(false)
    }
  }

  const alreadyOn = new Set(day.exercises.map((e) => e.exerciseLibraryId))
  const addable = library.filter((exercise) => !alreadyOn.has(exercise.id))

  return (
    <li className="card builder-day-card">
      <div className="builder-day-header">
        <InlineName
          value={day.name}
          label="day name"
          onSave={(name) => act(() => renameDay(day.id, name))}
        />
        <button
          type="button"
          className="builder-danger"
          onClick={() => {
            if (window.confirm('Delete this day? Your workout history is kept.')) {
              void act(() => deleteDay(day.id))
            }
          }}
        >
          Delete day
        </button>
      </div>

      {day.exercises.length === 0 ? (
        <p className="message">No exercises yet.</p>
      ) : (
        <ol className="builder-exercise-list">
          {day.exercises.map((exercise, index) => (
            <ExerciseRow
              key={exercise.id}
              exercise={exercise}
              first={index === 0}
              last={index === day.exercises.length - 1}
              onUp={() => void move(index, -1)}
              onDown={() => void move(index, 1)}
              onRemove={() => void act(() => removeExercise(day.id, exercise.id))}
            />
          ))}
        </ol>
      )}

      <div className="builder-create">
        <select
          className="builder-input"
          value={picked}
          onChange={(event) => setPicked(event.target.value)}
        >
          <option value="">Add exercise from library…</option>
          {addable.map((exercise) => (
            <option key={exercise.id} value={exercise.id}>
              {exercise.name}
              {exercise.muscleGroup ? ` — ${exercise.muscleGroup}` : ''}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="nav-button"
          disabled={!picked}
          onClick={() => {
            if (!picked) return
            const id = Number(picked)
            setPicked('')
            void act(() => addExercise(day.id, id))
          }}
        >
          Add
        </button>
      </div>

      <button
        type="button"
        className="workout-action"
        disabled={starting || day.exercises.length === 0}
        onClick={() => void handleStart()}
      >
        {starting ? 'Starting…' : 'Start workout'}
      </button>
    </li>
  )
}

/** One exercise row: its name, reorder controls, and remove. */
function ExerciseRow({
  exercise,
  first,
  last,
  onUp,
  onDown,
  onRemove,
}: {
  exercise: TemplateDayExercise
  first: boolean
  last: boolean
  onUp: () => void
  onDown: () => void
  onRemove: () => void
}) {
  return (
    <li className="builder-exercise-row">
      <span className="builder-exercise-name">{exercise.name}</span>
      <span className="builder-exercise-actions">
        <button
          type="button"
          className="builder-icon"
          aria-label={`Move ${exercise.name} up`}
          disabled={first}
          onClick={onUp}
        >
          ↑
        </button>
        <button
          type="button"
          className="builder-icon"
          aria-label={`Move ${exercise.name} down`}
          disabled={last}
          onClick={onDown}
        >
          ↓
        </button>
        <button
          type="button"
          className="builder-icon builder-icon-remove"
          aria-label={`Remove ${exercise.name}`}
          onClick={onRemove}
        >
          ✕
        </button>
      </span>
    </li>
  )
}

/**
 * A name shown as text until tapped, then an input with Save / Cancel. Keeps
 * renaming in place without a modal or a browser prompt.
 */
function InlineName({
  value,
  label,
  onSave,
}: {
  value: string
  label: string
  onSave: (name: string) => Promise<void> | void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  if (!editing) {
    return (
      <button
        type="button"
        className="builder-name"
        onClick={() => {
          setDraft(value)
          setEditing(true)
        }}
      >
        {value}
      </button>
    )
  }

  async function commit() {
    const name = draft.trim()
    if (name && name !== value) {
      await onSave(name)
    }
    setEditing(false)
  }

  return (
    <span className="builder-name-edit">
      <input
        className="builder-input"
        aria-label={label}
        value={draft}
        maxLength={120}
        autoFocus
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void commit()
          if (event.key === 'Escape') setEditing(false)
        }}
      />
      <button type="button" className="builder-icon" onClick={() => void commit()}>
        ✓
      </button>
      <button
        type="button"
        className="builder-icon"
        onClick={() => setEditing(false)}
      >
        ✕
      </button>
    </span>
  )
}

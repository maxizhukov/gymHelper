import { useEffect, useMemo, useRef, useState } from 'react'
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
import WorkoutPreview from './WorkoutPreview'

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
              templateName={template.name}
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
  templateName,
  day,
  library,
  onChange,
  onError,
}: {
  templateName: string
  day: TemplateDay
  library: LibraryExercise[]
  onChange: () => void
  onError: (message: string) => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  // Opening the preview creates nothing; the workout is started from there.
  const [previewOpen, setPreviewOpen] = useState(false)

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

  const alreadyOn = useMemo(
    () => new Set(day.exercises.map((e) => e.exerciseLibraryId)),
    [day.exercises],
  )

  if (previewOpen) {
    return (
      <li className="card builder-day-card">
        <WorkoutPreview
          templateName={templateName}
          day={day}
          onBack={() => setPreviewOpen(false)}
        />
      </li>
    )
  }

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

      {pickerOpen ? (
        <ExercisePicker
          library={library}
          alreadyOn={alreadyOn}
          onAdd={(id) => act(() => addExercise(day.id, id))}
          onClose={() => setPickerOpen(false)}
        />
      ) : (
        <button
          type="button"
          className="nav-button builder-add-toggle"
          onClick={() => setPickerOpen(true)}
        >
          + Add exercise
        </button>
      )}

      <button
        type="button"
        className="workout-action"
        disabled={day.exercises.length === 0}
        onClick={() => setPreviewOpen(true)}
      >
        Preview workout
      </button>
    </li>
  )
}

/** The most results the picker renders at once — enough to browse, few enough
 *  that a 376-row library never lands as one wall of DOM. */
const PICKER_LIMIT = 40

/** Distinct, sorted, non-empty values of one field across the given exercises. */
function distinct(
  exercises: LibraryExercise[],
  pick: (exercise: LibraryExercise) => string | null,
): string[] {
  const values = new Set<string>()
  for (const exercise of exercises) {
    const value = pick(exercise)
    if (value) values.add(value)
  }
  return [...values].sort((a, b) => a.localeCompare(b))
}

/**
 * The exercise picker for one day: a searchable, filterable list of library
 * movements not already on the day. Search matches name, category, or muscle
 * group; the category and muscle-group selects narrow further. Only a capped
 * slice is shown, so the full catalogue never renders at once.
 */
function ExercisePicker({
  library,
  alreadyOn,
  onAdd,
  onClose,
}: {
  library: LibraryExercise[]
  alreadyOn: Set<number>
  onAdd: (exerciseLibraryId: number) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [muscleGroup, setMuscleGroup] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  // Focus search the moment the picker opens, so the keyboard is ready to type.
  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  const available = useMemo(
    () => library.filter((exercise) => !alreadyOn.has(exercise.id)),
    [library, alreadyOn],
  )

  const categories = useMemo(
    () => distinct(available, (exercise) => exercise.category),
    [available],
  )
  // Muscle-group options follow the chosen category so the two stay coherent.
  const muscleGroups = useMemo(
    () =>
      distinct(
        category ? available.filter((e) => e.category === category) : available,
        (exercise) => exercise.muscleGroup,
      ),
    [available, category],
  )

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return available.filter((exercise) => {
      if (category && exercise.category !== category) return false
      if (muscleGroup && exercise.muscleGroup !== muscleGroup) return false
      if (!needle) return true
      return [exercise.name, exercise.category, exercise.muscleGroup]
        .filter((part): part is string => Boolean(part))
        .some((part) => part.toLowerCase().includes(needle))
    })
  }, [available, query, category, muscleGroup])

  const shown = filtered.slice(0, PICKER_LIMIT)

  return (
    <div className="builder-picker">
      <div className="builder-picker-head">
        <input
          ref={searchRef}
          className="builder-input"
          type="search"
          placeholder="Search exercises…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="builder-picker-filters">
          <select
            className="builder-input"
            aria-label="Filter by category"
            value={category}
            onChange={(event) => {
              setCategory(event.target.value)
              setMuscleGroup('')
            }}
          >
            <option value="">All categories</option>
            {categories.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <select
            className="builder-input"
            aria-label="Filter by muscle group"
            value={muscleGroup}
            onChange={(event) => setMuscleGroup(event.target.value)}
          >
            <option value="">All muscles</option>
            {muscleGroups.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
      </div>

      {available.length === 0 ? (
        <p className="message builder-picker-empty">
          Every library exercise is already on this day.
        </p>
      ) : shown.length === 0 ? (
        <p className="message builder-picker-empty">
          No exercises match your search.
        </p>
      ) : (
        <>
          <ul className="builder-picker-list">
            {shown.map((exercise) => (
              <li key={exercise.id} className="builder-picker-row">
                {exercise.thumbnailUrl ? (
                  <img
                    className="builder-picker-thumb"
                    src={exercise.thumbnailUrl}
                    alt=""
                    loading="lazy"
                  />
                ) : (
                  <span className="builder-picker-thumb builder-picker-thumb-empty" aria-hidden="true" />
                )}
                <span className="builder-picker-info">
                  <span className="builder-picker-name">{exercise.name}</span>
                  <span className="builder-picker-meta">
                    {[exercise.category, exercise.muscleGroup]
                      .filter((part): part is string => Boolean(part))
                      .join(' · ')}
                  </span>
                </span>
                <button
                  type="button"
                  className="builder-icon builder-picker-add"
                  aria-label={`Add ${exercise.name}`}
                  onClick={() => onAdd(exercise.id)}
                >
                  +
                </button>
              </li>
            ))}
          </ul>
          {filtered.length > shown.length && (
            <p className="builder-picker-note">
              Showing first {shown.length} of {filtered.length}. Refine your
              search to narrow down.
            </p>
          )}
        </>
      )}

      <button
        type="button"
        className="nav-button builder-picker-done"
        onClick={onClose}
      >
        Done
      </button>
    </div>
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

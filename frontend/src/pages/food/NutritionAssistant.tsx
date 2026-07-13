import { useState } from 'react'
import { askAssistant } from '../../food'

/**
 * A compact, collapsible chat card for the Food tab. The user asks nutrition
 * questions in plain language and the server-side assistant answers using their
 * own logged food, targets and history — the OpenAI key never reaches the
 * browser. Messages live only in this component's transient state; nothing here
 * is a source of truth, so they clear on reload.
 */

type ChatMessage = {
  id: number
  role: 'user' | 'assistant'
  text: string
  suggestions?: string[]
}

/** Tap-to-ask starters shown before the first question. */
const QUICK_QUESTIONS = [
  'What should I eat next?',
  'What am I missing today?',
  'Suggest a dinner',
  'How is my week going?',
]

export default function NutritionAssistant({ date }: { date: string | null }) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [nextId, setNextId] = useState(1)

  async function ask(text: string) {
    const message = text.trim()
    if (!message || loading) return
    setError('')
    setInput('')
    const userId = nextId
    setMessages((prev) => [...prev, { id: userId, role: 'user', text: message }])
    setNextId((id) => id + 1)
    setLoading(true)
    try {
      const reply = await askAssistant(message, date)
      setMessages((prev) => [
        ...prev,
        {
          id: userId + 1,
          role: 'assistant',
          text: reply.answer,
          suggestions: reply.suggestions,
        },
      ])
      setNextId((id) => id + 1)
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not reach the assistant.',
      )
    } finally {
      setLoading(false)
    }
  }

  // Suggestions to offer as chips: the latest assistant follow-ups if we have
  // any, otherwise the starter questions.
  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m.role === 'assistant')
  const chips =
    lastAssistant?.suggestions && lastAssistant.suggestions.length > 0
      ? lastAssistant.suggestions
      : messages.length === 0
        ? QUICK_QUESTIONS
        : []

  return (
    <section className="food-assistant">
      <button
        type="button"
        className="food-assistant-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="food-assistant-toggle-label">
          <span aria-hidden="true">✨</span> Ask Nutrition Assistant
        </span>
        <span className="food-assistant-chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open && (
        <div className="food-assistant-body">
          {messages.length === 0 && (
            <p className="food-assistant-intro">
              Ask about today’s plan, what you’re missing, or a meal idea. Answers
              use your own logged food and targets.
            </p>
          )}

          {messages.length > 0 && (
            <div className="food-assistant-thread">
              {messages.map((m) => (
                <div
                  key={m.id}
                  className={`food-assistant-bubble food-assistant-${m.role}`}
                >
                  {m.text}
                </div>
              ))}
              {loading && (
                <div className="food-assistant-bubble food-assistant-assistant food-assistant-thinking">
                  Thinking…
                </div>
              )}
            </div>
          )}

          {error && (
            <p className="error food-assistant-error" role="alert">
              {error}
            </p>
          )}

          {chips.length > 0 && (
            <div className="food-assistant-chips">
              {chips.map((q) => (
                <button
                  key={q}
                  type="button"
                  className="food-assistant-chip"
                  onClick={() => ask(q)}
                  disabled={loading}
                >
                  {q}
                </button>
              ))}
            </div>
          )}

          <form
            className="food-assistant-input"
            onSubmit={(e) => {
              e.preventDefault()
              ask(input)
            }}
          >
            <input
              type="text"
              value={input}
              placeholder="Ask the nutrition assistant…"
              onChange={(e) => setInput(e.target.value)}
              disabled={loading}
              aria-label="Message the nutrition assistant"
            />
            <button
              type="submit"
              className="nav-button food-button-small"
              disabled={loading || input.trim().length === 0}
            >
              {loading ? 'Thinking…' : 'Ask'}
            </button>
          </form>

          <p className="food-assistant-note">
            General nutrition guidance only — not medical advice.
          </p>
        </div>
      )}
    </section>
  )
}

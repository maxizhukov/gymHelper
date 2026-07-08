import { useEffect, useState } from 'react'
import './App.css'

type Status = 'loading' | 'ok' | 'error'

function App() {
  const [message, setMessage] = useState('')
  const [status, setStatus] = useState<Status>('loading')

  useEffect(() => {
    const controller = new AbortController()

    fetch('/api/message', { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`Request failed: ${res.status}`)
        return res.json() as Promise<{ message: string }>
      })
      .then((data) => {
        setMessage(data.message)
        setStatus('ok')
      })
      .catch((err) => {
        if (err.name === 'AbortError') return
        console.error(err)
        setStatus('error')
      })

    return () => controller.abort()
  }, [])

  return (
    <main className="app">
      <h1>🏋️ GymHelper</h1>
      <p className="subtitle">Frontend ↔ Backend connectivity check</p>

      <div className={`card status-${status}`}>
        {status === 'loading' && <p>Contacting the backend…</p>}
        {status === 'ok' && (
          <>
            <p className="label">Message from NestJS:</p>
            <p className="message">{message}</p>
          </>
        )}
        {status === 'error' && (
          <p>
            Could not reach the backend. Is it running on{' '}
            <code>http://localhost:3000</code>?
          </p>
        )}
      </div>
    </main>
  )
}

export default App

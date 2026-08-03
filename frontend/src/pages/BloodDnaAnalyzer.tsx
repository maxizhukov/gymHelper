import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import BackHeader from '../components/BackHeader'
import './BloodDnaAnalyzer.css'

/**
 * Blood DNA Analyzer — a hidden, purely-cosmetic "lab scanner" screen reached
 * from Profile → Blood DNA Analyzer. Nothing here talks to the backend: the
 * whole flow is client-side theatre driven by timers and random generation,
 * so it never violates the app's "all real data lives in PostgreSQL" rule.
 *
 * Behaviour:
 *  - Short tap on "Start Analysis" → ~4–5s fake scan, then random ancestry
 *    with Ukrainian pinned to 90–99% and the rest spread over 2–4 ethnicities.
 *  - Long press (>1s) → same animation, but a fixed Jewish 90% / Ukrainian 10%.
 */

type Slice = { name: string; pct: number; color: string }
type Mode = 'idle' | 'scanning' | 'done'

const SCAN_MESSAGES = [
  'Collecting sample…',
  'Sequencing DNA…',
  'Comparing genomes…',
  'Calculating ancestry…',
]

const OTHER_ETHNICITIES = [
  'Belarusian',
  'Polish',
  'Tatar',
  'Lithuanian',
  'Slovak',
  'Hungarian',
  'Romanian',
  'German',
  'Czech',
  'Jewish',
  'Russian',
]

/** Distinct-enough swatches; Ukrainian always gets the signature indigo. */
const SLICE_COLORS = [
  '#8b7dff',
  '#35e6ff',
  '#4be0a8',
  '#ffb27d',
  '#ff6b6b',
  '#c792ff',
]

const randInt = (min: number, max: number) =>
  Math.floor(Math.random() * (max - min + 1)) + min

/** Fisher–Yates over a copy, so the source list is left untouched. */
function shuffled<T>(list: T[]): T[] {
  const copy = [...list]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

/**
 * Build the ancestry breakdown. Ukrainian sits at 90–99%; the remainder is
 * split across 2–4 other ethnicities, each getting at least 1%, always summing
 * to exactly 100. When `forced` is set we return the fixed easter-egg result.
 */
function generateResult(forced: boolean): Slice[] {
  if (forced) {
    return [
      { name: 'Jewish', pct: 90, color: SLICE_COLORS[4] },
      { name: 'Ukrainian', pct: 10, color: SLICE_COLORS[0] },
    ]
  }

  const ukrainian = randInt(90, 99)
  let remaining = 100 - ukrainian // 1–10

  // Never ask for more buckets than there are points to hand out.
  const count = Math.min(randInt(2, 4), remaining)
  const shares = new Array(count).fill(1)
  remaining -= count
  while (remaining > 0) {
    shares[randInt(0, count - 1)] += 1
    remaining -= 1
  }

  const picks = shuffled(OTHER_ETHNICITIES).slice(0, count)
  const others = picks.map((name, i) => ({
    name,
    pct: shares[i],
    color: SLICE_COLORS[(i + 1) % SLICE_COLORS.length],
  }))
  // Show the biggest contributors first for a tidy result list.
  others.sort((a, b) => b.pct - a.pct)

  return [{ name: 'Ukrainian', pct: ukrainian, color: SLICE_COLORS[0] }, ...others]
}

/** Best-effort haptic tick; silently a no-op where vibration isn't supported. */
function haptic(pattern: number | number[]) {
  try {
    navigator.vibrate?.(pattern)
  } catch {
    /* ignore — haptics are a nicety, never required */
  }
}

const VITAL_DEFS = [
  { key: 'hgb', label: 'Hemoglobin', unit: 'g/dL', min: 132, max: 168, scale: 10 },
  { key: 'rbc', label: 'RBC', unit: 'M/µL', min: 42, max: 58, scale: 10 },
  { key: 'wbc', label: 'WBC', unit: 'K/µL', min: 40, max: 110, scale: 10 },
  { key: 'plt', label: 'Platelets', unit: 'K/µL', min: 150, max: 400, scale: 1 },
  { key: 'o2', label: 'SpO₂', unit: '%', min: 960, max: 1000, scale: 10 },
  { key: 'bpm', label: 'Heart rate', unit: 'bpm', min: 60, max: 92, scale: 1 },
] as const

type Vitals = Record<string, number>

const rollVitals = (): Vitals =>
  Object.fromEntries(
    VITAL_DEFS.map((v) => [v.key, randInt(v.min, v.max) / v.scale]),
  )

export default function BloodDnaAnalyzer() {
  const navigate = useNavigate()

  const [mode, setMode] = useState<Mode>('idle')
  const [progress, setProgress] = useState(0)
  const [message, setMessage] = useState(SCAN_MESSAGES[0])
  const [vitals, setVitals] = useState<Vitals>(rollVitals)
  const [holding, setHolding] = useState(false)
  const [result, setResult] = useState<Slice[]>([])
  const [barsIn, setBarsIn] = useState(false)
  const [report, setReport] = useState<{
    id: string
    durationMs: number
    at: string
  } | null>(null)

  // Timer/handle bookkeeping so we can always tear down cleanly on unmount.
  const rafRef = useRef<number | null>(null)
  const vitalsTimer = useRef<number | null>(null)
  const holdTimer = useRef<number | null>(null)
  const pressStart = useRef<number>(0)
  const forcedRef = useRef(false)

  const clearTimers = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    if (vitalsTimer.current !== null) window.clearInterval(vitalsTimer.current)
    rafRef.current = null
    vitalsTimer.current = null
  }, [])

  useEffect(() => {
    return () => {
      clearTimers()
      if (holdTimer.current !== null) window.clearTimeout(holdTimer.current)
    }
  }, [clearTimers])

  // Let the result cards mount at width 0, then fill on the next frame so the
  // percentage bars visibly animate in rather than snapping to their value.
  useEffect(() => {
    if (mode !== 'done') {
      setBarsIn(false)
      return
    }
    const id = requestAnimationFrame(() => setBarsIn(true))
    return () => cancelAnimationFrame(id)
  }, [mode])

  const runScan = useCallback(
    (forced: boolean) => {
      clearTimers()
      forcedRef.current = forced
      setMode('scanning')
      setProgress(0)
      setMessage(SCAN_MESSAGES[0])
      haptic(forced ? [40, 60, 40] : 40)

      const total = randInt(4000, 5000)
      const startedAt = performance.now()
      let lastPhase = 0

      // Live medical readouts flicker on their own cadence while scanning.
      vitalsTimer.current = window.setInterval(() => {
        setVitals(rollVitals())
      }, 220)

      const tick = (now: number) => {
        const elapsed = now - startedAt
        const pct = Math.min(100, (elapsed / total) * 100)
        setProgress(pct)

        const phase = Math.min(
          SCAN_MESSAGES.length - 1,
          Math.floor((pct / 100) * SCAN_MESSAGES.length),
        )
        if (phase !== lastPhase) {
          lastPhase = phase
          setMessage(SCAN_MESSAGES[phase])
          haptic(15)
        }

        if (elapsed >= total) {
          clearTimers()
          const slices = generateResult(forcedRef.current)
          setResult(slices)
          setReport({
            id: `BX-${randInt(100000, 999999)}-${randInt(10, 99)}`,
            durationMs: Math.round(elapsed),
            at: new Date().toLocaleString(),
          })
          setProgress(100)
          setMode('done')
          haptic([60, 40, 120])
          return
        }
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)
    },
    [clearTimers],
  )

  // ── Start button: distinguish a short tap from a >1s long press ──────────
  const onPressStart = () => {
    if (mode === 'scanning') return
    pressStart.current = performance.now()
    setHolding(false)
    // Arm the long-press affordance; a light buzz confirms the hold "took".
    holdTimer.current = window.setTimeout(() => {
      setHolding(true)
      haptic(30)
    }, 1000)
  }

  const onPressEnd = () => {
    if (mode === 'scanning') return
    if (holdTimer.current !== null) {
      window.clearTimeout(holdTimer.current)
      holdTimer.current = null
    }
    if (pressStart.current === 0) return
    const held = performance.now() - pressStart.current
    pressStart.current = 0
    setHolding(false)
    runScan(held >= 1000)
  }

  const onPressCancel = () => {
    if (holdTimer.current !== null) {
      window.clearTimeout(holdTimer.current)
      holdTimer.current = null
    }
    pressStart.current = 0
    setHolding(false)
  }

  const reset = () => {
    clearTimers()
    setMode('idle')
    setProgress(0)
    setResult([])
    setReport(null)
    setMessage(SCAN_MESSAGES[0])
    haptic(20)
  }

  // Conic-gradient stops for the results donut, in the ancestry list order.
  const donutGradient = (() => {
    let acc = 0
    const stops = result.map((s) => {
      const from = acc
      acc += s.pct
      return `${s.color} ${from}% ${acc}%`
    })
    return `conic-gradient(${stops.join(', ')})`
  })()

  return (
    <div className="screen">
      <BackHeader title="Blood DNA Analyzer" onBack={() => void navigate(-1)} />
      <div className="screen-scroll has-header">
        <div className="bda">
          <div className="bda-eyebrow">
            <span className="bda-live-dot" aria-hidden="true" />
            {mode === 'scanning'
              ? 'Analyzing sample'
              : mode === 'done'
                ? 'Analysis complete'
                : 'Genomic sequencer online'}
          </div>

          {mode !== 'done' && (
            <>
              <div
                className={`bda-scanner${
                  mode === 'scanning' ? ' is-active' : ''
                }`}
              >
                <span className="bda-reticle" aria-hidden="true" />
                <span className="bda-reticle inner" aria-hidden="true" />
                {mode === 'scanning' && (
                  <span className="bda-scanline" aria-hidden="true" />
                )}
                <div className="bda-scanner-core">
                  {mode === 'scanning' ? (
                    <>
                      <div className="bda-scanner-pct">
                        {Math.round(progress)}%
                      </div>
                      <div className="bda-scanner-label">Scanning</div>
                    </>
                  ) : (
                    <>
                      <div className="bda-scanner-label">Ready</div>
                    </>
                  )}
                </div>
              </div>

              {/* ECG heartbeat trace */}
              <div className="bda-ecg" aria-hidden="true">
                <svg viewBox="0 0 300 56" preserveAspectRatio="none">
                  <path
                    className="bda-ecg-path"
                    d="M0 28 H60 l6 -18 l8 34 l6 -16 H120 l6 -20 l8 36 l6 -16 H180 l6 -18 l8 34 l6 -16 H240 l6 -20 l8 36 l6 -16 H300"
                  />
                </svg>
                {mode === 'scanning' && <span className="bda-ecg-sweep" />}
              </div>

              {/* DNA helix */}
              <div className="bda-helix" aria-hidden="true">
                {Array.from({ length: 9 }).map((_, i) => (
                  <div key={i} className="bda-helix-strand">
                    <span
                      className="bda-helix-dot"
                      style={{ animationDelay: `${-i * 0.18}s` }}
                    />
                    <span
                      className="bda-helix-dot alt"
                      style={{ animationDelay: `${-i * 0.18 - 0.9}s` }}
                    />
                  </div>
                ))}
              </div>

              {mode === 'scanning' ? (
                <>
                  <div className="bda-status" role="status">
                    {message}
                  </div>
                  <div
                    className="bda-progress"
                    role="progressbar"
                    aria-valuenow={Math.round(progress)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div
                      className="bda-progress-fill"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                  <div className="bda-vitals">
                    {VITAL_DEFS.map((v) => (
                      <div key={v.key} className="bda-vital">
                        <div className="bda-vital-label">{v.label}</div>
                        <div className="bda-vital-value">
                          {vitals[v.key]}
                          <span>{v.unit}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className={`bda-start${holding ? ' is-holding' : ''}`}
                    onPointerDown={onPressStart}
                    onPointerUp={onPressEnd}
                    onPointerLeave={onPressCancel}
                    onPointerCancel={onPressCancel}
                    onContextMenu={(e) => e.preventDefault()}
                  >
                    Start Analysis
                    <small>{holding ? 'Deep scan armed' : 'Tap to begin'}</small>
                  </button>
                  <p className="bda-hint">
                    Place fingertip on the sensor. Hold for a deep genomic scan.
                  </p>
                </>
              )}
            </>
          )}

          {mode === 'done' && report && (
            <div className="bda-result">
              <div className="bda-success">
                <span className="bda-success-dot" aria-hidden="true" />
                Analysis completed successfully
              </div>

              <div
                className="bda-donut"
                style={{ background: donutGradient }}
                aria-hidden="true"
              >
                <div className="bda-donut-center">
                  <div>
                    <strong>{result[0]?.pct}%</strong>
                    <br />
                    <span>{result[0]?.name}</span>
                  </div>
                </div>
              </div>

              <div className="bda-cards">
                {result.map((s) => (
                  <div key={s.name} className="bda-card">
                    <div className="bda-card-head">
                      <span className="bda-card-name">
                        <span
                          className="bda-card-swatch"
                          style={{ background: s.color }}
                        />
                        {s.name}
                      </span>
                      <span className="bda-card-pct">{s.pct}%</span>
                    </div>
                    <div className="bda-card-bar">
                      <div
                        className="bda-card-bar-fill"
                        style={{
                          width: barsIn ? `${s.pct}%` : 0,
                          background: s.color,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>

              <dl className="bda-report">
                <div>
                  <dt>Report ID</dt>
                  <dd>{report.id}</dd>
                </div>
                <div>
                  <dt>Scan duration</dt>
                  <dd>{(report.durationMs / 1000).toFixed(1)}s</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd style={{ color: 'var(--bda-green, #4be0a8)' }}>Verified</dd>
                </div>
                <div>
                  <dt>Completed</dt>
                  <dd>{report.at}</dd>
                </div>
              </dl>

              <button type="button" className="btn-primary" onClick={reset}>
                Analyze Again
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

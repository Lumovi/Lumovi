/**
 * The loaded lines over time: a bar for each round step (a minute, five, fifteen, an hour…), its
 * errors and warnings at its foot. Dragging over it picks a stretch, and the lines are filtered to
 * it. Counted in a worker: until it has said, the strip waits empty.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { cn } from '@renderer/lib/cn'
import type { LogLine } from '@renderer/lib/logs'
import type { CountAnswer, CountRequest } from './histogram.worker'

/** A stretch of time picked on the strip: from, and up to (not including) to, in ms. */
export interface Stretch {
  from: number
  to: number
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** Each step a bar can be, and the step its times are written at under it. */
const STEPS: [step: number, labels: number][] = [
  [MINUTE, 15 * MINUTE],
  [5 * MINUTE, HOUR],
  [15 * MINUTE, 3 * HOUR],
  [HOUR, 6 * HOUR],
  [3 * HOUR, 12 * HOUR],
  [6 * HOUR, DAY],
  [DAY, 7 * DAY],
]
/** The most bars: the step is the smallest round one that gives no more. */
const MOST_BARS = 60
/** The shortest span the strip is drawn for. */
export const LEAST_SPAN = 2 * MINUTE

/** The steps over a span: where the first bar starts (on a round time, the person's own), how long each is, and how many. */
export function barsOf(first: number, last: number) {
  const [step, labels] = STEPS.find(([step]) => (last - first) / step < MOST_BARS) ?? STEPS.at(-1)!
  const zone = -new Date(first).getTimezoneOffset() * MINUTE
  const start = Math.floor((first + zone) / step) * step - zone
  return { start, step, labels, zone, bars: Math.floor((last - start) / step) + 1 }
}

const pad = (n: number) => String(n).padStart(2, '0')
const clock = (at: number) => {
  const time = new Date(at)
  return `${pad(time.getHours())}:${pad(time.getMinutes())}`
}
const dayOf = (at: number) =>
  new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })

/** What a stretch's chip says: "14:02–14:09". */
export const stretchSaid = ({ from, to }: Stretch) => `${clock(from)}–${clock(to)}`

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`

export function Histogram({
  lines,
  stretch,
  onStretch,
}: {
  lines: readonly LogLine[]
  stretch: Stretch | undefined
  onStretch: (stretch: Stretch | undefined) => void
}) {
  const first = lines[0]?.at ?? Number.NaN
  const last = lines.at(-1)?.at ?? Number.NaN
  const drawn = last - first >= LEAST_SPAN
  const { start, step, labels, zone, bars } = drawn
    ? barsOf(first, last)
    : { start: 0, step: MINUTE, labels: HOUR, zone: 0, bars: 0 }

  const [worker] = useState(
    () => new Worker(new URL('./histogram.worker.ts', import.meta.url), { type: 'module' }),
  )
  useEffect(() => () => worker.terminate(), [worker])
  const [counts, setCounts] = useState<CountAnswer>()
  const asked = useRef(0)
  useEffect(() => {
    const heard = ({ data }: MessageEvent<CountAnswer>) => {
      if (data.id === asked.current) setCounts(data)
    }
    worker.addEventListener('message', heard)
    return () => worker.removeEventListener('message', heard)
  }, [worker])
  useEffect(() => {
    if (!drawn) return
    const ats = new Float64Array(lines.length)
    const levels = new Uint8Array(lines.length)
    lines.forEach((line, i) => {
      ats[i] = line.at
      levels[i] = line.level === 'error' ? 2 : line.level === 'warn' ? 1 : 0
    })
    const request: CountRequest = { id: ++asked.current, ats, levels, start, step, bars }
    worker.postMessage(request, { transfer: [ats.buffer, levels.buffer] })
  }, [worker, lines, drawn, start, step, bars])

  const strip = useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = useState<number>()
  const [dragging, setDragging] = useState<{ from: number; to: number }>()
  const [cursor, setCursor] = useState<number>()
  const [anchor, setAnchor] = useState<number>()
  const [focused, setFocused] = useState(false)

  if (!drawn) return null
  const fresh = counts && counts.all.length === bars ? counts : undefined
  const most = fresh ? Math.max(1, ...fresh.all) : 1
  const barAt = (event: PointerEvent) => {
    const box = strip.current!.getBoundingClientRect()
    return Math.min(
      bars - 1,
      Math.max(0, Math.floor(((event.clientX - box.left) / box.width) * bars)),
    )
  }
  const pick = (a: number, b: number) => {
    const [low, high] = a <= b ? [a, b] : [b, a]
    onStretch({ from: start + low * step, to: start + (high + 1) * step })
  }
  const said = (bar: number) => {
    const at = start + bar * step
    const parts = [step >= DAY ? dayOf(at) : clock(at)]
    if (fresh) {
      parts.push(plural(fresh.all[bar]!, 'line', 'lines'))
      if (fresh.errors[bar]) parts.push(plural(fresh.errors[bar], 'error', 'errors'))
      if (fresh.warnings[bar]) parts.push(plural(fresh.warnings[bar], 'warning', 'warnings'))
    }
    return parts.join(' · ')
  }
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = cursor ?? bars - 1
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const next = Math.min(bars - 1, Math.max(0, at + (event.key === 'ArrowLeft' ? -1 : 1)))
      if (event.shiftKey) setAnchor(anchor ?? at)
      else setAnchor(undefined)
      setCursor(next)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      pick(anchor ?? at, at)
      setAnchor(undefined)
    } else if (event.key === 'Escape' && stretch) {
      event.stopPropagation()
      onStretch(undefined)
    }
  }
  /** Bars shown as picked: being dragged or chosen by key, or the stretch that filters. */
  const chosen = dragging
    ? [Math.min(dragging.from, dragging.to), Math.max(dragging.from, dragging.to)]
    : anchor !== undefined && cursor !== undefined
      ? [Math.min(anchor, cursor), Math.max(anchor, cursor)]
      : stretch
        ? [Math.floor((stretch.from - start) / step), Math.ceil((stretch.to - start) / step) - 1]
        : undefined
  const marks: number[] = []
  for (let bar = 0; bar < bars; bar++) {
    if ((start + bar * step + zone) % labels === 0) marks.push(bar)
  }
  const tip = hovered ?? (focused ? cursor : undefined)

  return (
    <div className="relative shrink-0 border-b border-line px-5 pt-1 pb-0.5">
      <div
        ref={strip}
        role="group"
        tabIndex={0}
        aria-label="Lines over time: pick a stretch with Shift and the arrow keys, then Enter"
        onKeyDown={keyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onPointerDown={(event) => {
          strip.current!.setPointerCapture(event.pointerId)
          const bar = barAt(event)
          setDragging({ from: bar, to: bar })
        }}
        onPointerMove={(event) => {
          const bar = barAt(event)
          setHovered(bar)
          if (dragging) setDragging({ ...dragging, to: bar })
        }}
        onPointerUp={() => {
          if (dragging) pick(dragging.from, dragging.to)
          setDragging(undefined)
        }}
        onPointerLeave={() => setHovered(undefined)}
        className="relative flex h-8 cursor-crosshair items-end gap-px rounded-sm outline-offset-2"
      >
        {Array.from({ length: bars }, (_, bar) => {
          const all = fresh?.all[bar] ?? 0
          const errors = fresh?.errors[bar] ?? 0
          const warnings = fresh?.warnings[bar] ?? 0
          return (
            <div
              key={bar}
              aria-label={said(bar)}
              data-bar={bar}
              className={cn(
                'flex h-full min-w-0 flex-1 flex-col-reverse',
                cursor === bar && 'outline outline-1 outline-accent',
              )}
            >
              <div
                className="flex flex-col-reverse overflow-hidden rounded-t-[1px] bg-ink-3/45"
                style={{ height: `${(all / most) * 100}%` }}
              >
                {errors > 0 && (
                  <div className="bg-critical" style={{ height: `${(errors / all) * 100}%` }} />
                )}
                {warnings > 0 && (
                  <div className="bg-warn" style={{ height: `${(warnings / all) * 100}%` }} />
                )}
              </div>
            </div>
          )
        })}
        {chosen && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 border-x border-accent bg-accent-soft"
            style={{
              left: `${(Math.max(0, chosen[0]!) / bars) * 100}%`,
              width: `${((Math.min(bars - 1, chosen[1]!) - Math.max(0, chosen[0]!) + 1) / bars) * 100}%`,
            }}
          />
        )}
      </div>
      <div aria-hidden className="relative h-3.5 text-[10px] leading-3.5 text-ink-3 tabular-nums">
        {marks.map((bar) => (
          <span
            key={bar}
            className="absolute -translate-x-1/2"
            style={{ left: `${(bar / bars) * 100}%` }}
          >
            {labels >= DAY ? dayOf(start + bar * step) : clock(start + bar * step)}
          </span>
        ))}
      </div>
      {tip !== undefined && (
        <div
          role="tooltip"
          className="pointer-events-none absolute bottom-full z-10 mb-1 -translate-x-1/2 rounded-md bg-ink-1 px-2 py-1 text-xs whitespace-nowrap text-surface shadow-pop"
          style={{ left: `calc(1.25rem + (100% - 2.5rem) * ${(tip + 0.5) / bars})` }}
        >
          {said(tip)}
        </div>
      )}
    </div>
  )
}

import { useId, useState, type PointerEvent } from 'react'
import { percent } from '@renderer/lib/format'

const WIDTH = 240
const HEIGHT = 48
const PAD = 5

/**
 * A single-series trend line (2px stroke, ~10% area wash, end dot with a
 * surface ring) with a crosshair readout on hover.
 */
export function Sparkline({
  values,
  times,
  label,
}: {
  /** Ratios between 0 and 1. */
  values: number[]
  times: number[]
  label: string
}) {
  const [hover, setHover] = useState<number | null>(null)
  const gradient = useId()
  const x = (i: number) => PAD + (i / (values.length - 1)) * (WIDTH - PAD * 2)
  const y = (v: number) => HEIGHT - PAD - Math.min(1, v) * (HEIGHT - PAD * 2)
  const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(v)}`).join(' ')
  const area = `${line} L${x(values.length - 1)},${HEIGHT} L${x(0)},${HEIGHT} Z`
  const last = values.length - 1

  const onMove = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientX - box.left) / box.width
    setHover(Math.round(Math.min(1, Math.max(0, ratio)) * last))
  }

  return (
    <div className="relative">
      <svg
        role="img"
        aria-label={`${label} trend, now ${percent(values[last]!)}`}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="h-12 w-full overflow-visible text-accent"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="currentColor" stopOpacity={0.22} />
            <stop offset="1" stopColor="currentColor" stopOpacity={0} />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${gradient})`} />
        <path
          d={line}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {hover !== null && (
          <line
            x1={x(hover)}
            x2={x(hover)}
            y1={0}
            y2={HEIGHT}
            stroke="var(--text-3)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      <span
        aria-hidden
        className="pointer-events-none absolute size-2.5 -translate-1/2 rounded-full bg-accent ring-2 ring-surface-2"
        style={{
          left: `${(x(hover ?? last) / WIDTH) * 100}%`,
          top: `${(y(values[hover ?? last]!) / HEIGHT) * 100}%`,
        }}
      />
      {hover !== null && (
        <div
          role="tooltip"
          className="pointer-events-none absolute -top-9 -translate-x-1/2 rounded-md bg-ink-1 px-2 py-1 text-xs whitespace-nowrap text-surface shadow-pop"
          style={{ left: `${(x(hover) / WIDTH) * 100}%` }}
        >
          <span className="font-semibold">{percent(values[hover]!)}</span>
          <span className="ml-1.5 opacity-70">{new Date(times[hover]!).toLocaleTimeString()}</span>
        </div>
      )}
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import type { Unit } from '@renderer/lib/promql'
import { formatValue, niceTicks } from './scale'

export interface Bin {
  from: number
  to: number
}

const TOP = 10
const AXIS_BAND = 24
const BAR_MAX = 24

/**
 * How values spread: how many things fall in each band of round numbers.
 * Each band is a button that picks it (to filter by), with a tooltip.
 */
export function Histogram({
  label,
  values,
  unit,
  noun,
  selected,
  onSelect,
  height = 180,
}: {
  label: string
  values: number[]
  unit: Unit
  /** What is counted, plural: "pods". */
  noun: string
  selected?: Bin
  onSelect: (bin: Bin | undefined) => void
  height?: number
}) {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width))
    observer.observe(box.current!)
    return () => observer.disconnect()
  }, [])

  const edges = niceTicks(
    Math.max(...values),
    unit,
    Math.min(14, Math.max(5, Math.ceil(Math.sqrt(values.length)))),
  )
  // Bands from 0 in equal steps; a value on the top edge belongs to the last band.
  const band = edges[1]! - edges[0]!
  const bins = edges.slice(1).map((to, i) => ({ from: edges[i]!, to, count: 0 }))
  for (const value of values) bins[Math.min(bins.length - 1, Math.floor(value / band))]!.count++
  const countTicks = niceTicks(Math.max(...bins.map((b) => b.count)), 'count', 3)
  const yMax = countTicks.at(-1)!
  const left = Math.max(...countTicks.map((t) => String(t).length)) * 6.6 + 16
  // Room on the right for the last edge's label.
  const plotWidth = Math.max(1, width - left - 22)
  const plotBottom = height - AXIS_BAND
  const slot = plotWidth / bins.length
  const barWidth = Math.min(BAR_MAX, slot * 0.7)
  const y = (count: number) => plotBottom - (count / yMax) * (plotBottom - TOP)
  const isSelected = (bin: Bin) => selected?.from === bin.from && selected.to === bin.to
  const describe = (bin: (typeof bins)[number]) =>
    `${bin.count} ${noun} from ${formatValue(bin.from, unit)} to ${formatValue(bin.to, unit)}`

  return (
    <div ref={box} role="group" aria-label={label} className="relative" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} aria-hidden className="block">
          {countTicks.map((tick, i) => (
            <g key={tick}>
              <line
                x1={left}
                x2={left + plotWidth}
                y1={y(tick)}
                y2={y(tick)}
                stroke={i === 0 ? 'var(--line-strong)' : 'var(--line)'}
              />
              <text
                x={left - 8}
                y={y(tick)}
                dy="0.32em"
                textAnchor="end"
                className="fill-ink-3 text-[11px] tabular-nums"
              >
                {tick}
              </text>
            </g>
          ))}
          {bins.map((bin, i) => {
            const x = left + slot * i + (slot - barWidth) / 2
            const top = y(bin.count)
            const r = Math.min(4, barWidth / 2, plotBottom - top)
            return (
              <path
                key={bin.from}
                d={`M${x},${plotBottom}V${top + r}Q${x},${top} ${x + r},${top}H${x + barWidth - r}Q${x + barWidth},${top} ${x + barWidth},${top + r}V${plotBottom}Z`}
                fill="var(--series-1)"
                opacity={selected && !isSelected(bin) ? 0.3 : hover === i ? 0.85 : 1}
                className="transition-opacity duration-150"
              />
            )
          })}
          {edges.map((edge, i) =>
            // Every other edge when bands are narrow, so labels don't collide.
            slot < 56 && i % 2 === 1 ? null : (
              <text
                key={edge}
                x={left + slot * i}
                y={plotBottom + 16}
                textAnchor="middle"
                className="fill-ink-3 text-[11px] tabular-nums"
              >
                {formatValue(edge, unit)}
              </text>
            ),
          )}
        </svg>
      )}
      {bins.map((bin, i) => (
        <button
          key={bin.from}
          type="button"
          aria-label={describe(bin)}
          aria-pressed={isSelected(bin)}
          disabled={bin.count === 0}
          onClick={() => onSelect(isSelected(bin) ? undefined : bin)}
          onMouseEnter={() => setHover(i)}
          onMouseLeave={() => setHover(null)}
          onFocus={() => setHover(i)}
          onBlur={() => setHover(null)}
          className="absolute rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default"
          style={{ left: left + slot * i, width: slot, top: TOP, height: plotBottom - TOP }}
        />
      ))}
      {hover !== null && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-10 rounded-lg border border-line-strong bg-surface-2 px-3 py-2 text-xs whitespace-nowrap shadow-pop"
          style={{
            left: Math.min(left + slot * (hover + 1) + 6, Math.max(0, width - 200)),
            top: TOP,
          }}
        >
          <span className="font-semibold text-ink-1 tabular-nums">{bins[hover]!.count}</span>{' '}
          <span className="text-ink-2">
            {noun} · {formatValue(bins[hover]!.from, unit)}–{formatValue(bins[hover]!.to, unit)}
          </span>
        </div>
      )}
    </div>
  )
}

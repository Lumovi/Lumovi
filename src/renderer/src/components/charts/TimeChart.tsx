import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { cn } from '@renderer/lib/cn'
import type { Unit } from '@renderer/lib/promql'
import { formatMoment, formatTick, formatValue, niceTicks, timeTicks } from './scale'

export interface ChartSeries {
  key: string
  label: string
  /** A CSS color, like var(--series-1). */
  color: string
  /** One per time; null where there is no sample. */
  values: (number | null)[]
}

/** A threshold drawn across the plot: requests, limits, allocatable capacity. */
export interface ChartReference {
  label: string
  value: number
}

export type ChartKind = 'lines' | 'stacked' | 'bars'

const TOP = 12
const RIGHT = 14
const AXIS_BAND = 24
const BAR_MAX = 24
const GAP = 2

/** A path through values, broken where there are none. */
function linePath(values: (number | null)[], x: (i: number) => number, y: (v: number) => number) {
  let d = ''
  let open = false
  values.forEach((v, i) => {
    if (v === null) {
      open = false
      return
    }
    d += `${open ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`
    open = true
  })
  return d
}

/** A bar with a rounded data end and a square baseline. */
function columnPath(left: number, top: number, width: number, height: number, rounded: boolean) {
  const r = rounded ? Math.min(4, width / 2, height) : 0
  const bottom = top + height
  return `M${left},${bottom}V${top + r}Q${left},${top} ${left + r},${top}H${left + width - r}Q${left + width},${top} ${left + width},${top + r}V${bottom}Z`
}

/**
 * A time-series chart: lines, stacked areas, or stacked columns (for counts
 * per bucket). Hovering or arrowing through it reads every series at that
 * time; dragging across it zooms in; the legend shows, hides and isolates
 * series. Text uses ink colors; only marks wear series colors.
 */
export function TimeChart({
  label,
  times,
  series,
  unit,
  kind,
  references = [],
  height,
  onZoom,
  stale,
}: {
  label: string
  times: number[]
  series: ChartSeries[]
  unit: Unit
  kind: ChartKind
  references?: ChartReference[]
  height: number
  /** Called with the window dragged across the plot; without it, there's no zooming. */
  onZoom?: (from: number, to: number) => void
  /** Shown dimmed: older data, while newer loads. */
  stale: boolean
}) {
  const tooltipId = useId()
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const [focused, setFocused] = useState<string | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null)

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width))
    observer.observe(box.current!)
    return () => observer.disconnect()
  }, [])

  const visible = series.filter((s) => !hidden.has(s.key))
  const n = times.length
  const stacking = kind !== 'lines'
  // Running totals per time, bottom series first.
  const stacks: number[][] = []
  for (const s of visible) {
    const below = stacks.at(-1)
    stacks.push(s.values.map((v, i) => (below ? below[i]! : 0) + (stacking ? (v ?? 0) : 0)))
  }
  const dataPeak = Math.max(
    0,
    ...(stacking
      ? (stacks.at(-1) ?? [])
      : visible.flatMap((s) => s.values.filter((v): v is number => v !== null))),
  )
  // A threshold far above the data would flatten it; it's noted at the top instead.
  // From the top down, labels go above and below their lines in turn, so neighbors' part ways.
  const onScale = references
    .filter((r) => r.value <= dataPeak * 3)
    .sort((a, b) => b.value - a.value)
  const offScale = references.filter((r) => r.value > dataPeak * 3)
  const peak = Math.max(dataPeak, ...onScale.map((r) => r.value))
  const yTicks = niceTicks(peak, unit)
  const yMax = yTicks.at(-1)!
  const tickLabels = yTicks.map((t) => formatValue(t, unit))
  const left = Math.max(30, Math.max(...tickLabels.map((t) => t.length)) * 6.6 + 12)
  const plotWidth = Math.max(1, width - left - RIGHT)
  const plotBottom = height - AXIS_BAND
  const plotHeight = plotBottom - TOP
  const slot = plotWidth / Math.max(1, n)
  const x = (i: number) =>
    kind === 'bars' ? left + slot * (i + 0.5) : left + (i / (n - 1)) * plotWidth
  const y = (v: number) => plotBottom - (v / yMax) * plotHeight
  const indexAt = (px: number) =>
    Math.max(
      0,
      Math.min(
        n - 1,
        kind === 'bars'
          ? Math.floor((px - left) / slot)
          : Math.round(((px - left) / plotWidth) * (n - 1)),
      ),
    )
  // Time labels stay clear of the plot's edges, where they would be cut off.
  const span = times[n - 1]! - times[0]!
  const edge = (span * 22) / plotWidth
  const { ticks: xTicks, step: xStep } = timeTicks(
    times[0]! + edge,
    times[n - 1]! - edge,
    Math.max(2, Math.floor(plotWidth / 90)),
  )
  const xOf = (time: number) =>
    kind === 'bars'
      ? left + ((time - times[0]!) / (span / (n - 1)) + 0.5) * slot
      : left + ((time - times[0]!) / span) * plotWidth

  const pointer = (event: PointerEvent<SVGSVGElement>) =>
    event.clientX - event.currentTarget.getBoundingClientRect().left

  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || !onZoom) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setDrag({ from: pointer(event), to: pointer(event) })
  }
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const px = pointer(event)
    setHover(indexAt(px))
    if (drag) setDrag({ ...drag, to: px })
  }
  const onPointerUp = () => {
    if (!drag) return
    setDrag(null)
    const [a, b] = [indexAt(Math.min(drag.from, drag.to)), indexAt(Math.max(drag.from, drag.to))]
    // A click, or a sliver, isn't a zoom.
    if (b - a >= 2) onZoom!(times[a]!, times[b]!)
  }
  const onKeyDown = (event: KeyboardEvent) => {
    const moves: Record<string, (i: number) => number> = {
      ArrowLeft: (i) => i - 1,
      ArrowRight: (i) => i + 1,
      Home: () => 0,
      End: () => n - 1,
    }
    if (event.key === 'Escape' && hover !== null) {
      event.preventDefault()
      setHover(null)
      return
    }
    const move = moves[event.key]
    if (!move) return
    event.preventDefault()
    setHover(Math.max(0, Math.min(n - 1, move(hover ?? n - 1))))
  }

  // What the tooltip reads at the hovered time, largest first.
  const rows =
    hover === null
      ? []
      : visible
          .map((s) => ({ s, value: s.values[hover] ?? null }))
          .filter((r): r is { s: ChartSeries; value: number } => r.value !== null)
          .sort((a, b) => b.value - a.value)
  const total = rows.reduce((sum, r) => sum + r.value, 0)
  const flip = hover !== null && x(hover) > left + plotWidth * 0.62

  const dim = (key: string) => focused !== null && focused !== key

  return (
    <div className={cn('transition-opacity duration-300', stale && 'opacity-55')}>
      <div
        ref={box}
        tabIndex={0}
        role="group"
        aria-label={`${label}. Arrow keys read values${onZoom ? '; drag to zoom' : ''}.`}
        aria-describedby={hover !== null ? tooltipId : undefined}
        onKeyDown={onKeyDown}
        onBlur={() => setHover(null)}
        className="relative rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent"
        style={{ height }}
      >
        {width > 0 && (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={label}
            className={cn('block select-none', onZoom && 'cursor-crosshair')}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={() => setHover(null)}
          >
            {yTicks.map((tick, i) => (
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
                  {tickLabels[i]}
                </text>
              </g>
            ))}
            {xTicks.map((tick) => (
              <text
                key={tick}
                x={xOf(tick)}
                y={plotBottom + 16}
                textAnchor="middle"
                className="fill-ink-3 text-[11px] tabular-nums"
              >
                {formatTick(tick, xStep)}
              </text>
            ))}

            {kind === 'bars' && hover !== null && (
              <rect
                x={x(hover) - slot / 2}
                y={TOP}
                width={slot}
                height={plotHeight}
                className="fill-surface-3"
              />
            )}

            {kind === 'lines' &&
              visible.map((s) => (
                <path
                  key={s.key}
                  d={linePath(s.values, x, y)}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  opacity={dim(s.key) ? 0.18 : 1}
                  className="transition-opacity duration-150"
                />
              ))}

            {kind === 'stacked' &&
              visible.map((s, i) => {
                const top = stacks[i]!
                const bottom = stacks[i - 1]
                const area =
                  top
                    .map((v, k) => `${k === 0 ? 'M' : 'L'}${x(k).toFixed(1)},${y(v).toFixed(1)}`)
                    .join('') +
                  top
                    .map((_, k) => n - 1 - k)
                    .map((k) => `L${x(k).toFixed(1)},${y(bottom ? bottom[k]! : 0).toFixed(1)}`)
                    .join('') +
                  'Z'
                return (
                  <g
                    key={s.key}
                    opacity={dim(s.key) ? 0.25 : 1}
                    className="transition-opacity duration-150"
                  >
                    <path d={area} fill={s.color} fillOpacity={0.14} />
                    <path
                      d={linePath(top, x, y)}
                      fill="none"
                      stroke={s.color}
                      strokeWidth={2}
                      strokeLinejoin="round"
                    />
                  </g>
                )
              })}

            {kind === 'bars' &&
              times.map((_, k) => {
                const barWidth = Math.max(1, Math.min(BAR_MAX, slot - GAP))
                const parts = visible
                  .map((s, i) => ({ s, from: stacks[i - 1]?.[k] ?? 0, to: stacks[i]![k]! }))
                  .filter((p) => p.to > p.from)
                return parts.map((p, j) => {
                  const height = Math.max(0, y(p.from) - y(p.to) - (j > 0 ? GAP : 0))
                  return (
                    <path
                      key={`${p.s.key}/${k}`}
                      d={columnPath(
                        x(k) - barWidth / 2,
                        y(p.to),
                        barWidth,
                        height,
                        j === parts.length - 1,
                      )}
                      fill={p.s.color}
                      opacity={dim(p.s.key) ? 0.25 : 1}
                    />
                  )
                })
              })}

            {offScale.map((reference, i) => (
              <text
                key={reference.label}
                x={left + 6}
                y={TOP + 10 + i * 14}
                className="fill-ink-3 text-[10.5px] font-medium"
              >
                ↑ {reference.label} {formatValue(reference.value, unit)}, above the chart
              </text>
            ))}
            {onScale.map((reference, i) => (
              <g key={reference.label}>
                <line
                  x1={left}
                  x2={left + plotWidth}
                  y1={y(reference.value)}
                  y2={y(reference.value)}
                  stroke="var(--text-3)"
                  strokeDasharray="4 3"
                />
                <text
                  x={left + plotWidth}
                  y={y(reference.value)}
                  dy={i % 2 === 0 ? -5 : 12}
                  textAnchor="end"
                  stroke="var(--surface-2)"
                  strokeWidth={3}
                  paintOrder="stroke"
                  className="fill-ink-2 text-[10.5px] font-medium"
                >
                  {reference.label} {formatValue(reference.value, unit)}
                </text>
              </g>
            ))}

            {hover !== null && kind !== 'bars' && (
              <g pointerEvents="none">
                <line x1={x(hover)} x2={x(hover)} y1={TOP} y2={plotBottom} stroke="var(--text-3)" />
                {visible.map((s, i) => {
                  if (s.values[hover] === null) return null
                  return (
                    <circle
                      key={s.key}
                      cx={x(hover)}
                      cy={y(kind === 'stacked' ? stacks[i]![hover]! : s.values[hover]!)}
                      r={4}
                      fill={s.color}
                      stroke="var(--surface-2)"
                      strokeWidth={2}
                    />
                  )
                })}
              </g>
            )}

            {drag && Math.abs(drag.to - drag.from) > 2 && (
              <rect
                x={Math.max(left, Math.min(drag.from, drag.to))}
                y={TOP}
                width={Math.abs(drag.to - drag.from)}
                height={plotHeight}
                className="fill-accent-soft stroke-accent"
                strokeOpacity={0.4}
              />
            )}
          </svg>
        )}

        {hover !== null && (
          <div
            id={tooltipId}
            role="tooltip"
            className="pointer-events-none absolute z-10 min-w-40 rounded-lg border border-line-strong bg-surface-2 px-3 py-2 shadow-pop"
            style={
              flip ? { right: width - x(hover) + 14, top: TOP } : { left: x(hover) + 14, top: TOP }
            }
          >
            <p className="mb-1.5 text-2xs font-medium text-ink-3">
              {formatMoment(times[hover]!, times[n - 1]! - times[0]!)}
            </p>
            {rows.length === 0 ? (
              <p className="text-xs text-ink-3">No data</p>
            ) : (
              <ul className="space-y-1">
                {rows.map(({ s, value }) => (
                  <li key={s.key} className="flex items-center gap-2 text-xs whitespace-nowrap">
                    <span
                      aria-hidden
                      className="h-0.5 w-3 shrink-0 rounded-full"
                      style={{ background: s.color }}
                    />
                    <span className="font-semibold text-ink-1 tabular-nums">
                      {formatValue(value, unit)}
                    </span>
                    <span className="max-w-56 truncate text-ink-2">{s.label}</span>
                  </li>
                ))}
                {stacking && rows.length > 1 && (
                  <li className="flex items-center gap-2 border-t border-line pt-1 text-xs">
                    <span aria-hidden className="w-3" />
                    <span className="font-semibold text-ink-1 tabular-nums">
                      {formatValue(total, unit)}
                    </span>
                    <span className="text-ink-2">Total</span>
                  </li>
                )}
              </ul>
            )}
          </div>
        )}
      </div>

      {series.length > 1 && (
        <Legend
          kind={kind}
          series={series}
          hidden={hidden}
          onHidden={setHidden}
          onFocus={setFocused}
        />
      )}
    </div>
  )
}

function Legend({
  kind,
  series,
  hidden,
  onHidden,
  onFocus,
}: {
  kind: ChartKind
  series: ChartSeries[]
  hidden: ReadonlySet<string>
  onHidden: (hidden: ReadonlySet<string>) => void
  onFocus: (key: string | null) => void
}) {
  const only = (key: string) => new Set(series.map((s) => s.key).filter((k) => k !== key))
  const isolated = (key: string) => !hidden.has(key) && hidden.size === series.length - 1
  return (
    <div
      role="group"
      aria-label="Series"
      className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1"
      onMouseLeave={() => onFocus(null)}
    >
      {series.map((s) => (
        <button
          key={s.key}
          type="button"
          aria-pressed={!hidden.has(s.key)}
          title="Click to show or hide; Alt-click to show only this"
          onClick={(event) => {
            if (event.altKey || event.metaKey || event.shiftKey) {
              onHidden(isolated(s.key) ? new Set() : only(s.key))
              return
            }
            const next = new Set(hidden)
            if (next.has(s.key)) next.delete(s.key)
            else next.add(s.key)
            onHidden(next)
          }}
          onMouseEnter={() => onFocus(s.key)}
          onFocus={() => onFocus(s.key)}
          onBlur={() => onFocus(null)}
          className="flex min-w-0 items-center gap-1.5 rounded-md py-0.5 text-xs text-ink-2 transition-opacity hover:text-ink-1 aria-[pressed=false]:opacity-40"
        >
          <span
            aria-hidden
            className={cn(
              'shrink-0',
              kind === 'lines' ? 'h-0.5 w-3 rounded-full' : 'size-2.5 rounded-[3px]',
            )}
            style={{ background: s.color }}
          />
          <span className="max-w-56 truncate">{s.label}</span>
        </button>
      ))}
      {hidden.size > 0 && (
        <button
          type="button"
          onClick={() => onHidden(new Set())}
          className="text-xs font-medium text-accent-strong hover:underline"
        >
          Show all
        </button>
      )}
    </div>
  )
}

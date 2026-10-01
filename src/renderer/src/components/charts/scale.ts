import { formatBytes } from '@renderer/lib/format'
import type { Unit } from '@renderer/lib/promql'

const count = new Intl.NumberFormat()

/** CPU the way Kubernetes writes it: "250m" below a core, "1.5" above. */
export function formatCores(cores: number): string {
  if (cores === 0) return '0'
  if (cores < 1) return `${Number((cores * 1000).toPrecision(3))}m`
  return String(Number(cores.toFixed(2)))
}

export function formatValue(value: number, unit: Unit): string {
  switch (unit) {
    case 'cores':
      return formatCores(value)
    case 'bytes':
      return formatBytes(value)
    case 'bytesPerSecond':
      return `${formatBytes(value)}/s`
    case 'count':
      // Increases are extrapolated, so whole events can come out as 0.98.
      return count.format(Math.round(value))
  }
}

/**
 * Round ticks from 0 to just above `max`: binary multiples for bytes
 * (0, 256 MiB, 512 MiB…), whole numbers for counts.
 */
export function niceTicks(max: number, unit: Unit, target = 4): number[] {
  const binary = unit === 'bytes' || unit === 'bytesPerSecond'
  const top = max > 0 ? max : 1
  const base = binary ? 1024 ** Math.max(0, Math.floor(Math.log(top) / Math.log(1024))) : 1
  const raw = top / base / target
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  let step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw)!
  if (unit === 'count') step = Math.max(1, Math.ceil(step))
  const ticks = [0]
  while (ticks.at(-1)! < top / base - 1e-9) ticks.push(ticks.length * step)
  return ticks.map((tick) => tick * base)
}

// The last step fits any span, so one is always found.
const TIME_STEPS = [
  60,
  300,
  600,
  900,
  1_800,
  3_600,
  7_200,
  10_800,
  21_600,
  43_200,
  86_400,
  172_800,
  604_800,
  Number.MAX_SAFE_INTEGER,
]

/** Times for axis labels, on round local-time boundaries, at most `max` of them. */
export function timeTicks(
  start: number,
  end: number,
  max: number,
): { ticks: number[]; step: number } {
  const span = (end - start) / 1000
  const step = TIME_STEPS.find((s) => span / s <= max)! * 1000
  // Align to local midnight-based boundaries: shift by the time zone offset.
  const offset = new Date(start).getTimezoneOffset() * 60_000
  const ticks: number[] = []
  for (let t = Math.ceil((start - offset) / step) * step + offset; t <= end; t += step)
    ticks.push(t)
  return { ticks, step }
}

export function formatTick(time: number, step: number): string {
  return step >= 86_400_000
    ? new Date(time).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })
    : new Date(time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/** A moment in a tooltip: the time, and the day when the window spans several. */
export function formatMoment(time: number, span: number): string {
  return new Date(time).toLocaleString(undefined, {
    ...(span > 86_400_000 ? { weekday: 'short', day: 'numeric', month: 'short' } : {}),
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Average, peak and latest of a series, ignoring gaps. */
export function summarize(
  values: (number | null)[],
): { avg: number; max: number; last: number } | undefined {
  const present = values.filter((v): v is number => v !== null)
  if (present.length === 0) return undefined
  return {
    avg: present.reduce((sum, v) => sum + v, 0) / present.length,
    max: Math.max(...present),
    last: values.findLast((v): v is number => v !== null)!,
  }
}

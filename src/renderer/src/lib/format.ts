const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']

/** Compact, kubectl-style age: 42s, 5m, 3h, 12d, 2y. */
export function age(timestamp: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return days < 365 ? `${days}d` : `${Math.floor(days / 365)}y`
}

/** Cores as millicores below one core ("250m"), otherwise as cores ("2.4"). */
export function formatCpu(cores: number): string {
  return cores < 1 ? `${Math.round(cores * 1000)}m` : `${Number(cores.toFixed(2))}`
}

export function formatBytes(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit++
  }
  const rounded = value >= 100 ? Math.round(value) : Number(value.toFixed(1))
  return `${rounded} ${BYTE_UNITS[unit]}`
}

export function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

export function formatDateTime(timestamp: string): string {
  return new Date(timestamp).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

export function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

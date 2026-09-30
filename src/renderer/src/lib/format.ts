const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']

/** Durations the way kubectl prints them: 42s, 5m3s, 47m, 3h12m, 20h, 2d4h, 88d, 2y70d. */
export function age(timestamp: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1000))
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (seconds < 120) return `${seconds}s`
  if (minutes < 10) return `${minutes}m${seconds % 60}s`
  if (minutes < 180) return `${minutes}m`
  if (hours < 8) return `${hours}h${minutes % 60}m`
  if (hours < 48) return `${hours}h`
  if (days < 8) return `${days}d${hours % 24}h`
  if (days < 730) return `${days}d`
  return `${Math.floor(days / 365)}y${days % 365}d`
}

/** CPU in cores: "0", "<1m", "250m", "2.4". */
export function formatCpu(cores: number): string {
  if (cores === 0) return '0'
  if (cores >= 1) return `${Number(cores.toFixed(1))}`
  const millicores = Math.round(cores * 1000)
  return millicores === 0 ? '<1m' : `${millicores}m`
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

/** The host of an API server URL, for display; the raw value if it isn't a URL. */
export function hostOf(server: string | undefined): string | undefined {
  if (!server) return undefined
  try {
    return new URL(server).host
  } catch {
    return server
  }
}

/**
 * Chromium's own log of its network (`--log-net-log=<file>`), read once the browser has closed:
 * which of the tries' names (catchers.ts's `nameFor`) it asked its resolver for, and which it
 * names anywhere at all. A request refused before it leaves is nowhere in it; one let through
 * asks for its host's name first, and that's an event here whether or not anything was sent.
 */
import { readFileSync } from 'node:fs'

interface NetLog {
  constants: { logEventTypes: Record<string, number> }
  events: { type: number; params?: unknown }[]
}

export interface Named {
  /** How many events the log holds. */
  events: number
  /** The tries whose name the resolver was asked for, each once, in order. */
  lookedUp: string[]
  /** The tries whose name is in any event of the log. */
  anywhere: string[]
}

const NAME = /([a-z0-9-]+)\.tried\.localhost/g

/**
 * The log as Chromium wrote it. One that was cut short (a browser stopped before it closed the
 * file) is read as far as it goes: its events are a line each, in the order they happened, so
 * what's there is true, and a caller that asked for a name of its own last knows by that name
 * whether the log goes far enough.
 */
function read(file: string): NetLog {
  const text = readFileSync(file, 'utf8')
  try {
    return JSON.parse(text) as NetLog
  } catch {
    return JSON.parse(`${text.trimEnd().replace(/,$/, '')}]}`) as NetLog
  }
}

/** Reads a log that was kept: one that was never written, or holds no event, fails here. */
export function namedIn(file: string): Named {
  const log = read(file)
  const resolver = new Set(
    Object.entries(log.constants.logEventTypes)
      .filter(([name]) => name.startsWith('HOST_RESOLVER') || name.includes('DNS'))
      .map(([, type]) => type),
  )
  if (resolver.size === 0) throw new Error('The log names no event of a resolver’s.')
  if (log.events.length === 0) throw new Error('The log holds no event.')
  const lookedUp = new Set<string>()
  const anywhere = new Set<string>()
  for (const event of log.events) {
    if (event.params === undefined) continue
    for (const [, id] of JSON.stringify(event.params).matchAll(NAME)) {
      anywhere.add(id!)
      if (resolver.has(event.type)) lookedUp.add(id!)
    }
  }
  return { events: log.events.length, lookedUp: [...lookedUp], anywhere: [...anywhere] }
}

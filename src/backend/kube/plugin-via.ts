/**
 * Which plugin's page brought the person to something of Lumovi's (a shell, a forward, a pod's
 * logs shown on its page), as the backend knows that plugin: its own label and version, found
 * by the name the page gave. A name of no plugin Lumovi has in use says nothing. It grants and
 * changes nothing; it says, in the history, how the person got there.
 */
import { PLUGIN_NAME } from '@shared/plugins'

/** A plugin Lumovi has in use, by its name, as the backend reads it. */
export type PluginLookup = (
  name: string,
) => Promise<{ label?: string; version: string } | undefined>

export interface Via {
  /** The history's own keys for it, as a plugin's change and its read of a Secret have them. */
  details: { plugin: string; pluginVersion: string }
  /** The name a person reads it by. */
  label: string
}

export async function knownVia(
  lookup: PluginLookup | undefined,
  said: unknown,
): Promise<Via | undefined> {
  const name = (said as { plugin?: unknown } | null | undefined)?.plugin
  if (typeof name !== 'string' || !PLUGIN_NAME.test(name)) return undefined
  const known = await lookup?.(name).catch(() => undefined)
  if (!known) return undefined
  return { details: { plugin: name, pluginVersion: known.version }, label: known.label ?? name }
}

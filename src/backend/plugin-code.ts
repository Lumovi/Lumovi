/**
 * The hand-over, decided where the page can't change it: in the main process, or on the server.
 * `mayHandOver` is the one answer to "may this page be handed this plugin's code", and
 * `pluginCode` the one way any plugin's code reaches a page. A page that's handed it runs it in
 * the plugin's box; nothing else hands code over.
 *
 * What it asks, in order: a plugin Lumovi has in use whose code it runs (only its own: a folder's
 * file is data); one that has code; that no switch turns its code off (the organization's policy,
 * a server's administrator, the person's own: `codeOff`); and on a server, that this session is held to coming from
 * Lumovi's own page (the second wall), and that this browser has passed Lumovi's check that it
 * keeps a plugin's code apart (`box-check`), for the box's walls as they are now.
 */
import {
  ALL_CODE_ON,
  codeOff,
  type CodeSwitches,
  type NotHanded,
  type PluginCode,
} from '@shared/plugin-hand-over'
import { mayCarryCode } from '@shared/plugin-loading'
import { PLUGIN_NAME, whose } from '@shared/plugins'
import type { KnownPlugin } from '@shared/plugins-known'
import type { Recorder } from './audit/recorder'

/**
 * Where a page is: a window of the desktop app's; or a browser of a server's, with whether its
 * session is held to Lumovi's own page and whether it passed the box's check.
 */
export type HandOverTo =
  | { host: 'desktop'; switches?: CodeSwitches }
  | {
      host: 'server'
      /** What turns plugins' code off for this person on this server, now. */
      switches?: CodeSwitches
      held: boolean
      /** How Lumovi's check of this browser's box came out, if it has been checked. */
      check?: 'passed' | 'failed' | 'unfinished'
      /** Unfinished because a look couldn't be made: no use checking again in this browser. */
      unlooked?: boolean
    }

/** Whether a page there may be handed `plugin`'s code: yes, or why not. */
export function mayHandOver(
  plugin: Readonly<KnownPlugin> | undefined,
  to: HandOverTo,
): true | NotHanded {
  if (!plugin || !mayCarryCode(plugin.origin)) return 'not-in-use'
  if (plugin.code === undefined || plugin.codeDigest === undefined) return 'no-code'
  // (Before any browser's check: code that's turned off is never asked about, nor handed.)
  const off = codeOff(plugin.name, to.switches ?? ALL_CODE_ON)
  if (off) return off
  if (to.host === 'desktop') return true
  // Anywhere else is a server's browser, and held only by exactly these: whatever isn't one of
  // them, or isn't said as a yes, is no.
  if (to.host !== 'server' || to.held !== true) return 'not-held'
  return to.check === 'passed'
    ? true
    : to.check === 'failed'
      ? 'check-failed'
      : to.check === 'unfinished'
        ? // (One that couldn't look is no use running again: this browser can't look.)
          to.unlooked === true
          ? 'check-unlooked'
          : 'check-unfinished'
        : 'not-checked'
}

export interface CodeHandOver {
  /** The plugins in use, as the backend reads them now. */
  known: () => Promise<readonly Readonly<KnownPlugin>[]>
  /** Where the page that asks is, now. */
  to: () => HandOverTo
  audit: Recorder
}

/**
 * The page's two calls: `code` (`IPC.pluginCode`), the only one that hands code over; and
 * `whether` (`IPC.pluginHandOver`), what it would answer, without the code, for a page that only
 * says so (the Plugins page).
 */
export function pluginCodes({ known, to, audit }: CodeHandOver) {
  /** What's been handed to this page's window or browser: recorded once, plugin by digests. */
  const handed = new Set<string>()
  const decided = async (
    name: unknown,
  ): Promise<{ plugin: Readonly<KnownPlugin> } | { refused: NotHanded }> => {
    // (Lumovi's own page asks by a plugin's name: anything else names no plugin in use.)
    if (typeof name !== 'string' || !PLUGIN_NAME.test(name)) return { refused: 'not-in-use' }
    const plugin = (await known()).find((p) => p.name === name)
    const may = mayHandOver(plugin, to())
    return may === true ? { plugin: plugin! } : { refused: may }
  }
  return {
    async code(name: unknown): Promise<PluginCode> {
      const decision = await decided(name)
      if ('refused' in decision) return { ok: false, refused: decision.refused }
      const { plugin } = decision
      const where = to().host === 'desktop' ? 'window' : 'browser'
      const key = JSON.stringify([plugin.name, plugin.digest, plugin.codeDigest])
      if (!handed.has(key)) {
        handed.add(key)
        audit.record({
          action: 'plugin.code',
          outcome: 'success',
          target: { kind: 'Plugin', name: plugin.name },
          summary: `Handed the plugin ${whose(plugin.name)} code to this ${where}`,
          details: {
            plugin: plugin.name,
            pluginVersion: plugin.version,
            pluginDigest: plugin.digest,
            codeDigest: plugin.codeDigest!,
          },
        })
      }
      return { ok: true, code: plugin.code!, digest: plugin.digest, codeDigest: plugin.codeDigest! }
    },
    async whether(name: unknown): Promise<true | NotHanded> {
      const decision = await decided(name)
      return 'refused' in decision ? decision.refused : true
    },
  }
}

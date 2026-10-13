/**
 * A link on a plugin's page to one of Lumovi's own places for an object (`ReachDestination`):
 * whether Lumovi offers that place where the person is, and how Lumovi says where it goes. The
 * plugin names the button; the icon and the tooltip are Lumovi's, from the object the door
 * handed, never from the plugin's words.
 */
import { ArrowLeftRight, ScrollText, SquareTerminal, type LucideIcon } from 'lucide-react'
import type { Reach, ReachDestination } from '@shared/kit/declare'
import { api } from '@renderer/lib/api'
import type { Layout } from '@renderer/lib/layout'

/** Lumovi's icon for each place: so "Shell into primary" and "Logs" can't be dressed as each other. */
export const REACH_ICONS: Readonly<Record<Reach, LucideIcon>> = {
  logs: ScrollText,
  shell: SquareTerminal,
  'port-forward': ArrowLeftRight,
}

/**
 * Whether Lumovi has that place where the person is: Logs anywhere; a shell not on a phone, as
 * Lumovi's own Shell tab isn't; a forward only where Lumovi forwards ports (the desktop app), and
 * not on a phone. A link to a place Lumovi doesn't have there isn't drawn.
 */
export function offered(at: Reach, layout: Layout): boolean {
  if (at === 'logs') return true
  if (layout === 'phone') return false
  return at === 'shell' || api.forwards !== undefined
}

/** Where a link goes, in Lumovi's words: its tooltip, and what a screen reader adds to its name. */
export function reachTip({ at, object, port }: ReachDestination): string {
  const named = `${object.kind} ${object.namespace ? `${object.namespace}/` : ''}${object.name}`
  return at === 'port-forward'
    ? `Opens Port forward for ${named}${port !== undefined ? `, port ${port}` : ''}`
    : `Opens ${named} at its ${at === 'logs' ? 'Logs' : 'Shell'} tab`
}

/**
 * What a plugin is granted, said one permission a line, in the Plugins page's own sentences: so a
 * permission reads the same on the page, in the install dialog, and after. Each line is drawn
 * from what it grants (`Granted`), so a dialog's "New in" and "No longer" say exactly what
 * changed.
 */
import {
  Code,
  Eye,
  KeyRound,
  Link2,
  ListTree,
  PanelsTopLeft,
  Pencil,
  Play,
  PlusSquare,
  ScrollText,
  Server,
  type LucideIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'
import type { Asks } from '@shared/plugin-asks'
import { apiKindOf } from '@shared/resources'
import type { Granted } from './granted'
import { linksLine, listed, LOGS_LINE, proposesLine, type KindNames } from './proposes'
import { ServerPaths, serverSays, ServerWhere } from './server-line'

export { listed, proposesLine, type KindNames }

const mono = (text: string) => (
  <span className="font-mono text-xs text-ink-1 selectable">{text}</span>
)

/** One permission, said. */
export interface AskLine {
  key: string
  icon: LucideIcon
  text: ReactNode
  /** Said under it, quieter. */
  note?: ReactNode
  /**
   * What reaches its code that can hold anything at all (containers' logs it reads): red, and
   * first under what's new.
   */
  red?: true
}

/**
 * Each permission `granted` holds, as a line: its code first, then what it may change, what it
 * reads, what it adds to Lumovi's pages, and its actions.
 */
export function askLines(granted: Granted, names: KindNames, tool: string): AskLine[] {
  const { asks: a, added, opens, links, logs } = granted
  const lines: AskLine[] = []
  if (granted.code) {
    lines.push({
      key: 'code',
      icon: Code,
      text: 'Draws its pages with its own code, which runs in Lumovi’s sealed box and is handed only what’s listed here.',
    })
  }
  // What its code reads that can hold anything: right after its code (and first, when new).
  if (logs === 'read') {
    const { text, note } = LOGS_LINE.read
    lines.push({ key: 'logs', icon: ScrollText, text, note, red: true })
  }
  // Its tool's own server: what it answers reaches its code too.
  if (granted.server) {
    lines.push({
      key: 'server',
      icon: Server,
      text: serverSays(granted.server),
      note: (
        <>
          <ServerWhere server={granted.server} />
          <ServerPaths paths={granted.server.paths} />
        </>
      ),
      red: true,
    })
  }
  if (a.changes.length > 0) {
    lines.push({ key: 'proposes', icon: Pencil, text: proposesLine(a.changes, names) })
  }
  if (a.kinds.length > 0 && a.actions.length > 0) {
    lines.push({
      key: 'kinds',
      icon: Pencil,
      text: <>Only the kinds it shows: {mono(a.kinds.map(names.bare).join(', '))}</>,
      ...(a.groups.length > 0
        ? { note: `all in the API groups it names: ${a.groups.join(', ')}` }
        : {}),
    })
  }
  if (a.creates.length > 0) {
    lines.push({
      key: 'creates',
      icon: PlusSquare,
      text: `Creates: ${listed(a.creates.map(names.bare))}, ${a.creates.length === 1 ? 'one' : 'each one'} of its own kinds.`,
    })
  }
  if (a.shows.length > 0) {
    lines.push({
      key: 'shows',
      icon: Eye,
      text: `${listed(a.shows.map(names.plural))}, which it shows and can’t change.`,
    })
  }
  const kinds = ({ kinds, templated }: Asks['related']) =>
    kinds.length > 0 ? listed(kinds.map(names.plural)) : templated ? 'kinds its objects name' : ''
  if (kinds(a.related)) {
    lines.push({
      key: 'related',
      icon: ListTree,
      text: `Beside an object it lists ${kinds(a.related)}, picked by their labels or fields. The list is Lumovi’s own, as on any page.`,
    })
  }
  if (kinds(a.links)) {
    lines.push({
      key: 'links',
      icon: Link2,
      text: `It links to ${kinds(a.links)} by name. A link opens Lumovi’s page for the object; the plugin reads nothing of it.`,
    })
  }
  for (const read of a.reads) {
    const more = [
      read.status && 'status',
      read.events && 'warning events',
      read.usage && 'usage',
    ].filter((said): said is string => Boolean(said))
    lines.push({
      key: `reads:${read.kind}`,
      icon: Eye,
      text:
        read.fields.length > 0 ? (
          <>
            Of {names.plural(read.kind)}, its code is handed only {mono(listed(read.fields))}
            {more.length > 0 && `, with their ${listed(more)}`}, as far as you may read them.
          </>
        ) : (
          `Of ${names.plural(read.kind)}, its code is handed their ${listed(more)}, as far as you may read them.`
        ),
    })
  }
  for (const shown of a.secrets) {
    const kind = apiKindOf(shown.kind)
    lines.push({
      key: `secret:${shown.kind}:${shown.path}`,
      icon: KeyRound,
      text: (
        <>
          Shows you {mono(listed(shown.keys))} of the Secret that{' '}
          {/^[AEIOU]/.test(kind) ? 'an' : 'a'} {kind}’s {mono(shown.path)} names. Lumovi reads it as
          you, only when you press Reveal or Copy; the plugin never sees it.
        </>
      ),
    })
  }
  if (a.manages.length > 0) {
    lines.push({
      key: 'manages',
      icon: Eye,
      text: `Every ${listed(a.manages.map(names.bare))} in the cluster you may list (or, where you can’t, in the namespaces you’re looking at), to say which of them manages each workload, by labels and annotations the workload carries under ${tool}’s own groups.`,
    })
  }
  if (logs === 'shown') {
    lines.push({ key: 'logs', icon: ScrollText, text: LOGS_LINE.shown.text })
  }
  for (const page of added.pages) {
    lines.push({
      key: `page:${page.id}`,
      icon: PanelsTopLeft,
      text: (
        <>
          Adds the page <span className="font-medium text-ink-1">{page.title}</span>
        </>
      ),
    })
  }
  for (const tab of added.tabs) {
    lines.push({
      key: `tab:${tab.id}`,
      icon: PanelsTopLeft,
      text: (
        <>
          Adds the tab <span className="font-medium text-ink-1">{tab.title}</span>, on{' '}
          {listed(tab.kinds.map(names.plural))}
        </>
      ),
    })
  }
  for (const command of added.commands) {
    lines.push({
      key: `command:${command.name}`,
      icon: PanelsTopLeft,
      text: (
        <>
          Adds the command <span className="font-medium text-ink-1">{command.name}</span>
        </>
      ),
    })
  }
  if (opens.length > 0) {
    lines.push({
      key: 'opens',
      icon: Link2,
      text: `Its pages may open Lumovi’s lists of ${listed(opens.map(names.plural))}.`,
    })
  }
  if (links.length > 0) {
    lines.push({ key: 'reach', icon: Link2, text: linksLine(links) })
  }
  for (const [i, action] of a.actions.entries()) {
    lines.push({
      key: `action:${i}:${action.name}`,
      icon: Play,
      text: (
        <>
          The action <span className="font-medium text-ink-1">{action.name}</span>, on{' '}
          {listed(action.kinds.map(names.plural))}
          {action.status && ', to its status'}:{' '}
          {action.runs === 'asks' ? 'asks first' : 'runs at once'}
        </>
      ),
      note: (
        <pre className="mt-1 overflow-x-auto rounded-md border border-line bg-surface px-2 py-1 font-mono text-2xs leading-4 text-ink-2 selectable">
          {action.creates !== undefined ? `Creates:\n${action.creates}` : action.patch}
        </pre>
      ),
    })
  }
  return lines
}

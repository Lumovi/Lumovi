/**
 * How the Plugins page says a list of kinds, and what a plugin's pages may propose: the same on
 * the page and in the store's dialog (ask-lines.tsx).
 */
import type { Asks } from '@shared/plugin-asks'
import type { ChangeAction } from '@shared/plugin-changes'
import type { Reach } from '@shared/kit/declare'
import { READ_LIMITS } from '@shared/plugin-reads'
import type { Plugin } from '@shared/plugins'
import type { ResourceKind } from '@shared/resources'

/** How kinds are named on the page: as the cluster does where it serves them. */
export interface KindNames {
  plural: (kind: ResourceKind) => string
  bare: (kind: ResourceKind) => string
}

/** "Pods and Jobs", "Pods, Jobs and Secrets". */
export function listed(names: string[]): string {
  return names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** How a plugin's page may propose a change, as the Plugins page says it, in this order. */
const PROPOSES: [ChangeAction, string][] = [
  ['patch', 'change'],
  ['create', 'create'],
  ['delete', 'delete'],
  ['scale', 'scale'],
]

/**
 * "Its pages may propose to change and delete Gadgets and Gizmos, …": each verb once, with the
 * kinds that share it; where every kind has the same actions, said once for all of them.
 */
export function proposesLine(changes: Asks['changes'], names: KindNames): string {
  const verbs = (actions: ChangeAction[]) =>
    PROPOSES.filter(([action]) => actions.includes(action)).map(([, verb]) => verb)
  const kinds = (of: Asks['changes']) => listed(of.map(({ kind }) => names.plural(kind)))
  const same = changes.every(
    ({ actions }) => verbs(actions).join() === verbs(changes[0]!.actions).join(),
  )
  const said = same
    ? `${listed(verbs(changes[0]!.actions))} ${kinds(changes)}`
    : PROPOSES.flatMap(([action, verb]) => {
        const these = changes.filter(({ actions }) => actions.includes(action))
        return these.length > 0 ? [`${verb} ${kinds(these)}`] : []
      })
        .map((group, i) => (i === 0 ? group : `to ${group}`))
        .reduce((all, group, i, groups) =>
          i === groups.length - 1 ? `${all}, and ${group}` : `${all}, ${group}`,
        )
  return `Its pages may propose to ${said}, each change one you confirm in Lumovi.`
}

/**
 * Where its pages may link to, in Lumovi's words: its own places, which the person opens and
 * does there what they do.
 */
export function linksLine(links: readonly Reach[]): string {
  const tabs = (['logs', 'shell'] as const).filter((at) => links.includes(at))
  const forward = links.includes('port-forward')
  const lumovis = `Lumovi’s ${listed(tabs.map((at) => (at === 'logs' ? 'Logs' : 'Shell')))} ${
    tabs.length > 1 ? 'tabs' : 'tab'
  }`
  const opens =
    tabs.length > 0 && forward
      ? `${lumovis} for pods they show, and its Port forward dialog for pods and services`
      : tabs.length > 0
        ? `${lumovis}, for pods they show`
        : 'Lumovi’s Port forward dialog, for pods and services they show'
  const starts = [
    ...(links.includes('shell') ? ['a shell'] : []),
    ...(forward ? ['a forward'] : []),
  ]
  return `Its pages may open ${opens}.${starts.length > 0 ? ` You start ${starts.join(' or ')} there yourself.` : ''}`
}

/**
 * What its pages do with containers' logs, by what its file says: each said here, and TypeScript
 * holds it, so a new way is never shown without its words. One its code reads is red: what
 * containers print reaches its code; a quiet note says how much.
 */
export const LOGS_LINE = {
  shown: { text: 'It shows containers’ logs: Lumovi reads them, and its code never sees them.' },
  read: {
    text: 'Its code reads containers’ logs: what they print, which can hold tokens and personal data, reaches its code.',
    note: `Of pods its page shows, one container at a time: at most its last ${READ_LIMITS.logLines} lines or hour, as you, within your access.`,
    red: true,
  },
} as const satisfies Record<
  NonNullable<Plugin['logs']>,
  { text: string; note?: string; red?: true }
>

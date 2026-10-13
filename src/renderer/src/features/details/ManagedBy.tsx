import type { ReactNode } from 'react'
import type { KubeObject } from '@shared/api'
import { apiKindOf, kindOf } from '@shared/resources'
import { KindIcon, PluginIcon } from '@renderer/components/KindIcon'
import { middleCut, MiddleTruncate } from '@renderer/components/MiddleTruncate'
import { useGo } from '@renderer/hooks/go'
import { useManagers } from '@renderer/hooks/managers'
import { useOpenObject } from '@renderer/hooks/open-object'
import { resourceFor } from '@renderer/hooks/resources'
import { managedBy, type ManagedBy } from '@renderer/lib/managers'
import { pluginNamed, shownBy } from '@renderer/lib/plugins'
import { kindPath } from '@renderer/lib/routes'
import { isWorkloadType } from '@renderer/lib/workloads'
import { useCluster } from '@renderer/state/cluster'
import { countOf } from '@renderer/features/actions/BulkActions'

/** "a, b and c". */
const listed = (items: string[]) =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`

/**
 * A manager as words: "Kustomization flux-system/apps"; or, where several of a kind share its
 * name, "Applications argocd/storefront and shop/storefront".
 */
export function managerText(manager: ManagedBy): string {
  if ('namespaces' in manager) {
    const kinds = resourceFor(manager.kind)?.label ?? `${apiKindOf(manager.kind)}s`
    return `${kinds} ${listed(manager.namespaces.map((namespace) => `${namespace}/${manager.name}`))}`
  }
  const where = manager.namespace ? `${manager.namespace}/` : ''
  return `${apiKindOf(manager.kind)} ${where}${manager.name}`
}

/** A manager with the tool that says so: "Kustomization flux-system/apps (Flux)". */
const managerTitle = (manager: ManagedBy) => `${managerText(manager)} (${shownBy(manager.view)})`

/**
 * Opens a manager: in the detail panel; or, for several of a kind that share a name, which of them
 * can't be told, that kind's list filtered by the name.
 */
function useOpenManager() {
  const open = useOpenObject()
  const go = useGo()
  const { context } = useCluster()
  return (manager: ManagedBy) =>
    'namespaces' in manager
      ? go(`${kindPath(context, manager.kind)}?q=${encodeURIComponent(manager.name)}`)
      : open(manager.kind, manager.name, manager.namespace)
}

/**
 * What manages an object, in its row: the first manager's name (cut in its middle where it's
 * long), which opens it and not the row, and how many more; each of them under a pointer.
 */
export function ManagerCell({ managers }: { managers: readonly ManagedBy[] }) {
  const openManager = useOpenManager()
  const [first, ...more] = managers as [ManagedBy, ...ManagedBy[]]
  return (
    <span
      className="flex min-w-0 items-center gap-1.5"
      title={managers.map(managerTitle).join('\n')}
    >
      <button
        type="button"
        className="min-w-0 rounded-sm text-left text-ink-2 hover:text-accent-strong hover:underline focus-visible:text-accent-strong focus-visible:underline"
        onClick={(event) => {
          event.stopPropagation()
          openManager(first)
        }}
      >
        <MiddleTruncate text={first.name} />
      </button>{' '}
      <More count={more.length} />
    </span>
  )
}

/** "+1": how many more manage it than the one said. */
function More({ count }: { count: number }) {
  return count > 0 ? (
    <span className="shrink-0 rounded-full bg-surface-3 px-1.5 text-xs text-ink-3">+{count}</span>
  ) : null
}

/**
 * What manages an object, in a phone's row: "Managed by apps", its name cut in its middle where
 * it's long. It's as wide as all of it, and as narrow as its least: "Managed by", its name's first
 * character, "…" and its last six, and "+1". Where its line can't give it that, the row starts
 * its second line with it (PhoneRow's `firm`).
 */
export function ManagerFact({ managers }: { managers: readonly ManagedBy[] }) {
  const [first, ...more] = managers as [ManagedBy, ...ManagedBy[]]
  // (Spaces as text too, for what's read aloud: a flex row's gaps aren't.)
  const said = (name: ReactNode) => (
    <>
      <span className="shrink-0">Managed by</span> {name} <More count={more.length} />
    </>
  )
  return (
    <span
      className="inline-grid max-w-full align-bottom"
      title={managers.map(managerTitle).join('\n')}
    >
      {/* Unseen, how narrow it can be: its least, which doesn't break... */}
      <span className="invisible col-start-1 row-start-1 flex h-0 items-center gap-1 overflow-clip whitespace-nowrap">
        {said(<span>{middleCut(first.name, 0, () => Infinity)}</span>)}
      </span>
      {/* ...and how wide: all of it, which (only here) may break anywhere. */}
      <span className="invisible col-start-1 row-start-1 flex h-0 items-center gap-1 overflow-clip whitespace-normal">
        {said(<span className="break-all">{first.name}</span>)}
      </span>
      {/* What's drawn, as wide as those leave it. */}
      <span className="col-start-1 row-start-1 flex items-center gap-1 [contain:inline-size]">
        {said(<MiddleTruncate text={first.name} className="min-w-0" />)}
      </span>
    </span>
  )
}

/** A manager's icon: its plugin's, where it has a place in the sidebar, else its kind's. */
function ManagerIcon({ manager }: { manager: ManagedBy }) {
  const plugin = pluginNamed(manager.view.plugin)
  const className = 'mt-0.5 size-4 shrink-0 text-ink-3'
  return plugin?.place ? (
    <PluginIcon
      plugin={{
        name: plugin.name,
        source: plugin.source,
        version: plugin.version,
        added: plugin.added,
        ...plugin.place,
      }}
      className={className}
    />
  ) : (
    <KindIcon kind={manager.kind} className={className} />
  )
}

/**
 * What manages a workload, said at the top of its overview: a band for each manager, which opens
 * it. Nothing, where nothing that's there (and can be read) does.
 */
export function ManagedNotice({ object }: { object: KubeObject }) {
  const kind = kindOf(object)
  const managers = useManagers(isWorkloadType(kind))
  const openManager = useOpenManager()
  const by = managers ? managedBy(managers.of(object, kind)) : []
  const noun = countOf(kind, 1).replace(/^1 /, '')
  return by.map((manager) => (
    <div
      key={managerText(manager)}
      className="flex items-start gap-2.5 bg-surface-2 px-5 py-3 text-[13px] text-ink-2"
    >
      <ManagerIcon manager={manager} />
      <p className="min-w-0 flex-1">
        <button
          type="button"
          title={managerTitle(manager)}
          className="text-left font-medium text-accent-strong hover:underline"
          onClick={() => openManager(manager)}
        >
          {managerText(manager)}
        </button>{' '}
        {'namespaces' in manager ? 'manage' : 'manages'} this {noun}, and may undo changes made to
        it any other way.
      </p>
    </div>
  ))
}

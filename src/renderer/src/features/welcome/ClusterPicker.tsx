/**
 * The clusters page's list: type to filter (names, contexts, servers and labels), ↑/↓ to move,
 * Enter to open. Recent first (a line each, as shortcuts), then every cluster in its group: a
 * tile in its color with its status, its name and where it is, and its version and latency or
 * what went wrong. The selected one has its actions (⋯, right-click, or `.`).
 */
import { Command, useCommandState } from 'cmdk'
import {
  Check,
  ChevronDown,
  CornerDownLeft,
  Eye,
  EyeOff,
  Layers,
  Lock,
  Minus,
  Plus,
  Search,
  Tag,
  TriangleAlert,
} from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { managedReadOnly, type KubeconfigFiles, type KubeContext } from '@shared/api'
import type { ClusterSettings } from '@shared/cluster-settings'
import { Button } from '@renderer/components/Button'
import { Kbd, MOD_KEY } from '@renderer/components/Kbd'
import { useGo } from '@renderer/hooks/go'
import { useVersion } from '@renderer/hooks/queries'
import { useSettings } from '@renderer/hooks/settings'
import type { KubeApiError } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { ERROR_LABELS, hostOf } from '@renderer/lib/format'
import { matchWords } from '@renderer/lib/match'
import { looksLikeProduction } from '@renderer/lib/production'
import { clusterPath } from '@renderer/lib/routes'
import { usePrefs } from '@renderer/state/prefs'
import { menuContent, menuItem } from '../shell/menu-styles'
import { ClusterActions, type ClusterActionHandlers } from './ClusterActions'
import { initials, middle, REVEAL, tilde, trouble } from './clusters'
import { ClusterTile } from './ClusterTile'
import { useFileActions } from './KubeconfigFiles'
import { ManagedBadge } from './Managed'

/** A user's name, unless it's one Lumovi gave in its own files (lumovi-…), which means nothing. */
const ownName = (user: string) => (/^lumovi-[0-9a-f]{12}$/.test(user) ? undefined : user)

/** How many recent clusters come first. */
const RECENT = 3
/** Recent's rows are the same clusters again: told apart by this before their value. */
const RECENT_VALUE = 'recent\u0000'

/** What went wrong, as a row says it. */
const PROBLEMS: Partial<Record<keyof typeof ERROR_LABELS, string>> = {
  auth: 'Couldn’t sign in',
  unauthorized: 'Couldn’t sign in',
}

/** A cluster as the page shows it: its context, and how it's set to show in Lumovi. */
export interface Cluster {
  context: KubeContext
  /** The name it goes by: its own, or the context's. */
  name: string
  /** Whether it has a name of its own (then its context shows under it). */
  named: boolean
  color?: number
  group?: string
  labels: [string, string][]
  production: boolean
  readOnly: boolean
  hidden: boolean
  /** Added in Lumovi: in Lumovi's own folder. */
  own: boolean
}

export function useClusters(contexts: KubeContext[], files?: KubeconfigFiles): Cluster[] {
  const settings = useSettings().data
  const ownFiles = new Set(files?.files.filter((file) => file.own).map((file) => file.path))
  return contexts.map((context) => {
    const set: ClusterSettings = settings?.clusters?.[context.name] ?? {}
    return {
      context,
      name: set.name ?? context.name,
      named: !!set.name,
      color: set.color,
      group: set.group,
      labels: Object.entries(set.labels ?? {}),
      production: set.production ?? looksLikeProduction(context.name),
      readOnly:
        !!settings?.readOnlyAll ||
        !!settings?.readOnly?.includes(context.name) ||
        managedReadOnly(settings?.managed, context.name),
      hidden: !!set.hidden,
      own: !!context.file && ownFiles.has(context.file),
    }
  })
}

/** What a cluster is found by: its names, where it is, and its labels. */
const keywordsOf = (cluster: Cluster) => [
  cluster.name,
  cluster.context.name,
  cluster.context.cluster,
  cluster.context.server ?? '',
  ...cluster.labels.map(([key, value]) => `${key}=${value}`),
]

/** Each word searched for, found in a cluster's names, where it is, or labels. */
const filter = (value: string, search: string, keywords?: string[]) =>
  matchWords([value, ...(keywords ?? [])].join(' '), search)

interface Group {
  key: string
  heading: string
  /** A label's value, as written. */
  mono?: boolean
  clusters: Cluster[]
}

/** The clusters in their groups, as the page groups them. */
function grouped(clusters: Cluster[], grouping: string, hasRecent: boolean): Group[] {
  const all = (): Group[] => [
    { key: 'all', heading: hasRecent ? 'All clusters' : 'Clusters', clusters },
  ]
  const key = grouping.startsWith('label:') ? grouping.slice('label:'.length) : undefined
  // By a label no cluster has any more: by Lumovi's groups.
  if (key && clusters.some((cluster) => cluster.labels.some(([k]) => k === key))) {
    const valueOf = (cluster: Cluster) => cluster.labels.find(([k]) => k === key)?.[1]
    const values = [...new Set(clusters.map(valueOf).filter((v) => v !== undefined))].sort()
    const without = clusters.filter((cluster) => valueOf(cluster) === undefined)
    return [
      ...values.map((value) => ({
        key: `label:${value}`,
        heading: `${key}=${value}`,
        mono: true,
        clusters: clusters.filter((cluster) => valueOf(cluster) === value),
      })),
      ...(without.length > 0
        ? [{ key: 'no label', heading: `No ${key} label`, clusters: without }]
        : []),
    ]
  }
  if (grouping === 'none') return all()
  const names = [...new Set(clusters.map((cluster) => cluster.group).filter((g) => !!g))]
  if (names.length === 0) return all()
  names.sort((a, b) => a!.localeCompare(b!))
  const others = clusters.filter((cluster) => !cluster.group)
  return [
    ...names.map((name) => ({
      key: `group ${name}`,
      heading: name!,
      clusters: clusters.filter((cluster) => cluster.group === name),
    })),
    ...(others.length > 0 ? [{ key: 'others', heading: 'Other clusters', clusters: others }] : []),
  ]
}

export function ClusterPicker({
  contexts,
  current,
  files,
  onAdd,
  actions,
  justAdded,
}: {
  contexts: KubeContext[]
  current?: string
  /** The files read (the desktop app's). */
  files?: KubeconfigFiles
  /** Adding a cluster, where Lumovi can. */
  onAdd?: () => void
  /** A cluster's actions, where Lumovi has them (the desktop app's). */
  actions?: ClusterActionHandlers
  /** The cluster just added: selected, and tinted for a moment. */
  justAdded?: string
}) {
  const everyCluster = useClusters(contexts, files)
  const recentNames = usePrefs((prefs) => prefs.recent)
  const grouping = usePrefs((prefs) => prefs.clusterGrouping)
  const showHidden = usePrefs((prefs) => prefs.showHidden)
  const [selected, setSelected] = useState('')
  const [menuFor, setMenuFor] = useState<string>()
  // The one just added lands selected, in its group.
  const [landed, setLanded] = useState(justAdded)
  if (justAdded !== landed) {
    setLanded(justAdded)
    if (justAdded) setSelected(justAdded)
  }

  const hidden = everyCluster.filter((cluster) => cluster.hidden).length
  const clusters = showHidden ? everyCluster : everyCluster.filter((cluster) => !cluster.hidden)
  const recent = recentNames
    .map((name) => clusters.find((cluster) => cluster.context.name === name))
    .filter((cluster): cluster is Cluster => cluster !== undefined)
    .slice(0, RECENT)
  const groups = grouped(clusters, grouping, recent.length > 0)
  const list = useRef<HTMLDivElement>(null)
  // ⌘I opens the selected one's settings wherever the focus is on the page (not in a dialog).
  const settingsOf = useRef<() => void>(undefined)
  useEffect(() => {
    settingsOf.current = () => {
      const value = list.current
        ?.querySelector('[cmdk-item][data-selected="true"]')
        ?.getAttribute('data-value')
      const cluster = clusters.find(
        (entry) => entry.context.name === (value ?? selected).replace(RECENT_VALUE, ''),
      )
      if (cluster) actions?.settings(cluster)
    }
  })
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'i') return
      // Not past an open dialog or menu (one closing still is in the page a moment).
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="menu"][data-state="open"]',
        )
      )
        return
      event.preventDefault()
      settingsOf.current?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const onKeyDown = (event: KeyboardEvent) => {
    // Enter on a button in the list's bar or notices presses it, not opens the selected cluster.
    const target = event.target as HTMLElement
    if (event.key === 'Enter' && target.tagName === 'BUTTON') {
      event.preventDefault()
      target.click()
      return
    }
    // A key in the search, not elsewhere (a menu's own keys reach here through its portal).
    if (target.tagName !== 'INPUT') return
    // As the list shows it now: a key can come before the page is drawn again.
    const value = (event.currentTarget as HTMLElement)
      .querySelector('[cmdk-item][data-selected="true"]')
      ?.getAttribute('data-value')
    const selectedCluster = clusters.find(
      (cluster) => cluster.context.name === (value ?? selected).replace(RECENT_VALUE, ''),
    )
    if (!selectedCluster || !actions) return
    const search = (event.target as HTMLInputElement).value ?? ''
    const mod = event.metaKey || event.ctrlKey
    // `.` opens its actions, unless it's searched for (as in a server's address).
    if (event.key === '.' && !mod && search === '') {
      event.preventDefault()
      setMenuFor(value ?? selected)
    } else if (mod && event.key === 'Backspace' && search === '' && selectedCluster.own) {
      event.preventDefault()
      actions.remove(selectedCluster)
    }
  }

  return (
    <Command
      label="Clusters"
      loop
      filter={filter}
      value={selected}
      onValueChange={setSelected}
      onKeyDown={onKeyDown}
      ref={list}
      className="flex min-h-0 animate-rise flex-col overflow-hidden rounded-2xl border border-line bg-surface-2 shadow-panel [animation-delay:60ms]"
    >
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line pr-2.5 pl-4">
        <Search className="size-4 shrink-0 text-ink-3" />
        <Command.Input
          autoFocus
          data-hotkey-target="filter"
          placeholder="Search clusters and labels…"
          className="h-12 min-w-0 flex-1 bg-transparent text-[14px] text-ink-1 outline-none placeholder:text-ink-3"
        />
        <MatchCount total={clusters.length} />
        <span className="h-5 w-px shrink-0 bg-line" />
        <GroupBy clusters={clusters} />
        {files?.locked ? (
          <ManagedBadge reason={files.locked} />
        ) : (
          onAdd && (
            <Button
              variant="secondary"
              className="h-7 px-2.5 text-xs [&_svg]:size-3.5"
              onClick={onAdd}
            >
              <Plus /> Add cluster
            </Button>
          )
        )}
      </div>
      {files && <FileNotices files={files} />}
      <Command.List className="min-h-0 flex-1 overflow-y-auto p-1.5 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-ink-3 [&_[cmdk-group-heading]]:uppercase">
        <Command.Empty className="px-4 py-10 text-center text-ink-3">
          {clusters.length === 0 && hidden > 0
            ? 'Every cluster is hidden. Show them from the footer.'
            : 'No clusters match.'}
        </Command.Empty>
        <Recent
          clusters={recent}
          current={current}
          actions={actions}
          menuFor={menuFor}
          onMenu={setMenuFor}
        />
        {groups.map((group) => (
          <Command.Group key={group.key} heading={<GroupHeading group={group} />}>
            {group.clusters.map((cluster) => (
              <ClusterRow
                // Found by what it's called and labelled now (cmdk reads them as it's made).
                key={keywordsOf(cluster).join('\u0000')}
                cluster={cluster}
                isCurrent={cluster.context.name === current}
                added={cluster.context.name === justAdded}
                actions={actions}
                menuOpen={menuFor === cluster.context.name}
                onMenu={(open) => setMenuFor(open ? cluster.context.name : undefined)}
              />
            ))}
          </Command.Group>
        ))}
      </Command.List>
      <div className="flex shrink-0 items-center gap-4 border-t border-line px-4 py-2 text-xs text-ink-3">
        <span className="flex items-center gap-1.5">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> to move
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>
            <CornerDownLeft className="size-3" />
          </Kbd>
          to open
        </span>
        {actions ? (
          <span className="flex items-center gap-1.5">
            <Kbd>.</Kbd> for actions
          </span>
        ) : (
          <span className="flex items-center gap-1.5">
            <Kbd>?</Kbd> for all shortcuts
          </span>
        )}
        {onAdd && !files?.locked && (
          <span className="flex items-center gap-1.5">
            <Kbd>{MOD_KEY}</Kbd>
            <Kbd>N</Kbd> to add
          </span>
        )}
        {hidden > 0 && <HiddenToggle count={hidden} />}
      </div>
    </Command>
  )
}

/** The clusters opened last, a line each: not while searching (they're in the list too). */
function Recent({
  clusters,
  current,
  actions,
  menuFor,
  onMenu,
}: {
  clusters: Cluster[]
  current?: string
  actions?: ClusterActionHandlers
  /** The row whose actions are open, by its value. */
  menuFor?: string
  onMenu: (value: string | undefined) => void
}) {
  const searching = useCommandState((state) => state.search.length > 0)
  if (searching || clusters.length === 0) return null
  return (
    <Command.Group heading="Recent">
      {clusters.map((cluster) => {
        const value = RECENT_VALUE + cluster.context.name
        return (
          <ClusterRow
            key={cluster.context.name}
            cluster={cluster}
            isCurrent={cluster.context.name === current}
            recent
            actions={actions}
            menuOpen={menuFor === value}
            onMenu={(open) => onMenu(open ? value : undefined)}
          />
        )
      })}
    </Command.Group>
  )
}

/** A group's heading, with how many it has (that the search found, while searching). */
function GroupHeading({ group }: { group: Group }) {
  const search = useCommandState((state) => state.search)
  const found = search
    ? group.clusters.filter((cluster) => filter(cluster.context.name, search, keywordsOf(cluster)))
        .length
    : group.clusters.length
  return (
    <>
      <span className={cn(group.mono && 'font-mono tracking-normal normal-case')}>
        {group.heading}
      </span>
      <span className="ml-1.5 font-normal tracking-normal tabular-nums opacity-75">{found}</span>
    </>
  )
}

function MatchCount({ total }: { total: number }) {
  const count = useCommandState((state) => state.filtered.count)
  const searching = useCommandState((state) => state.search.length > 0)
  // Recent's rows are counted once, with their clusters.
  return (
    <span className="shrink-0 text-xs text-ink-3 tabular-nums">
      {searching ? count : total} of {total}
    </span>
  )
}

/** Grouping by Lumovi's groups, a label's values, or nothing. */
function GroupBy({ clusters }: { clusters: Cluster[] }) {
  const grouping = usePrefs((prefs) => prefs.clusterGrouping)
  const setGrouping = usePrefs((prefs) => prefs.setClusterGrouping)
  const keys = [
    ...new Set(clusters.flatMap((cluster) => cluster.labels.map(([key]) => key))),
  ].sort()
  const choice = (
    value: typeof grouping,
    label: React.ReactNode,
    Icon: typeof Layers,
    mono = false,
  ) => (
    <DropdownMenu.Item className={menuItem} onSelect={() => setGrouping(value)}>
      <Icon className="size-4 text-ink-2" />
      <span className={cn(mono && 'font-mono text-xs')}>{label}</span>
      {grouping === value && <Check className="ml-auto size-4 text-ink-2" />}
    </DropdownMenu.Item>
  )
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          variant="ghost"
          className={cn(
            'h-7 shrink-0 px-2.5 text-xs [&_svg]:size-3.5',
            grouping.startsWith('label:') && 'bg-surface-3 text-ink-1',
          )}
        >
          <Layers />
          {grouping.startsWith('label:') && keys.includes(grouping.slice('label:'.length))
            ? `Grouped by ${grouping.slice('label:'.length)}`
            : 'Group by'}
          <ChevronDown />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className={cn(menuContent, 'w-56')}
          // Its keys are its own: not the list's it's in (React's events pass through portals).
          onKeyDown={(event) => event.stopPropagation()}
        >
          <DropdownMenu.Label className="px-2 pt-1.5 pb-1 text-2xs font-medium tracking-wider text-ink-3 uppercase">
            Group by
          </DropdownMenu.Label>
          {choice('group', 'Group', Layers)}
          {keys.length > 0 && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-line" />
              <DropdownMenu.Label className="px-2 pt-1.5 pb-1 text-2xs font-medium tracking-wider text-ink-3 uppercase">
                A label
              </DropdownMenu.Label>
              {keys.map((key) => (
                <span key={key}>{choice(`label:${key}`, key, Tag, true)}</span>
              ))}
            </>
          )}
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          {choice('none', 'Nothing', Minus)}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

/** The footer's count of hidden clusters, which shows them, or hides them again. */
function HiddenToggle({ count }: { count: number }) {
  const showHidden = usePrefs((prefs) => prefs.showHidden)
  const setShowHidden = usePrefs((prefs) => prefs.setShowHidden)
  const Icon = showHidden ? Eye : EyeOff
  return (
    <button
      type="button"
      onClick={() => setShowHidden(!showHidden)}
      className="ml-auto flex items-center gap-1.5 text-xs font-medium text-ink-2 hover:text-ink-1"
    >
      <Icon className="size-3.5" />
      {showHidden ? `Showing ${count} hidden` : `${count} hidden`}
    </button>
  )
}

/** The label a search found a cluster by, if it's by one. */
function useMatchedLabel(cluster: Cluster): string | undefined {
  const search = useCommandState((state) => state.search.trim().toLowerCase())
  if (!search) return undefined
  const terms = search.split(/\s+/)
  return cluster.labels
    .map(([key, value]) => `${key}=${value}`)
    .find((label) => terms.some((term) => label.toLowerCase().includes(term)))
}

function ClusterRow({
  cluster,
  isCurrent,
  recent,
  added = false,
  actions,
  menuOpen = false,
  onMenu,
}: {
  cluster: Cluster
  isCurrent: boolean
  /** Just added: tinted for a moment. */
  added?: boolean
  /** In Recent: a line, as a shortcut. */
  recent?: boolean
  actions?: ClusterActionHandlers
  menuOpen?: boolean
  onMenu?: (open: boolean) => void
}) {
  const go = useGo()
  const { context } = cluster
  const version = useVersion(context.name)
  const label = useMatchedLabel(cluster)
  const health = version.isPending ? 'progressing' : version.isError ? 'critical' : 'healthy'
  const code = version.isError ? (version.error as KubeApiError).code : undefined
  return (
    <Command.Item
      value={`${recent ? RECENT_VALUE : ''}${context.name}`}
      keywords={keywordsOf(cluster)}
      onSelect={() => go(clusterPath(context.name))}
      onContextMenu={(event) => {
        if (!actions) return
        event.preventDefault()
        onMenu?.(true)
      }}
      className={cn(
        'group flex cursor-default items-center rounded-xl px-3 text-left transition-colors data-[selected=true]:bg-surface-3',
        recent ? 'gap-3 py-2' : 'gap-3.5 py-2.5',
        cluster.hidden && 'opacity-55',
        added && 'animate-added',
      )}
    >
      <ClusterTile
        letters={initials(context.name, cluster.named ? cluster.name : undefined)}
        color={cluster.color}
        health={health}
        small={recent}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-[13.5px] font-medium text-ink-1">{cluster.name}</span>
          {cluster.production && (
            <span className="shrink-0 rounded bg-critical/10 px-1.5 py-px text-2xs font-semibold tracking-wide text-critical-text uppercase">
              Production
            </span>
          )}
          {cluster.readOnly && (
            <Lock aria-label="Read-only" className="size-3 shrink-0 text-ink-3" />
          )}
          {isCurrent && (
            <span className="shrink-0 rounded-full bg-surface-3 px-1.5 py-px text-2xs font-medium text-ink-2 group-data-[selected=true]:bg-surface-2">
              current
            </span>
          )}
          {cluster.hidden && (
            <EyeOff aria-label="Hidden" className="size-3.5 shrink-0 text-ink-3" />
          )}
        </span>
        {!recent && (
          <span className="mt-0.5 block truncate font-mono text-xs text-ink-3">
            {cluster.named
              ? // Shorter beside the label a search found.
                middle(context.name, label ? 34 : 46)
              : [hostOf(context.server) ?? 'No cluster defined', ownName(context.user)]
                  .filter(Boolean)
                  .join(' · ')}
          </span>
        )}
      </span>
      {label && !recent && (
        <span className="flex h-5 shrink-0 items-center rounded-md bg-accent-soft px-1.5 font-mono text-2xs text-accent-strong">
          {label}
        </span>
      )}
      <span className="w-[116px] shrink-0 text-right text-xs">
        {version.isPending ? (
          // Being checked: a place for its version.
          <span className="inline-block h-2.5 w-[72px] animate-shimmer rounded bg-surface-3 align-middle" />
        ) : version.isError ? (
          <span className="text-critical-text" title={version.error.message}>
            {(code && PROBLEMS[code]) ?? ERROR_LABELS[code!]}
          </span>
        ) : (
          <span className="text-ink-3">
            <span className="font-mono text-ink-2">{version.data.gitVersion}</span> ·{' '}
            {version.data.latencyMs} ms
          </span>
        )}
      </span>
      <span className="flex w-[52px] shrink-0 items-center justify-end gap-0.5">
        {actions && (
          <ClusterActions
            cluster={cluster}
            actions={actions}
            open={menuOpen}
            onOpenChange={onMenu!}
          />
        )}
        <span className="grid size-5 shrink-0 place-items-center rounded-md text-ink-3 opacity-0 transition-opacity group-data-[selected=true]:opacity-100">
          <CornerDownLeft className="size-3.5" />
        </span>
      </span>
    </Command.Item>
  )
}

/** A file that's gone, or can't be read, while the others still are: said, and what to do. */
function FileNotices({ files }: { files: KubeconfigFiles }) {
  const actions = useFileActions()
  const troubled = files.files.filter((file) => trouble(file))
  return troubled.map((file) => {
    const gone = trouble(file) === 'gone'
    const path = tilde(file.path, files.home)
    return (
      <div
        key={file.path}
        role="status"
        className="flex shrink-0 animate-fade-in items-center gap-2 border-b border-warn/25 bg-warn/10 px-5 py-1.5 text-xs text-warn-text"
      >
        <TriangleAlert className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate" title={file.problem ?? file.path}>
          <span className="font-mono">{path}</span>{' '}
          {gone
            ? 'is gone, so its clusters aren’t here.'
            : 'couldn’t be read, so its clusters aren’t here.'}
        </span>
        {!files.locked && (
          <span className="ml-auto flex shrink-0 gap-3 font-medium">
            {gone ? (
              <button
                type="button"
                className="hover:underline"
                onClick={() => void actions.chooseAgain(file.path)}
              >
                Choose it again…
              </button>
            ) : (
              <button
                type="button"
                className="hover:underline"
                onClick={() => actions.show(file.path)}
              >
                {REVEAL}
              </button>
            )}
            {file.removable && (
              <button
                type="button"
                className="hover:underline"
                onClick={() => void actions.remove(file.path)}
              >
                Remove
              </button>
            )}
          </span>
        )}
      </div>
    )
  })
}

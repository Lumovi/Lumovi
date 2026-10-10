import { useLayout } from '@renderer/lib/layout'
import { useQuery } from '@tanstack/react-query'
import { Command } from 'cmdk'
import {
  Blocks,
  Boxes,
  ChartSpline,
  Check,
  ChevronDown,
  ChevronsUpDown,
  LayoutDashboard,
  List,
  Lock,
  ScrollText,
  ShipWheel,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router'
import type { KubeContext } from '@shared/api'
import { GO_KEYS } from '@shared/navigation'
import {
  isCustomGroup,
  RESOURCES,
  type ResourceCategory,
  type ResourceDefinition,
} from '@shared/resources'
import { IconButton } from '@renderer/components/Button'
import { MiddleTruncate } from '@renderer/components/MiddleTruncate'
import { Picker } from '@renderer/components/Picker'
import { AddOnIcon, KIND_ICONS, kindIcon } from '@renderer/components/KindIcon'
import { GithubMark } from '@renderer/components/GithubMark'
import { StatusDot } from '@renderer/components/Status'
import { Switch } from '@renderer/components/Switch'
import { useAddOns, type ServedAddOn } from '@renderer/hooks/add-ons'
import { useGo } from '@renderer/hooks/go'
import { useContexts, useVersion } from '@renderer/hooks/queries'
import { useResources } from '@renderer/hooks/resources'
import { useViews } from '@renderer/hooks/views'
import { useClusterName, useReadOnly } from '@renderer/hooks/settings'
import { formatDateTime } from '@renderer/lib/format'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { matchWords } from '@renderer/lib/match'
import {
  addOnPath,
  apiResourcesPath,
  clusterPath,
  helmPath,
  kindPath,
  metricsPath,
  workloadsPath,
} from '@renderer/lib/routes'
import { useCluster } from '@renderer/state/cluster'
import { usePrefs } from '@renderer/state/prefs'
import { useSession, useSwitching } from '@renderer/state/session'
import { AdminButton } from '../access/AdminButton'
import { AccountMenu } from '../session/AccountMenu'
import { REPO_URL } from '../welcome/WelcomePage'
import { menuItem } from './menu-styles'
import { contextChip } from './NamespacePicker'
import { Sponsor, useSponsorShown } from './Sponsor'
import { AssistantsButton } from '../assistants/DesktopConnect'
import { ServerAssistantsButton } from '../assistants/ServerConnect'
import { ThemeMenu } from './ThemeMenu'
import { AppMenuButton, HAS_MENU_BUTTON } from './AppMenu'

export const CATEGORY_LABELS: Record<ResourceCategory, string> = {
  cluster: 'Cluster',
  workloads: 'Workloads',
  network: 'Network',
  config: 'Configuration',
  storage: 'Storage',
}

const SIDEBAR_CATEGORIES: ResourceCategory[] = ['cluster', 'network', 'config', 'storage']

const navItem = (isActive: boolean) =>
  cn(
    // (A finger's height in the drawer.)
    'group flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors duration-100 no-drag narrow:h-11',
    isActive
      ? 'bg-surface-3 font-medium text-ink-1 shadow-[inset_0_0_0_1px_var(--line)]'
      : 'text-ink-2 hover:bg-surface-3/60 hover:text-ink-1',
  )

/** The lists Workloads leads to: its tabs, and the kinds that run them. */
const WORKLOAD_PAGES = RESOURCES.filter((r) => r.category === 'workloads' && r.kind !== 'Pod').map(
  (r) => r.plural,
)

/**
 * A sidebar link that navigates with a page transition. It also shows as the
 * current page on the routes in `also`, or when `current` says so.
 */
function NavItem({
  to,
  end,
  also = [],
  current = false,
  children,
}: {
  to: string
  end?: boolean
  also?: string[]
  current?: boolean
  children: ReactNode
}) {
  const go = useGo()
  const page = useLocation().pathname.split('/')[3]!
  return (
    <NavLink
      end={end}
      to={to}
      className={({ isActive }) => navItem(isActive || current || also.includes(page))}
      onClick={(event) => {
        event.preventDefault()
        go(to)
      }}
    >
      {children}
    </NavLink>
  )
}

/** The "g, then a letter" shortcut for a nav item, shown on hover. */
function GoHint({ target }: { target: string }) {
  const entry = GO_KEYS.find((e) => e.target === target)
  return (
    <span
      aria-hidden
      // (Keys to press: of no use to a finger.)
      className="ml-auto font-mono text-2xs text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 touch:hidden"
    >
      {entry && `G ${entry.key.toUpperCase()}`}
    </span>
  )
}

/** An add-on's entry: current on its page, and on its kinds' lists. */
function AddOnItem({ served }: { served: ServedAddOn }) {
  const { context } = useCluster()
  const [page, kind] = useLocation().pathname.split('/').slice(3)
  const { addOn, kinds } = served
  return (
    <NavItem
      to={addOnPath(context, addOn.name)}
      current={page === 'r' && kinds.some((r) => r.kind === decodeURIComponent(kind!))}
    >
      <AddOnIcon addOn={addOn} className="size-4 shrink-0 text-ink-3" />
      <span className="truncate">{addOn.label}</span>
    </NavItem>
  )
}

export function Sidebar() {
  const { context } = useCluster()
  const session = useSession()
  const addOns = useAddOns()
  const version = useQuery({ queryKey: ['app-info'], queryFn: () => api.app.info() }).data?.version
  const navigate = useNavigate()
  const nav = useRef<HTMLElement>(null)
  const goesOn = useGoesOn(nav)
  // Over the sponsor card, the nav fades out where it goes on, so the card's label doesn't read as
  // one more of its sections.
  const fades = useSponsorShown() && (goesOn.up || goesOn.down)
  return (
    <aside
      aria-label="Sidebar"
      // In a drawer (a narrow page) it's as wide as the drawer, and as tall.
      className="flex w-[244px] shrink-0 flex-col drag narrow:min-h-0 narrow:w-full narrow:flex-1"
    >
      {HAS_MENU_BUTTON ? (
        // Windows' and Linux's menu, on their window controls' line.
        <div className="flex h-[52px] shrink-0 items-center px-3">
          <AppMenuButton />
        </div>
      ) : (
        // Room for macOS's window controls, which sit above the cluster.
        <div aria-hidden className="traffic-lights h-10 shrink-0" />
      )}
      <div className="p-3">
        <ClusterSwitcher />
      </div>
      <nav
        ref={nav}
        aria-label="Resources"
        // With add-ons it can be longer than the window; it scrolls without a scrollbar, as macOS's do.
        className="min-h-0 flex-1 [scrollbar-width:none] overflow-y-auto px-3 pb-3 no-drag"
        style={
          fades
            ? {
                maskImage: `linear-gradient(to bottom, ${goesOn.up ? `transparent, #000 ${FADE}px` : '#000'}, ${goesOn.down ? `#000 calc(100% - ${FADE}px), transparent` : '#000'})`,
              }
            : undefined
        }
      >
        <NavItem end to={clusterPath(context)}>
          <LayoutDashboard className="size-4 text-ink-3" /> Overview
          <GoHint target="overview" />
        </NavItem>
        <NavItem to={workloadsPath(context)} also={WORKLOAD_PAGES}>
          <Boxes className="size-4 text-ink-3" /> Workloads
          <GoHint target="workloads" />
        </NavItem>
        <NavItem to={kindPath(context, 'Pod')}>
          <KIND_ICONS.Pod className="size-4 text-ink-3" /> Pods
          <GoHint target="Pod" />
        </NavItem>
        <NavItem to={metricsPath(context)}>
          <ChartSpline className="size-4 text-ink-3" /> Metrics
          <GoHint target="metrics" />
        </NavItem>
        <NavItem to={helmPath(context)}>
          <ShipWheel className="size-4 text-ink-3" /> Helm releases
          <GoHint target="helm" />
        </NavItem>
        {/* Workloads and Pods lead to the workload kinds' lists. */}
        {SIDEBAR_CATEGORIES.map((category) => (
          <div key={category} className="mt-4">
            <h3 className="mb-1 px-2.5 text-2xs font-medium tracking-wider text-ink-3 uppercase">
              {CATEGORY_LABELS[category]}
            </h3>
            {RESOURCES.filter((r) => r.category === category).map((resource) => {
              const Icon = KIND_ICONS[resource.kind]
              return (
                <NavItem key={resource.kind} to={kindPath(context, resource.kind)}>
                  <Icon className="size-4 text-ink-3" /> {resource.label}
                  <GoHint target={resource.kind} />
                </NavItem>
              )
            })}
            {/* Add-ons that extend Kubernetes' own, like Gateway API, sit with them. */}
            {addOns
              .filter((served) => served.addOn.category === category)
              .map((served) => (
                <AddOnItem key={served.addOn.name} served={served} />
              ))}
          </div>
        ))}
        <CustomResources addOns={addOns} />
      </nav>
      <Sponsor />
      <div className="flex items-center gap-1 border-t border-line px-3 py-2 no-drag narrow:px-1 narrow:pb-[max(0.5rem,env(safe-area-inset-bottom))] narrow:[&_button]:size-11">
        <ThemeMenu />
        {api.assistants && <AssistantsButton assistants={api.assistants} />}
        {api.serverAssistants && <ServerAssistantsButton assistants={api.serverAssistants} />}
        <IconButton label="Audit log" onClick={() => void navigate('/audit')}>
          <ScrollText />
        </IconButton>
        <AdminButton />
        {session && <AccountMenu session={session} />}
        <IconButton label="Lumovi on GitHub" onClick={() => api.app.openExternal(REPO_URL)}>
          <GithubMark />
        </IconButton>
        <span className="ml-auto pr-1 text-2xs text-ink-3 tabular-nums">
          {version && `v${version}`}
        </span>
      </div>
    </aside>
  )
}

/** How far the nav fades out at an edge where it goes on: a little less than one of its rows. */
const FADE = 24

/** Whether a list goes on past its top (scrolled) and past its bottom. */
function useGoesOn(ref: RefObject<HTMLElement | null>): { up: boolean; down: boolean } {
  const [goesOn, setGoesOn] = useState({ up: false, down: false })
  useEffect(() => {
    const list = ref.current!
    const measure = () => {
      const up = list.scrollTop > 0
      const down = list.scrollTop + list.clientHeight < list.scrollHeight - 1
      setGoesOn((was) => (was.up === up && was.down === down ? was : { up, down }))
    }
    measure()
    list.addEventListener('scroll', measure, { passive: true })
    // The window's size, and what's in the list (add-ons, as they're found), change it too.
    const resized = new ResizeObserver(measure)
    resized.observe(list)
    const changed = new MutationObserver(measure)
    changed.observe(list, { childList: true, subtree: true })
    return () => {
      list.removeEventListener('scroll', measure)
      resized.disconnect()
      changed.disconnect()
    }
  }, [ref])
  return goesOn
}

/**
 * The cluster, and whether Lumovi may change it; in the desktop app, also
 * the other clusters to switch to (a server shows one).
 */
export function ClusterSwitcher({ chip = false }: { chip?: boolean }) {
  const switching = useSwitching()
  const { context } = useCluster()
  const navigateTo = useGo()
  const [open, setOpen] = useState(false)
  const contexts = useContexts().data?.contexts ?? []
  const version = useVersion(context)
  const server = contexts.find((c) => c.name === context)?.server
  const health = version.isPending ? 'progressing' : version.isError ? 'critical' : 'healthy'
  const readOnly = useReadOnly()
  const clusterName = useClusterName()
  const phone = useLayout() === 'phone'
  const go = (path: string) => {
    setOpen(false)
    navigateTo(path)
  }
  return (
    <Picker
      open={open}
      onOpenChange={setOpen}
      title={switching ? 'Switch cluster' : 'Cluster'}
      className="w-[300px] p-0"
      trigger={
        chip ? (
          <button
            type="button"
            aria-label={switching ? 'Switch cluster' : 'Cluster'}
            className={cn(contextChip, 'max-w-[60%]')}
          >
            <StatusDot health={health} />
            <MiddleTruncate text={clusterName(context)} />
            {readOnly.readOnly && (
              <Lock aria-label="Read-only" className="size-3 shrink-0 text-ink-3" />
            )}
            <ChevronsUpDown className="size-3.5 shrink-0 text-ink-3" />
          </button>
        ) : (
          <button
            type="button"
            aria-label={switching ? 'Switch cluster' : 'Cluster'}
            className="flex w-full items-center gap-2.5 rounded-xl border border-line bg-surface-2 px-3 py-2 text-left shadow-panel transition-colors no-drag hover:bg-surface-3 data-[state=open]:bg-surface-3"
          >
            <StatusDot health={health} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-[13px] font-medium text-ink-1">
                <span className="truncate">{clusterName(context)}</span>
                {readOnly.readOnly && (
                  <Lock aria-label="Read-only" className="size-3 shrink-0 text-ink-3" />
                )}
              </span>
              <span className="block truncate text-xs text-ink-3">
                {version.isSuccess
                  ? `Kubernetes ${version.data.gitVersion}`
                  : version.isError
                    ? 'Unavailable'
                    : (server ?? 'Connecting…')}
              </span>
            </span>
            {switching ? (
              <ChevronsUpDown className="size-4 shrink-0 text-ink-3" />
            ) : (
              <ChevronDown className="size-4 shrink-0 text-ink-3" />
            )}
          </button>
        )
      }
    >
      {switching ? (
        <Command loop filter={matchWords} label="Clusters">
          <Command.Input
            placeholder="Switch to…"
            className="h-10 w-full border-b border-line bg-transparent px-3 text-[13px] text-ink-1 outline-none placeholder:text-ink-3"
          />
          <Command.List className="max-h-80 overflow-y-auto p-1 phone:max-h-none phone:px-2">
            <Command.Empty className="px-3 py-6 text-center text-xs text-ink-3">
              No clusters match.
            </Command.Empty>
            {contexts.map((c) => (
              <SwitcherItem key={c.name} context={c} active={c.name === context} onSelect={go} />
            ))}
            <Command.Separator className="mx-1 my-1 h-px bg-line" />
            <Command.Item value="All clusters" onSelect={() => go('/')} className={menuItem}>
              <List className="size-4 text-ink-3" /> All clusters
            </Command.Item>
          </Command.List>
        </Command>
      ) : (
        <div className="px-3 py-2.5">
          <p className="truncate text-[13px] font-medium text-ink-1">{context}</p>
          <p className="truncate font-mono text-xs text-ink-3 selectable" title={server}>
            {server}
          </p>
        </div>
      )}
      <div className="flex items-center gap-3 border-t border-line px-3 py-2.5">
        <Lock className="size-4 shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] text-ink-1">Read-only</span>
          <span className="block text-xs leading-snug text-ink-3">
            {readOnly.locked
              ? api.host === 'desktop'
                ? readOnly.byPolicy
                  ? 'Set by your organization'
                  : 'Set by LUMOVI_READ_ONLY'
                : 'For everyone, on this server'
              : readOnly.shared
                ? `Lumovi won’t change ${context} for anyone on this server`
                : `Lumovi won’t change ${context}`}
          </span>
          {readOnly.by && (
            <span className="block text-xs leading-snug text-ink-3">
              {readOnly.by.outside
                ? 'Turned on outside Lumovi'
                : `Turned on by ${readOnly.by.by}, ${formatDateTime(readOnly.by.at)}`}
            </span>
          )}
          {phone && !readOnly.locked && (
            <span className="block text-xs leading-snug text-ink-3">
              Open Lumovi on a larger screen to change it
            </span>
          )}
          {readOnly.shared && !readOnly.locked && !readOnly.mayChange && (
            <span className="block text-xs leading-snug text-ink-3">
              Only Lumovi’s admins change it
            </span>
          )}
        </span>
        <Switch
          label="Read-only"
          checked={readOnly.readOnly}
          // (On a phone it's said, not set.)
          disabled={!readOnly.mayChange || phone}
          onCheckedChange={(checked) => void readOnly.set(checked)}
        />
      </div>
    </Picker>
  )
}

function SwitcherItem({
  context,
  active,
  onSelect,
}: {
  context: KubeContext
  active: boolean
  onSelect: (path: string) => void
}) {
  const version = useVersion(context.name)
  const name = useClusterName()(context.name)
  const health = version.isPending ? 'progressing' : version.isError ? 'critical' : 'healthy'
  return (
    <Command.Item
      value={`${name} ${context.name} ${context.cluster}`}
      onSelect={() => onSelect(clusterPath(context.name))}
      className={cn(menuItem, 'h-auto py-1.5')}
    >
      <StatusDot health={health} />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{name}</span>
      </span>
      {active && <Check className="size-4 text-accent" aria-label="Current cluster" />}
    </Command.Item>
  )
}

/**
 * Pinned kinds, the add-ons of the tools the cluster has, and the custom
 * kinds opened lately in this cluster: a few, however many the cluster has.
 * Browsing them all is what API resources is for.
 */
function CustomResources({ addOns }: { addOns: ServedAddOn[] }) {
  const { context } = useCluster()
  const resources = useResources().data
  // Views pick the kinds' icons.
  useViews()
  const pinnedKinds = usePrefs((prefs) => prefs.pinned)
  const recentKinds = usePrefs((prefs) => prefs.recentKinds[context])
  const served = new Map((resources ?? []).map((r) => [r.kind as string, r]))
  const pinned = pinnedKinds.flatMap((kind) => served.get(kind) ?? [])
  // Kinds an add-on has are a click away already.
  const inAddOns = new Set(addOns.flatMap(({ kinds }) => kinds.map((r) => r.kind)))
  const recent = (recentKinds ?? [])
    .filter((kind) => !pinnedKinds.includes(kind) && !inAddOns.has(kind))
    .flatMap((kind) => served.get(kind) ?? [])
    .filter((r) => isCustomGroup(r.group))
  const ownSection = addOns.filter((served) => !served.addOn.category)
  const custom = (resources ?? []).filter((r) => isCustomGroup(r.group)).length
  const item = (resource: ResourceDefinition) => {
    const Icon = kindIcon(resource.kind)
    return (
      <NavItem key={resource.kind} to={kindPath(context, resource.kind)}>
        <Icon className="size-4 shrink-0 text-ink-3" />
        <span className="truncate">{resource.label}</span>
      </NavItem>
    )
  }
  return (
    <>
      {pinned.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-1 px-2.5 text-2xs font-medium tracking-wider text-ink-3 uppercase">
            Pinned
          </h3>
          {pinned.map(item)}
        </div>
      )}
      {ownSection.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-1 px-2.5 text-2xs font-medium tracking-wider text-ink-3 uppercase">
            Add-ons
          </h3>
          {ownSection.map((served) => (
            <AddOnItem key={served.addOn.name} served={served} />
          ))}
        </div>
      )}
      <div className="mt-4">
        <h3 className="mb-1 px-2.5 text-2xs font-medium tracking-wider text-ink-3 uppercase">
          Custom resources
        </h3>
        <div aria-label="Opened lately" role="group">
          {recent.map(item)}
        </div>
        {resources && custom === 0 && (
          <p className="px-2.5 py-1 text-xs text-ink-3">None in this cluster</p>
        )}
        <NavItem to={apiResourcesPath(context)}>
          <Blocks className="size-4 text-ink-3" /> API resources
          {custom > 0 && (
            <span
              aria-label={`${custom} custom`}
              className="ml-auto text-2xs text-ink-3 tabular-nums"
            >
              {custom}
            </span>
          )}
        </NavItem>
      </div>
    </>
  )
}

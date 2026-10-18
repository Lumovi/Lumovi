import { Search, X } from 'lucide-react'
import { barButton } from '@renderer/components/Sheet'
import { cn } from '@renderer/lib/cn'
import { useLayout, useTouch } from '@renderer/lib/layout'
import { Command } from 'cmdk'
import {
  AppWindow,
  Blocks,
  Bookmark,
  Plug,
  Bell,
  ChartSpline,
  CornerDownLeft,
  FilePlus2,
  Keyboard,
  Check,
  LayoutDashboard,
  LayoutGrid,
  Lock,
  LockOpen,
  LogOut,
  Monitor,
  Moon,
  PanelBottom,
  Pin,
  PinOff,
  Scale,
  ScrollText,
  Settings,
  Server,
  Settings2,
  Shield,
  ShieldCheck,
  ShipWheel,
  Sparkles,
  Sun,
  Boxes,
  SquareTerminal,
  Link,
} from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useLocation, useSearchParams } from 'react-router'
import type { KubeObject } from '@shared/api'
import { spelled } from '@shared/kit/characters'
import { MARKS_LIMITS, samePin, type Pin as PinOf } from '@shared/marks'
import { GO_KEYS } from '@shared/navigation'
import { apiKindOf, isBuiltinKind, kindOf, RESOURCES } from '@shared/resources'
import { pluginIcon, KIND_ICONS, KindIcon, kindIcon } from '@renderer/components/KindIcon'
import { StatusDot, StatusPill } from '@renderer/components/Status'
import { ALT_KEY, Kbd, MOD_KEY, WINDOW_SHORTCUTS } from '@renderer/components/Kbd'
import { useGo } from '@renderer/hooks/go'
import { usePinning } from '@renderer/hooks/marks'
import { useContexts, useList, useListResponses, useObject } from '@renderer/hooks/queries'
import { useServedPlugins } from '@renderer/hooks/plugins'
import { useResources } from '@renderer/hooks/resources'
import { useClusterName, useReadOnly, useSetTheme } from '@renderer/hooks/settings'
import { pinnable } from '@renderer/lib/marks'
import { matchWords } from '@renderer/lib/match'
import {
  pluginPagePath,
  pluginPath,
  apiResourcesPath,
  pluginsPath,
  clusterPath,
  helmPath,
  formatRef,
  kindPath,
  alertsPath,
  metricsPath,
  rightsizingPath,
  workloadsPath,
  parseRef,
  listedKind,
  pluginAsksPath,
} from '@renderer/lib/routes'
import { api, KubeApiError } from '@renderer/lib/api'
import { hasHealth, statusFor, statusOf } from '@renderer/lib/health'
import {
  deletingView,
  movingPin,
  repinning,
  undeletingView,
  unpinning,
  viewsOf,
} from '@renderer/lib/marks'
import { toast } from '@renderer/state/toasts'
import { useCluster } from '@renderer/state/cluster'
import { keepFocusInActionDialog } from '@renderer/state/actions'
import { useSwitching } from '@renderer/state/session'
import { useUi } from '@renderer/state/ui'
import { TheirText } from '@renderer/plugins/TheirText'
import { usePrefs } from '@renderer/state/prefs'
import { useMyAccess } from '../access/use-access'
import { useObjectActions, useRunAction } from '../actions/use-actions'
import { copyLink, useLinksOffered } from '../links/copy'
import { openView } from '../resources/views'
import { PIN_KEY } from '../details/PinButton'
import { severalPath } from '../several/set'
import { useDock } from '../terminal/dock'
import { TERMINAL_KEYS } from '../terminal/keys'
import { kindName, pinKey, pinNumber, pinPath, PINS_NUMBERED } from './PinnedObjects'
import { CATEGORY_LABELS } from './Sidebar'
import {
  savedKeyCaps,
  savedKeysHere,
  savedNumber,
  searchPath,
  useSavedSearches,
} from '../search/saved'
import { nameRank, searches, termsOf, type Terms } from '../search/terms'
import { useClusterSearch, type KindSearch } from '../search/use-search'

const THEMES = [
  { value: 'system', label: 'Use system theme', icon: Monitor },
  { value: 'light', label: 'Use light theme', icon: Sun },
  { value: 'dark', label: 'Use dark theme', icon: Moon },
] as const

/** What tells the cluster's objects' rows, and Search the cluster's, from today's rows. */
const OBJECT_ROW = '\u2063object '
const SEARCH_ROW = '\u2063search '

/**
 * Every typed word in a row's value; today's rows (pages, views, actions) first wherever they
 * match, then the cluster's objects, then Search the cluster: so ↵ does what it did before.
 */
function paletteMatch(value: string, search: string): number {
  const score = matchWords(value, search)
  if (score === 0) return 0
  return value.startsWith(SEARCH_ROW) ? 0.1 : value.startsWith(OBJECT_ROW) ? 0.5 : score
}

/** Objects are searched once the query is this long. */
const MIN_OBJECT_QUERY = 2
/** The objects the palette shows, best first. */
const MAX_OBJECTS = 8
/** How long the Objects group waits for every kind's answer before it shows what it has. */
const OBJECTS_WAIT_MS = 300
const MOD = navigator.userAgent.includes('Mac') ? '⌘' : 'Ctrl'

/**
 * The objects the palette shows: up to eight, best first across kinds. Shown once every kind has
 * answered, or after a moment; after that, rows only join at the end, so the row chosen never moves.
 */
function useFound(kinds: KindSearch[], terms: Terms, on: boolean) {
  const best = useMemo(
    () =>
      kinds
        .flatMap((kind) => kind.found.map((item) => ({ item, kind })))
        .map((entry) => ({ ...entry, rank: nameRank(entry.item.name, terms.words) ?? 3 }))
        .sort((a, b) => a.rank - b.rank || a.item.name.localeCompare(b.item.name)),
    [kinds, terms],
  )
  const answered = kinds.every((kind) => kind.state !== 'waiting')
  const [waited, setWaited] = useState(false)
  const [shown, setShown] = useState<string[]>([])
  const words = terms.words.join(' ') + terms.selector
  const [was, setWas] = useState(words)
  if (was !== words) {
    setWas(words)
    setWaited(false)
    setShown([])
  }
  useEffect(() => {
    if (!on) return
    const timer = setTimeout(() => setWaited(true), OBJECTS_WAIT_MS)
    return () => clearTimeout(timer)
  }, [on, words])
  const ready = on && (answered || waited)
  const byUid = new Map(best.map((entry) => [entry.item.uid, entry]))
  const kept = shown.flatMap((uid) => byUid.get(uid) ?? [])
  const more = best.filter((entry) => !shown.includes(entry.item.uid))
  const rows = ready ? [...kept, ...more].slice(0, MAX_OBJECTS) : []
  const uids = rows.map((entry) => entry.item.uid)
  if (uids.join() !== shown.join()) setShown(uids)
  return rows
}

const goKey = (target: string) => GO_KEYS.find((entry) => entry.target === target)!.key

/** A pinned object's row: told apart from the same object found by its name ("object"). */
const pinValue = (pin: PinOf, kind: string) =>
  `${pin.name} ${kind} ${pin.namespace ?? ''} pinned ${formatRef(pin)}`

export function CommandPalette() {
  const open = useUi((ui) => ui.palette)
  const setOpen = useUi((ui) => ui.setPalette)
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 animate-fade-in bg-black/25 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={keepFocusInActionDialog}
          // On a phone it's the whole screen, its field on top: there's a keyboard under it.
          className="fixed top-[14vh] left-1/2 z-50 w-[640px] max-w-[calc(100vw-48px)] -translate-x-1/2 animate-pop-in overflow-hidden rounded-2xl border border-line-strong bg-surface-2 shadow-pop outline-none phone:inset-0 phone:w-auto phone:max-w-none phone:translate-x-0 phone:animate-fade-in phone:rounded-none phone:border-0"
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <Palette onDone={() => setOpen(false)} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Palette({ onDone }: { onDone: () => void }) {
  const { context, namespace, namespaces: picked, setNamespace } = useCluster()
  const [search, setSearch] = useState('')
  const contexts = useContexts().data?.contexts ?? []
  const clusterName = useClusterName()
  const namespaces = useList('Namespace', { namespace: null }).data ?? []
  // The cluster's other kinds, custom resources included.
  const known = useResources().data
  const resources = known ?? []
  const others = resources.filter((r) => !isBuiltinKind(r.kind))
  const served = new Map(resources.map((r) => [r.kind as string, r]))
  const pinnedKinds = usePrefs((prefs) => prefs.pinned).flatMap((kind) => served.get(kind) ?? [])
  const pinning = usePinning()
  const pins = pinning.marks.pins
  // The row that's chosen, for what the keys do to a pin's (⌥↑ ⌥↓ move it, ⌫ unpins it).
  const [chosen, setChosen] = useState('')
  // Pins unpinned here: shown where they were, with their Undo, while the palette is open (a
  // dialog, which keeps a screen reader in it, out of a toast's reach). And what it's told.
  const [unpinned, setUnpinned] = useState<{ pin: PinOf; kind: string; at: number }[]>([])
  const [said, setSaid] = useState('')
  const plugins = useServedPlugins()
  const setTheme = useSetTheme()
  const setShortcuts = useUi((ui) => ui.setShortcuts)
  const setCreate = useUi((ui) => ui.setCreate)
  const phone = useLayout() === 'phone'
  const linksOffered = useLinksOffered()
  const touch = useTouch()
  const setMetricsSource = useUi((ui) => ui.setMetricsSource)
  const open = useSearchParams()[0].get('open')
  const readOnly = useReadOnly()
  const switching = useSwitching()
  const lastSet = usePrefs((prefs) => prefs.severalSet).filter((name) =>
    contexts.some((c) => c.name === name),
  )
  const needle = search.trim().toLowerCase()
  // The cluster's objects that match, as Search finds them (LMV-171): best first, up to eight.
  const terms = useMemo(() => termsOf(search), [search])
  const finding = searches(terms) && needle.length >= MIN_OBJECT_QUERY
  const cluster = useClusterSearch(terms, finding)
  const found = useFound(cluster.kinds, terms, finding)
  // Their statuses, where Lumovi has a health for their kind, as their lists read them.
  const statusKinds = [
    ...new Map(
      found
        .filter(({ kind }) => hasHealth(kind.resource.kind))
        .map(({ kind }) => [kind.resource.kind, kind.resource]),
    ).values(),
  ]
  const statusLists = useListResponses(statusKinds)
  const statusOfUid = new Map(
    statusLists.flatMap((list, i) =>
      (list.data?.items ?? []).map(
        (object) => [object.metadata.uid, statusFor(statusKinds[i]!.kind, object)] as const,
      ),
    ),
  )
  const foundCount = cluster.kinds.reduce((sum, kind) => sum + kind.found.length, 0)
  const saved = useSavedSearches().saved
  const searchHere = (text: string) => run(() => go(searchPath(context, text)))()

  const run = (action: () => unknown) => () => {
    void action()
    onDone()
  }
  const go = useGo()
  const access = useMyAccess()
  // On a plugin's page, what it may do: Lumovi's own, with what's done with the open object.
  const [section, named] = useLocation().pathname.split('/').slice(3)
  const pluginHere =
    section === 'plugins' && named
      ? plugins.find((each) => each.plugin.name === decodeURIComponent(named))?.plugin
      : undefined
  const asks = pluginHere && (
    <Item
      icon={<ShieldCheck />}
      value={`What ${pluginHere.label} may do permissions plugin`}
      onSelect={run(() => go(pluginAsksPath(context, pluginHere.name)))}
    >
      What {pluginHere.label} may do
    </Item>
  )
  // The link to what's shown, heading Actions, no key: the panel's object's, which is the page's
  // too while it's open (so the page's isn't said twice); else the page's, before what it may do.
  const link =
    linksOffered &&
    (open ? (
      <Item
        icon={<Link />}
        value={`Copy link ${parseRef(open).name} share object`}
        hint={<span className="text-xs text-ink-3">{parseRef(open).name}</span>}
        onSelect={run(() => void copyLink())}
      >
        Copy link
      </Item>
    ) : (
      <Item
        icon={<Link />}
        value="Copy link to this view share page"
        onSelect={run(() => void copyLink())}
      >
        Copy link to this view
      </Item>
    ))
  const numbered = PINS_NUMBERED && !touch
  // The saved views: the open list's kind's first; all of them once something's typed.
  const here = listedKind(context, useLocation().pathname)
  const views = pinning.marks.views
  const viewsHere = here ? viewsOf(pinning.marks, here) : []
  const viewsElsewhere = needle ? views.filter((view) => view.kind !== here) : []
  const kindLabel = (kind: string) => served.get(kind)?.label ?? apiKindOf(kind)
  const deleteView = (view: (typeof views)[number]) => async () => {
    const { marks: next, at } = deletingView(pinning.latest(), view)
    const why = await pinning.save(next)
    if (why) return toast({ tone: 'error', title: why })
    toast({
      tone: 'success',
      title: `Deleted the view “${view.name}”`,
      action: {
        label: 'Undo',
        run: () =>
          void pinning
            .save(undeletingView(pinning.latest(), view, at))
            .then((no) => no && toast({ tone: 'error', title: no })),
      },
    })
  }
  const viewItems = (list: typeof views) =>
    list.flatMap((view) => {
      // (Judged once the cluster has said what it serves.)
      const gone = known !== undefined && !served.has(view.kind)
      const value = `${view.name} ${kindLabel(view.kind)} view ${view.kind}`
      return gone
        ? [
            <Item
              key={`${view.kind}/${view.name}`}
              icon={<Bookmark />}
              value={value}
              disabled
              hint={
                <span className="text-xs text-ink-3">
                  This cluster doesn’t serve {apiKindOf(view.kind)} any more
                </span>
              }
              onSelect={() => undefined}
            >
              {view.name}
            </Item>,
            <Item
              key={`${view.kind}/${view.name}/delete`}
              icon={<Bookmark />}
              value={`Delete ${value}`}
              onSelect={run(deleteView(view))}
            >
              Delete the view “{view.name}”
            </Item>,
          ]
        : [
            <Item
              key={`${view.kind}/${view.name}`}
              icon={<Bookmark />}
              value={value}
              hint={<span className="text-xs text-ink-3">{kindLabel(view.kind)}</span>}
              onSelect={run(() => openView(context, view, go))}
            >
              {view.name}
            </Item>,
          ]
    })
  const pinRows = pins.map((pin) => ({ pin, kind: kindName(pin, served) }))
  const chosenPin = pinRows.findIndex(({ pin, kind }) => pinValue(pin, kind) === chosen)
  const chosenUnpinned = unpinned.find(({ pin, kind }) => pinValue(pin, kind) === chosen)
  // The pins in their order, each unpinned here back where it was.
  const pinnedRows: (
    { pin: PinOf; kind: string; index: number } | { unpinned: (typeof unpinned)[number] }
  )[] = pinRows.map((row, index) => ({ ...row, index }))
  for (const each of [...unpinned].sort((a, b) => a.at - b.at)) {
    pinnedRows.splice(Math.min(each.at, pinnedRows.length), 0, { unpinned: each })
  }
  const unpinHere = async (pin: PinOf, kind: string) => {
    const { marks: next, at } = unpinning(pinning.latest(), pin)
    if (at < 0) return
    // Its row turns unpinned in the same moment it leaves the pins: the row it was, still chosen.
    setUnpinned((list) => [...list, { pin, kind, at }])
    const why = await pinning.save(next)
    if (why) {
      setUnpinned((list) => list.filter((each) => !samePin(each.pin, pin)))
      return setSaid(why)
    }
    setSaid(`Unpinned ${kind} ${spelled(pin.name)}.`)
  }
  const undo = async ({ pin, at }: (typeof unpinned)[number]) => {
    const why = await pinning.save(repinning(pinning.latest(), pin, at))
    if (why) return setSaid(why)
    setUnpinned((list) => list.filter((each) => !samePin(each.pin, pin)))
  }

  const onKeyDown = (event: KeyboardEvent) => {
    // ⌘↵, from any row: the cluster searched for what's typed.
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && needle) {
      event.preventDefault()
      searchHere(search)
      return
    }
    // With nothing typed, a saved search's key runs it (only a number it has a row for).
    const savedAt = search === '' && savedKeysHere(phone) ? savedNumber(event) : undefined
    if (savedAt !== undefined && saved[savedAt - 1]) {
      event.preventDefault()
      searchHere(saved[savedAt - 1]!)
      return
    }
    const number = pinNumber(event)
    if (number !== undefined) {
      const pin = numbered ? pins[number - 1] : undefined
      // (Nothing typed in the field either way: ⌥ with a number types a character on a Mac.)
      event.preventDefault()
      if (pin) run(() => go(pinPath(context, pin)))()
      return
    }
    // On one unpinned here, ↵ undoes; ⌫ and ⌥↑ ⌥↓ do nothing.
    if (
      chosenUnpinned &&
      (event.key === 'Backspace' ||
        (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')))
    ) {
      if (event.key !== 'Backspace' || search === '') event.preventDefault()
      return
    }
    if (chosenPin < 0) return
    const { pin, kind } = pinRows[chosenPin]!
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      // (Before cmdk, whose ⌥↑ and ⌥↓ go from group to group.)
      event.preventDefault()
      const to = chosenPin + (event.key === 'ArrowUp' ? -1 : 1)
      if (to >= 0 && to < pins.length) void pinning.save(movingPin(pinning.latest(), chosenPin, to))
    } else if (event.key === 'Backspace' && search === '' && !event.altKey && !event.metaKey) {
      event.preventDefault()
      void unpinHere(pin, kind)
    }
  }

  return (
    <Command
      loop
      filter={paletteMatch}
      value={chosen}
      onValueChange={setChosen}
      onKeyDown={onKeyDown}
      className="phone:flex phone:h-full phone:flex-col"
    >
      <div className="phone:flex phone:items-center phone:border-b phone:border-line phone:pr-1">
        <Command.Input
          autoFocus
          value={search}
          onValueChange={setSearch}
          placeholder="Jump to a page, object, namespace or cluster…"
          className="h-12 w-full border-b border-line bg-transparent px-4 text-[15px] text-ink-1 outline-none placeholder:text-ink-3 phone:min-w-0 phone:flex-1 phone:border-b-0"
        />
        <Dialog.Close aria-label="Close" className={cn(barButton, 'hidden phone:grid')}>
          <X />
        </Dialog.Close>
      </div>
      <Command.List className="max-h-[420px] overflow-y-auto p-2 phone:max-h-none phone:min-h-0 phone:flex-1 phone:pb-[max(0.5rem,var(--keyboard,0px))] [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-ink-3 [&_[cmdk-group-heading]]:uppercase">
        <Command.Empty className="py-10 text-center text-ink-3">No matches.</Command.Empty>
        {(pinnedRows.length > 0 || pinnedKinds.length > 0) && (
          <Command.Group heading="Pinned">
            {/* (One row each, by the pin: unpinned here, it stays the row it was, still chosen.) */}
            {pinnedRows.map((row) =>
              'unpinned' in row ? (
                <PinnedOption
                  key={formatRef(row.unpinned.pin)}
                  pin={row.unpinned.pin}
                  kind={row.unpinned.kind}
                  onOpen={() => undefined}
                  onUndo={() => void undo(row.unpinned)}
                />
              ) : (
                <PinnedOption
                  key={formatRef(row.pin)}
                  pin={row.pin}
                  kind={row.kind}
                  number={numbered && row.index < MARKS_LIMITS.numbered ? row.index + 1 : undefined}
                  onOpen={(to) => run(() => go(to))()}
                />
              ),
            )}
            {pinnedKinds.map((resource) => {
              const Icon = kindIcon(resource.kind)
              return (
                <Item
                  key={resource.kind}
                  icon={<Icon />}
                  value={`${resource.label} pinned kind`}
                  onSelect={run(() => go(kindPath(context, resource.kind)))}
                >
                  {resource.label}
                </Item>
              )
            })}
          </Command.Group>
        )}
        {viewsHere.length > 0 && (
          <Command.Group heading={`Views of ${kindLabel(here!)}`}>
            {viewItems(viewsHere)}
          </Command.Group>
        )}
        {viewsElsewhere.length > 0 && (
          <Command.Group heading="Views">{viewItems(viewsElsewhere)}</Command.Group>
        )}
        {open ? (
          <ObjectActions open={open} run={run} first={link} after={asks} />
        ) : (
          (link || asks) && (
            <Command.Group heading="Actions">
              {link}
              {asks}
            </Command.Group>
          )
        )}
        {search === '' && saved.length > 0 && (
          <Command.Group heading="Saved searches">
            {saved.map((text, i) => (
              <Item
                key={text}
                icon={<Search />}
                value={`${text} saved search`}
                hint={savedKeysHere(phone) && i < 9 && <Keys keys={savedKeyCaps(i + 1)} />}
                onSelect={() => searchHere(text)}
              >
                {text}
              </Item>
            ))}
          </Command.Group>
        )}
        <Command.Group heading="Go to">
          <Item
            icon={<LayoutDashboard />}
            value="Overview"
            hint={<Keys keys={['G', 'O']} />}
            onSelect={run(() => go(clusterPath(context)))}
          >
            Overview
          </Item>
          <Item
            icon={<Boxes />}
            value="Workloads"
            hint={<Keys keys={['G', 'W']} />}
            onSelect={run(() => go(workloadsPath(context)))}
          >
            Workloads
          </Item>
          <Item
            icon={<ChartSpline />}
            value="Metrics usage history Prometheus"
            hint={<Keys keys={['G', 'U']} />}
            onSelect={run(() => go(metricsPath(context)))}
          >
            Metrics
          </Item>
          <Item
            icon={<Bell />}
            value="Alerts firing pending Prometheus alerting rules"
            hint={<Keys keys={['G', 'Z']} />}
            onSelect={run(() => go(alertsPath(context)))}
          >
            Alerts
          </Item>
          <Item
            icon={<Scale />}
            value="Right-sizing requests recommendations over-provisioned savings"
            onSelect={run(() => go(rightsizingPath(context)))}
          >
            Right-sizing
          </Item>
          {RESOURCES.map((resource) => {
            const Icon = KIND_ICONS[resource.kind]
            const key = GO_KEYS.some((entry) => entry.target === resource.kind)
            return (
              <Item
                key={resource.kind}
                icon={<Icon />}
                value={`${resource.label} ${CATEGORY_LABELS[resource.category]}`}
                hint={
                  key ? (
                    <Keys keys={['G', goKey(resource.kind).toUpperCase()]} />
                  ) : (
                    <span className="text-xs text-ink-3">{CATEGORY_LABELS[resource.category]}</span>
                  )
                }
                onSelect={run(() => go(kindPath(context, resource.kind)))}
              >
                {resource.label}
              </Item>
            )
          })}
          {plugins.map(({ plugin, kinds }) => {
            const Icon = pluginIcon(plugin)
            return (
              <Item
                key={plugin.name}
                icon={<Icon />}
                value={`${plugin.label} plugin ${kinds.map((r) => r.label).join(' ')}`}
                hint={<span className="text-xs text-ink-3">Plugin</span>}
                onSelect={run(() => go(pluginPath(context, plugin.name)))}
              >
                {plugin.label}
              </Item>
            )
          })}
          {others.map((resource) => {
            const Icon = kindIcon(resource.kind)
            return (
              <Item
                key={resource.kind}
                icon={<Icon />}
                value={`${resource.label} ${resource.apiKind} ${resource.group} ${(resource.shortNames ?? []).join(' ')}`}
                hint={<span className="text-xs text-ink-3">{resource.group || 'core'}</span>}
                onSelect={run(() => go(kindPath(context, resource.kind)))}
              >
                {resource.label}
              </Item>
            )
          })}
          <Item
            icon={<ShipWheel />}
            value="Helm releases charts"
            hint={<Keys keys={['G', 'H']} />}
            onSelect={run(() => go(helmPath(context)))}
          >
            Helm releases
          </Item>
          <Item
            icon={<Blocks />}
            value="API resources kinds custom resources CRDs"
            onSelect={run(() => go(apiResourcesPath(context)))}
          >
            API resources
          </Item>
          <Item
            icon={<Plug />}
            value="All plugins what each asks for"
            onSelect={run(() => go(pluginsPath(context)))}
          >
            All plugins
          </Item>
        </Command.Group>
        {/* A plugin's commands: a group of their own, each only opening one of its pages. The
            plug stands in the icon's place, never the plugin's own icon, which it chooses. */}
        {plugins.some(({ plugin }) => plugin.added.commands.length > 0) && (
          <Command.Group heading="From plugins">
            {plugins.flatMap(({ plugin }) =>
              plugin.added.commands.map((command) => (
                <Item
                  key={`${plugin.name}/${command.name}`}
                  icon={<Plug />}
                  value={`${command.name} ${plugin.label}`}
                  hint={
                    <span className="max-w-[200px] min-w-0 truncate text-xs text-ink-3">
                      {plugin.label}
                    </span>
                  }
                  onSelect={run(() => go(pluginPagePath(context, plugin.name, command.page)))}
                  whole
                >
                  {command.name}
                </Item>
              )),
            )}
          </Command.Group>
        )}
        <Command.Group heading="Namespace">
          {/* The palette replaces: a namespace's row picks it alone, and All namespaces clears.
              (Adding one to the picked is the picker's.) The picked carry the check. */}
          <Item
            icon={<LayoutGrid />}
            value="All namespaces"
            hint={picked ? undefined : <Check className="size-4 text-accent" />}
            onSelect={run(() => setNamespace(null))}
          >
            All namespaces
          </Item>
          {namespaces.map(({ metadata: { name } }) => (
            <Item
              key={name}
              icon={<LayoutGrid />}
              value={`${name} namespace`}
              hint={picked?.includes(name) ? <Check className="size-4 text-accent" /> : undefined}
              onSelect={run(() => setNamespace(name))}
            >
              {name}
            </Item>
          ))}
        </Command.Group>
        {/* A server shows one cluster, unless it has a fleet. */}
        {switching && (
          <Command.Group heading="Clusters">
            {contexts.map(({ name }) => (
              <Item
                key={name}
                icon={<Server />}
                value={`${clusterName(name)} ${name} cluster`}
                onSelect={run(() => go(clusterPath(name)))}
              >
                {clusterName(name)}
              </Item>
            ))}
            {/* The set opened together last time (those that sign in wait for their Open there). */}
            {lastSet.length > 1 && !phone && (
              <Item
                icon={<Boxes />}
                value="Open the last several clusters together"
                onSelect={run(() => go(severalPath('pods', lastSet)))}
              >
                Open the last several clusters
              </Item>
            )}
            <Item icon={<LogOut />} value="All clusters" onSelect={run(() => go('/'))}>
              All clusters
            </Item>
          </Command.Group>
        )}
        <Command.Group heading="Help & appearance">
          {/* Nothing is written on a phone. */}
          {!phone && (
            <Item
              icon={<FilePlus2 />}
              value="Create new object form from YAML"
              hint={WINDOW_SHORTCUTS && <Keys keys={[MOD_KEY, 'N']} />}
              onSelect={run(() => setCreate(true))}
            >
              Create…
            </Item>
          )}
          {api.host === 'desktop' && (
            <Item
              icon={<SquareTerminal />}
              value="New terminal kubectl shell this computer"
              hint={<Keys keys={TERMINAL_KEYS.add} />}
              onSelect={run(() => useDock.getState().add(context, namespace ?? undefined))}
            >
              New terminal
            </Item>
          )}
          {api.desktop && (
            <Item
              icon={<AppWindow />}
              value="New window another cluster"
              hint={<Keys keys={[MOD_KEY, '⇧', 'N']} />}
              onSelect={run(() => void api.desktop!.newWindow())}
            >
              New window
            </Item>
          )}
          {!phone && (
            <Item
              icon={<Settings2 />}
              value="Metrics source Prometheus VictoriaMetrics settings"
              onSelect={run(() => setMetricsSource(true))}
            >
              Metrics source…
            </Item>
          )}
          {(api.assistants || api.serverAssistants) && (
            <Item
              icon={<Sparkles />}
              value="AI assistants agents MCP Claude Code Desktop Codex Cursor VS Code connect"
              onSelect={run(() => go('/assistants'))}
            >
              AI assistants…
            </Item>
          )}
          <Item
            icon={<ScrollText />}
            value="Audit log history who changed what activity events security"
            onSelect={run(() => go('/audit'))}
          >
            Audit log
          </Item>
          <Item
            icon={<Settings />}
            value="Settings preferences appearance theme accent density text size time zone clock terminal font shell namespaces updates"
            onSelect={run(() => go(`/cluster/${encodeURIComponent(context)}/settings`))}
          >
            Settings
          </Item>
          {access?.admin && (
            <Item
              icon={<Shield />}
              value="Access admin who may do what groups profiles grants limits permissions roles"
              hint={<span className="text-2xs text-ink-3">Admin</span>}
              onSelect={run(() => go('/access'))}
            >
              Access
            </Item>
          )}
          {access && (
            <Item
              icon={<ShieldCheck />}
              value="Your access what may I do permissions why can’t I"
              onSelect={run(() => go('/your-access'))}
            >
              Your access
            </Item>
          )}
          {!touch && (
            <Item
              icon={<Keyboard />}
              value="Keyboard shortcuts"
              hint={<Keys keys={['?']} />}
              onSelect={run(() => setShortcuts(true))}
            >
              Keyboard shortcuts
            </Item>
          )}
          {THEMES.map(({ value, label, icon: Icon }) => (
            <Item key={value} icon={<Icon />} value={label} onSelect={run(() => setTheme(value))}>
              {label}
            </Item>
          ))}
          {/* Only for those who may: on a server, Lumovi's admins (or anyone, where it has none). */}
          {readOnly.mayChange && !phone && (
            <Item
              icon={readOnly.readOnly ? <LockOpen /> : <Lock />}
              value={readOnly.readOnly ? 'Allow changes' : 'Make read-only'}
              onSelect={run(() => readOnly.set(!readOnly.readOnly))}
            >
              {readOnly.readOnly ? `Allow changes to ${context}` : `Make ${context} read-only`}
            </Item>
          )}
        </Command.Group>
        {/* (Last, after today's rows wherever they match: ↵ does what it did.) */}
        {/* (With nothing found once every kind has answered, "No matches." says so.) */}
        {finding &&
          (found.length > 0 || cluster.kinds.some((kind) => kind.state === 'waiting')) && (
            <Command.Group heading="Objects">
              {found.map(({ item, kind }) => {
                const Icon = kindIcon(kind.resource.kind)
                const ref = formatRef({
                  kind: kind.resource.kind,
                  name: item.name,
                  namespace: item.namespace,
                })
                return (
                  <Item
                    key={ref}
                    icon={<Icon />}
                    value={`${OBJECT_ROW}${item.name} ${kind.resource.kind} ${item.namespace ?? ''} object`}
                    hint={
                      <span className="flex items-center gap-2 text-xs text-ink-3">
                        {[kind.resource.apiKind, item.namespace].filter(Boolean).join(' · ')}
                        {statusOfUid.get(item.uid) && (
                          <StatusPill status={statusOfUid.get(item.uid)!} />
                        )}
                      </span>
                    }
                    onSelect={run(() =>
                      go(
                        `${kindPath(context, kind.resource.kind)}?open=${encodeURIComponent(ref)}`,
                      ),
                    )}
                  >
                    {item.name}
                  </Item>
                )
              })}
              <Item
                icon={<Search />}
                value={`${SEARCH_ROW}${search} search the cluster`}
                // (Its name stays its own: what's typed is the other rows' names.)
                label="Search the cluster"
                keys="Meta+Enter Control+Enter"
                hint={
                  <span className="flex items-center gap-2 text-xs text-ink-3">
                    {cluster.kinds.some((kind) => kind.state === 'waiting')
                      ? 'Searching…'
                      : `${foundCount.toLocaleString('en-US')} found`}
                    <Keys keys={[MOD, '↵']} />
                  </span>
                }
                onSelect={() => searchHere(search)}
              >
                Search the cluster for “{search.trim()}”
              </Item>
            </Command.Group>
          )}
      </Command.List>
      <p role="status" className="sr-only">
        {said}
      </p>
      {/* (Keys to press: of no use to a finger.) */}
      <footer className="flex items-center gap-4 border-t border-line px-4 py-2 text-xs text-ink-3 touch:hidden">
        {chosenUnpinned && (
          <span className="flex items-center gap-1.5">
            <Kbd>↵</Kbd> to undo
          </span>
        )}
        {chosenPin >= 0 && (
          <>
            <span className="flex items-center gap-1.5">
              <Kbd>{ALT_KEY === '⌥' ? '⌥↑' : `${ALT_KEY}+↑`}</Kbd>
              <Kbd>{ALT_KEY === '⌥' ? '⌥↓' : `${ALT_KEY}+↓`}</Kbd> to move the pin
            </span>
            {search === '' && (
              <span className="flex items-center gap-1.5">
                <Kbd>⌫</Kbd> to unpin
              </span>
            )}
          </>
        )}
        <span className="flex items-center gap-1.5">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> to move
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>
            <CornerDownLeft className="size-3" />
          </Kbd>{' '}
          to select
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>esc</Kbd> to close
        </span>
      </footer>
    </Command>
  )
}

/**
 * A pinned object's row, as the sidebar's: its kind's icon, its name, its namespace quietly, its
 * status now as a dot, and its number key. One that's gone is struck through and opens its
 * kind's list filtered to its name, as one that can't be read does. Unpinned here (`onUndo`), it
 * says so where it was, its crossed pin and its name quiet (not struck, as a gone one is), and ↵
 * undoes it.
 */
function PinnedOption({
  pin,
  kind,
  number,
  onOpen,
  onUndo,
}: {
  pin: PinOf
  kind: string
  number?: number
  onOpen: (to: string) => void
  onUndo?: () => void
}) {
  const { context } = useCluster()
  const object = useObject(pin.kind, pin.name, pin.namespace)
  const code = object.error instanceof KubeApiError ? object.error.code : undefined
  const gone = code === 'not-found'
  const unreadable = code === 'forbidden' || code === 'not-allowed'
  const status = object.data && !gone && !unreadable ? statusOf(pin.kind, object.data) : undefined
  const called = `${kind} ${spelled(pin.name)}${pin.namespace ? ` in ${pin.namespace}` : ''}`
  const to =
    gone || unreadable
      ? `${kindPath(context, pin.kind)}?q=${encodeURIComponent(pin.name)}`
      : pinPath(context, pin)
  if (onUndo) {
    return (
      <Item
        icon={<PinOff />}
        value={pinValue(pin, kind)}
        label={`${kind} ${spelled(pin.name)}: unpinned. Enter undoes it.`}
        hint={
          <span className="shrink-0 text-xs text-ink-3">
            Unpinned · <span className="text-accent-strong">Undo</span>
          </span>
        }
        onSelect={onUndo}
      >
        <span className="text-ink-3">
          <TheirText text={{ their: pin.name }} inline />
        </span>
      </Item>
    )
  }
  return (
    <Item
      icon={<KindIcon kind={pin.kind} />}
      value={pinValue(pin, kind)}
      label={
        gone
          ? `${called}: not in the cluster any more`
          : unreadable
            ? `${called}: you can’t read it any more`
            : status
              ? `${called}, ${status.label}`
              : called
      }
      keys="Alt+ArrowUp Alt+ArrowDown Backspace"
      hint={
        <span className="flex min-w-0 items-center gap-2">
          {pin.namespace && (
            <span className="min-w-0 truncate text-xs text-ink-3">
              <TheirText text={{ their: pin.namespace }} inline />
            </span>
          )}
          {status && <StatusDot health={status.health} />}
          {number !== undefined && (
            <span aria-hidden className="shrink-0">
              <Kbd>{pinKey(number)}</Kbd>
            </span>
          )}
        </span>
      }
      onSelect={() => onOpen(to)}
    >
      <span
        className={cn(
          (gone || unreadable) && 'text-ink-3',
          gone && 'line-through [&_*]:line-through',
        )}
      >
        <TheirText text={{ their: pin.name }} inline />
      </span>
    </Item>
  )
}

/**
 * Actions for the object in the detail panel, listed first (`first` heads them); and `after` them,
 * the page's.
 */
function ObjectActions({
  open,
  run,
  first,
  after,
}: {
  open: string
  run: (action: () => unknown) => () => void
  first?: ReactNode
  after?: ReactNode
}) {
  const target = parseRef(open)
  const object = useObject(target.kind, target.name, target.namespace).data
  if (object) return <ObjectActionItems object={object} run={run} first={first} after={after} />
  return first || after ? (
    <Command.Group heading="Actions">
      {first}
      {after}
    </Command.Group>
  ) : null
}

function ObjectActionItems({
  object,
  run,
  first,
  after,
}: {
  object: KubeObject
  run: (action: () => unknown) => () => void
  first?: ReactNode
  after?: ReactNode
}) {
  const available = useObjectActions(object)
  const start = useRunAction()
  const { pinned, toggle } = usePinning()
  const kind = kindOf(object)
  const pin: PinOf = {
    kind,
    name: object.metadata.name,
    ...(object.metadata.namespace ? { namespace: object.metadata.namespace } : {}),
  }
  const called = `${apiKindOf(kind)} ${spelled(pin.name)}`
  const on = pinned(pin)
  const { context } = useCluster()
  const kept = useDock((dock) => Boolean(dock.keptOf(context, pin)))
  // (Nothing to do to it and nothing to pin: no Actions of its own. Its panel keeps it below.)
  if (available.length === 0 && !pinnable(kind)) {
    return first || after ? (
      <Command.Group heading="Actions">
        {first}
        {after}
      </Command.Group>
    ) : null
  }
  return (
    <Command.Group heading="Actions">
      {first}
      {available.map(({ action, disabled }) => (
        <Item
          key={action.id}
          icon={<action.icon />}
          value={`${action.label} ${object.metadata.name} action`}
          disabled={disabled !== undefined}
          hint={<span className="text-xs text-ink-3">{object.metadata.name}</span>}
          onSelect={run(() => start(action, object))}
        >
          {action.label}
        </Item>
      ))}
      {pinnable(kind) && (
        <Item
          icon={on ? <PinOff /> : <Pin />}
          value={`${on ? 'Unpin' : 'Pin'} ${object.metadata.name} sidebar action`}
          hint={<Keys keys={[PIN_KEY]} />}
          onSelect={run(() => toggle(pin, called))}
        >
          {on ? 'Unpin' : 'Pin'} {called}
        </Item>
      )}
      {api.desktop && (
        <Item
          icon={<PanelBottom />}
          value={`Keep open below ${object.metadata.name} tabs below`}
          onSelect={run(() => {
            const { panelTab, keep } = useDock.getState()
            const tab = panelTab?.ref === formatRef(pin) ? panelTab.tab : 'overview'
            keep(context, pin, tab)
          })}
        >
          {kept ? 'Show below' : 'Keep open below'}
        </Item>
      )}
      {after}
    </Command.Group>
  )
}

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="flex gap-1">
      {keys.map((key) => (
        <Kbd key={key}>{key}</Kbd>
      ))}
    </span>
  )
}

function Item({
  icon,
  hint,
  value,
  onSelect,
  disabled,
  whole = false,
  label,
  keys,
  children,
}: {
  icon: ReactNode
  hint?: ReactNode
  value: string
  onSelect: () => void
  disabled?: boolean
  /** Its name for a screen reader, where what's drawn says less (or draws marks). */
  label?: string
  /** The keys that work on it (aria-keyshortcuts). */
  keys?: string
  /** Its name is never cut: what's beside it gives way. */
  whole?: boolean
  children: ReactNode
}) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      disabled={disabled}
      aria-label={label}
      aria-keyshortcuts={keys}
      className="flex h-10 cursor-default items-center gap-3 rounded-lg px-2.5 text-[13.5px] text-ink-1 select-none data-[disabled=true]:opacity-45 data-[selected=true]:bg-surface-3 touch:h-11 touch:active:bg-surface-3 touch:data-[selected=true]:bg-transparent [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-ink-3"
    >
      {icon}
      <span className={whole ? 'flex-1 shrink-0 whitespace-nowrap' : 'flex-1 truncate'}>
        {children}
      </span>
      {hint}
    </Command.Item>
  )
}

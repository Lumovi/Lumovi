import { X } from 'lucide-react'
import { barButton } from '@renderer/components/Sheet'
import { cn } from '@renderer/lib/cn'
import { useLayout, useTouch } from '@renderer/lib/layout'
import { useQueryClient } from '@tanstack/react-query'
import { Command } from 'cmdk'
import {
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
  Pin,
  PinOff,
  Scale,
  ScrollText,
  Server,
  Settings2,
  Shield,
  ShieldCheck,
  ShipWheel,
  Sparkles,
  Sun,
  Boxes,
  SquareTerminal,
} from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { useLocation, useSearchParams } from 'react-router'
import type { KubeList, KubeObject } from '@shared/api'
import { spelled } from '@shared/kit/characters'
import { MARKS_LIMITS, samePin, type Pin as PinOf } from '@shared/marks'
import { GO_KEYS } from '@shared/navigation'
import { apiKindOf, isBuiltinKind, kindOf, RESOURCES } from '@shared/resources'
import { pluginIcon, KIND_ICONS, KindIcon, kindIcon } from '@renderer/components/KindIcon'
import { StatusDot } from '@renderer/components/Status'
import { ALT_KEY, Kbd, MOD_KEY, WINDOW_SHORTCUTS } from '@renderer/components/Kbd'
import { useGo } from '@renderer/hooks/go'
import { usePinning } from '@renderer/hooks/marks'
import { useContexts, useList, useObject } from '@renderer/hooks/queries'
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
} from '@renderer/lib/routes'
import { api, KubeApiError } from '@renderer/lib/api'
import { statusOf } from '@renderer/lib/health'
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
import { openView } from '../resources/views'
import { PIN_KEY } from '../details/PinButton'
import { useDock } from '../terminal/dock'
import { TERMINAL_KEYS } from '../terminal/keys'
import { kindName, pinKey, pinNumber, pinPath, PINS_NUMBERED } from './PinnedObjects'
import { CATEGORY_LABELS } from './Sidebar'

const THEMES = [
  { value: 'system', label: 'Use system theme', icon: Monitor },
  { value: 'light', label: 'Use light theme', icon: Sun },
  { value: 'dark', label: 'Use dark theme', icon: Moon },
] as const

/** Objects are searched once the query is this long. */
const MIN_OBJECT_QUERY = 2
const MAX_OBJECTS = 20

const goKey = (target: string) => GO_KEYS.find((entry) => entry.target === target)!.key

/** A pinned object's row: told apart from the same object found by its name ("object"). */
const pinValue = (pin: PinOf, kind: string) =>
  `${pin.name} ${kind} ${pin.namespace ?? ''} pinned ${formatRef(pin)}`

/** Every object in the lists already loaded for this cluster, without duplicates. */
function useCachedObjects(context: string): KubeObject[] {
  const queryClient = useQueryClient()
  const seen = new Map<string, KubeObject>()
  for (const [, list] of queryClient.getQueriesData<KubeList>({ queryKey: ['list', context] })) {
    for (const object of list?.items ?? []) {
      seen.set(`${kindOf(object)}/${object.metadata.namespace}/${object.metadata.name}`, object)
    }
  }
  return [...seen.values()]
}

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
  const touch = useTouch()
  const setMetricsSource = useUi((ui) => ui.setMetricsSource)
  const objects = useCachedObjects(context)
  const open = useSearchParams()[0].get('open')
  const readOnly = useReadOnly()
  const switching = useSwitching()
  const needle = search.trim().toLowerCase()
  const matches =
    needle.length < MIN_OBJECT_QUERY
      ? []
      : objects.filter((o) => o.metadata.name.includes(needle)).slice(0, MAX_OBJECTS)

  const run = (action: () => unknown) => () => {
    void action()
    onDone()
  }
  const go = useGo()
  const access = useMyAccess()
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
      filter={matchWords}
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
        {open && <ObjectActions open={open} run={run} />}
        {matches.length > 0 && (
          <Command.Group heading="Objects">
            {matches.map((object) => {
              const kind = kindOf(object)
              const Icon = kindIcon(kind)
              const ref = formatRef({
                kind,
                name: object.metadata.name,
                namespace: object.metadata.namespace,
              })
              return (
                <Item
                  key={ref}
                  icon={<Icon />}
                  value={`${object.metadata.name} ${object.kind} ${object.metadata.namespace ?? ''} object`}
                  hint={
                    <span className="text-xs text-ink-3">
                      {object.metadata.namespace ?? object.kind}
                    </span>
                  }
                  onSelect={run(() =>
                    go(`${kindPath(context, kind)}?open=${encodeURIComponent(ref)}`),
                  )}
                >
                  {object.metadata.name}
                </Item>
              )
            })}
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

/** Actions for the object in the detail panel, listed first. */
function ObjectActions({
  open,
  run,
}: {
  open: string
  run: (action: () => unknown) => () => void
}) {
  const target = parseRef(open)
  const object = useObject(target.kind, target.name, target.namespace).data
  return object ? <ObjectActionItems object={object} run={run} /> : null
}

function ObjectActionItems({
  object,
  run,
}: {
  object: KubeObject
  run: (action: () => unknown) => () => void
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
  // (Nothing to do to it, and nothing to pin: no Actions at all.)
  if (available.length === 0 && !pinnable(kind)) return null
  return (
    <Command.Group heading="Actions">
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

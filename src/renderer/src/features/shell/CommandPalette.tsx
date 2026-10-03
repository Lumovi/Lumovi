import { useQueryClient } from '@tanstack/react-query'
import { Command } from 'cmdk'
import {
  Blocks,
  ChartSpline,
  CornerDownLeft,
  FilePlus2,
  Keyboard,
  LayoutDashboard,
  LayoutGrid,
  Lock,
  LockOpen,
  LogOut,
  Monitor,
  Moon,
  Scale,
  Server,
  Settings2,
  ShipWheel,
  Sun,
  Boxes,
} from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import type { KubeList, KubeObject } from '@shared/api'
import { GO_KEYS } from '@shared/navigation'
import { isBuiltinKind, kindOf, RESOURCES } from '@shared/resources'
import { addOnIcon, KIND_ICONS, kindIcon } from '@renderer/components/KindIcon'
import { Kbd, MOD_KEY, WINDOW_SHORTCUTS } from '@renderer/components/Kbd'
import { useGo } from '@renderer/hooks/go'
import { useContexts, useList, useObject } from '@renderer/hooks/queries'
import { useAddOns } from '@renderer/hooks/add-ons'
import { useResources } from '@renderer/hooks/resources'
import { useReadOnly, useSetTheme } from '@renderer/hooks/settings'
import { api } from '@renderer/lib/api'
import { matchWords } from '@renderer/lib/match'
import {
  addOnPath,
  apiResourcesPath,
  clusterPath,
  helmPath,
  formatRef,
  kindPath,
  metricsPath,
  rightsizingPath,
  workloadsPath,
  parseRef,
} from '@renderer/lib/routes'
import { useCluster } from '@renderer/state/cluster'
import { keepFocusInActionDialog } from '@renderer/state/actions'
import { useUi } from '@renderer/state/ui'
import { useObjectActions, useRunAction } from '../actions/use-actions'
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
          className="fixed top-[14vh] left-1/2 z-50 w-[640px] max-w-[calc(100vw-48px)] -translate-x-1/2 animate-pop-in overflow-hidden rounded-2xl border border-line-strong bg-surface-2 shadow-pop outline-none"
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <Palette onDone={() => setOpen(false)} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Palette({ onDone }: { onDone: () => void }) {
  const { context, setNamespace } = useCluster()
  const [search, setSearch] = useState('')
  const contexts = useContexts().data?.contexts ?? []
  const namespaces = useList('Namespace', { namespace: null }).data ?? []
  // The cluster's other kinds, custom resources included.
  const others = (useResources().data ?? []).filter((r) => !isBuiltinKind(r.kind))
  const addOns = useAddOns()
  const setTheme = useSetTheme()
  const setShortcuts = useUi((ui) => ui.setShortcuts)
  const setCreate = useUi((ui) => ui.setCreate)
  const setMetricsSource = useUi((ui) => ui.setMetricsSource)
  const objects = useCachedObjects(context)
  const open = useSearchParams()[0].get('open')
  const readOnly = useReadOnly()
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

  return (
    <Command loop filter={matchWords}>
      <Command.Input
        autoFocus
        value={search}
        onValueChange={setSearch}
        placeholder="Jump to a view, object, namespace or cluster…"
        className="h-12 w-full border-b border-line bg-transparent px-4 text-[15px] text-ink-1 outline-none placeholder:text-ink-3"
      />
      <Command.List className="max-h-[420px] overflow-y-auto p-2 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-ink-3 [&_[cmdk-group-heading]]:uppercase">
        <Command.Empty className="py-10 text-center text-ink-3">No matches.</Command.Empty>
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
          {addOns.map(({ addOn, kinds }) => {
            const Icon = addOnIcon(addOn)
            return (
              <Item
                key={addOn.name}
                icon={<Icon />}
                value={`${addOn.label} add-on ${kinds.map((r) => r.label).join(' ')}`}
                hint={<span className="text-xs text-ink-3">Add-on</span>}
                onSelect={run(() => go(addOnPath(context, addOn.name)))}
              >
                {addOn.label}
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
            value="API resources kinds custom resources CRDs views"
            onSelect={run(() => go(apiResourcesPath(context)))}
          >
            API resources
          </Item>
        </Command.Group>
        <Command.Group heading="Namespace">
          <Item
            icon={<LayoutGrid />}
            value="All namespaces"
            onSelect={run(() => setNamespace(null))}
          >
            All namespaces
          </Item>
          {namespaces.map(({ metadata: { name } }) => (
            <Item
              key={name}
              icon={<LayoutGrid />}
              value={`${name} namespace`}
              onSelect={run(() => setNamespace(name))}
            >
              {name}
            </Item>
          ))}
        </Command.Group>
        {/* A server shows one cluster. */}
        {api.host === 'desktop' && (
          <Command.Group heading="Clusters">
            {contexts.map(({ name }) => (
              <Item
                key={name}
                icon={<Server />}
                value={`${name} cluster`}
                onSelect={run(() => go(clusterPath(name)))}
              >
                {name}
              </Item>
            ))}
            <Item icon={<LogOut />} value="All clusters" onSelect={run(() => go('/'))}>
              All clusters
            </Item>
          </Command.Group>
        )}
        <Command.Group heading="Help & appearance">
          <Item
            icon={<FilePlus2 />}
            value="Create from YAML new object"
            hint={WINDOW_SHORTCUTS && <Keys keys={[MOD_KEY, 'N']} />}
            onSelect={run(() => setCreate(true))}
          >
            Create from YAML
          </Item>
          <Item
            icon={<Settings2 />}
            value="Metrics source Prometheus VictoriaMetrics settings"
            onSelect={run(() => setMetricsSource(true))}
          >
            Metrics source…
          </Item>
          <Item
            icon={<Keyboard />}
            value="Keyboard shortcuts"
            hint={<Keys keys={['?']} />}
            onSelect={run(() => setShortcuts(true))}
          >
            Keyboard shortcuts
          </Item>
          {THEMES.map(({ value, label, icon: Icon }) => (
            <Item key={value} icon={<Icon />} value={label} onSelect={run(() => setTheme(value))}>
              {label}
            </Item>
          ))}
          {!readOnly.locked && (
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
      <footer className="flex items-center gap-4 border-t border-line px-4 py-2 text-xs text-ink-3">
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
  if (available.length === 0) return null
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
  children,
}: {
  icon: ReactNode
  hint?: ReactNode
  value: string
  onSelect: () => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      disabled={disabled}
      className="flex h-10 cursor-default items-center gap-3 rounded-lg px-2.5 text-[13.5px] text-ink-1 select-none data-[disabled=true]:opacity-45 data-[selected=true]:bg-surface-3 [&_svg]:size-4 [&_svg]:text-ink-3"
    >
      {icon}
      <span className="flex-1 truncate">{children}</span>
      {hint}
    </Command.Item>
  )
}

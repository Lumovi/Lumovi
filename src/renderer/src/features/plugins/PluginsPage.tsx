/**
 * Every plugin there is: Lumovi's own and a folder's files, each once. What's in use, what isn't
 * and why, and, opened, what a plugin asks for: read from its file and said in Lumovi's words.
 * Nothing here changes anything.
 */
import {
  ArrowLeft,
  Check,
  CircleDashed,
  FileCode2,
  Info,
  Lock,
  Minus,
  SearchX,
  TriangleAlert,
} from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Fragment, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { asks, type Asks } from '@shared/plugin-asks'
import type { ChangeAction } from '@shared/plugin-changes'
import { codeOff, notHandedLine } from '@shared/plugin-hand-over'
import type { Loaded } from '@shared/plugin-loading'
import { plain, PLUGIN_NAME, type Plugin } from '@shared/plugins'
import { apiKindOf, type ResourceDefinition, type ResourceKind } from '@shared/resources'
import { PluginIcon } from '@renderer/components/KindIcon'
import { SearchInput } from '@renderer/components/SearchInput'
import { EmptyState, Loading } from '@renderer/components/States'
import { Switch } from '@renderer/components/Switch'
import { Tooltip } from '@renderer/components/Tooltip'
import { LockedBadge } from '@renderer/features/access/parts'
import { usePlugins } from '@renderer/hooks/plugins'
import { useSettings } from '@renderer/hooks/settings'
import { switchesOf } from '@renderer/plugins/code-switches'
import { toast } from '@renderer/state/toasts'
import { useResources } from '@renderer/hooks/resources'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { useLayout, useTouch } from '@renderer/lib/layout'
import { CODE_PAGES } from '@renderer/lib/code-pages'
import { PLUGIN_PAGES } from './integrations'
import type { Reach } from '@shared/kit/declare'
import { ASKED_PLUGIN, AT_SWITCH } from '@renderer/lib/routes'
import { useCluster } from '@renderer/state/cluster'
import {
  offerFor,
  releaseOf,
  StoreLine,
  timeOf,
  useNotHere,
  usePluginStore,
  type Offer,
} from './store'

/**
 * A line of the list: one of Lumovi's plugins, a file of the folder, or one of Lumovi-plugins'
 * latest release that this Lumovi doesn't carry (`store`).
 */
interface Row {
  key: string
  /** As the sidebar has it; a file that holds no plugin goes by its name. */
  title: string
  plugin?: Plugin
  origin: 'lumovi' | 'yours' | 'server' | 'store'
  file?: string
  /** `replaced`: one of Lumovi's with a file in its place. `not-here`: one this Lumovi lacks. */
  state: Loaded['state'] | 'replaced' | 'not-here'
  /** What Lumovi-plugins' latest release offers for it: a newer version, or one too new. */
  offer?: Offer
  /** The store's release it's from, for one this Lumovi lacks. */
  release?: string
  /** For one in Lumovi's place, that plugin; for one of Lumovi's replaced, the file. */
  lumovis?: Plugin
  replacedBy?: string
  problems: string[]
  /** The cluster serves one of its kinds. */
  here: boolean
}

type Filter = 'all' | 'here' | 'yours' | 'unused' | 'updates' | 'not-here'

/** The filters of what the store found: shown only where they'd list something. */
const FOUND: readonly Filter[] = ['updates', 'not-here']

const HOST = api.host === 'desktop' ? 'yours' : 'server'
const label = (plugin: Plugin) => plugin.place?.label ?? plugin.name
const inUse = (row: Row) => row.state === 'in-use' || row.state === 'in-place-of'
/** Whether it's in the page's own list: any but one this Lumovi lacks. */
const carried = (row: Row) => row.state !== 'not-here'

/** "Pods and Jobs", "Pods, Jobs and Secrets". */
function listed(names: string[]): string {
  return names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** How a kind is named: as the cluster does where it serves it, else as the file does. */
function useKindNames() {
  const resources = useResources().data ?? []
  const served = new Map<ResourceKind, ResourceDefinition>(resources.map((r) => [r.kind, r]))
  const bare = (kind: ResourceKind) =>
    kind.includes('.') ? kind.slice(0, kind.indexOf('.')) : kind
  return {
    served,
    /** "Certificates", or "Certificate" where the cluster hasn't the kind. */
    plural: (kind: ResourceKind) =>
      kind.startsWith('*.')
        ? `every kind of ${kind.slice(2)}`
        : (served.get(kind)?.label ?? bare(kind)),
    bare: (kind: ResourceKind) =>
      kind.startsWith('*.') ? `every kind of ${kind.slice(2)}` : bare(kind),
    /** Whether the cluster serves it (for every kind of a group: any kind of that group). */
    here: (kind: ResourceKind) =>
      kind.startsWith('*.') ? resources.some((r) => r.group === kind.slice(2)) : served.has(kind),
  }
}

export function PluginsPage() {
  const { context } = useCluster()
  const plugins = usePlugins().data
  const names = useKindNames()
  const phone = useLayout() === 'phone'
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState('')
  // What's newer in Lumovi-plugins (the desktop app's): checked as the page opens.
  const store = usePluginStore()
  const release = releaseOf(store.check)
  const lumovi = plugins?.lumovi ?? '0.0.0'
  const notHere = useNotHere(
    release,
    new Set([
      ...(plugins?.included ?? []).map(({ name }) => name),
      ...(plugins?.files ?? []).flatMap(({ plugin }) => (plugin ? [plugin.name] : [])),
    ]),
    lumovi,
  )
  // The address may name a plugin to open (a link to what it asks for). A name only: anything
  // that isn't one, or that no plugin here has, opens nothing.
  const [params, setParams] = useSearchParams()
  const named = params.get(ASKED_PLUGIN)
  const asked = named !== null && PLUGIN_NAME.test(named) ? named : undefined
  // And whether its "Run its code" takes the focus: where "Open Plugins" on its page came here.
  const atSwitch = (plugin: Plugin) => asked === plugin.name && params.get(AT_SWITCH) === '1'
  // What a person opened or closed by hand, and the name the address had then (`instead`):
  // their choice holds while the address names none, and gives way when it names another.
  const [byHand, setByHand] = useState<{ key?: string; instead?: string }>()
  if (byHand && asked !== byHand.instead) {
    // The address has moved on since: to no name (the hand's choice is now all there is), or to
    // another plugin, whose row is the one to open.
    setByHand(asked === undefined ? { key: byHand.key } : undefined)
  }
  // The row the address asked for is brought into view by its own first line (the plugin's
  // name, not only what it asks under it), once each time the address names one.
  const broughtIntoView = useRef<string>(undefined)
  useEffect(() => {
    if (asked === undefined) broughtIntoView.current = undefined
  }, [asked])
  const intoView = (element: HTMLElement | null) => {
    if (!element || !asked || broughtIntoView.current === asked) return
    broughtIntoView.current = asked
    element.scrollIntoView({ block: 'start' })
  }

  if (!plugins) return <Loading label="Reading the plugins…" />

  const here = (plugin: Plugin) =>
    [...(plugin.place?.kinds ?? []), ...plugin.views.flatMap((view) => view.kinds)].some(names.here)
  const rows: Row[] = [
    ...plugins.included.map((plugin): Row => {
      const replacing = plugins.files.find(
        (file) => file.state === 'in-place-of' && file.lumovis === plugin,
      )
      const replacedBy = replacing && plain(replacing.file)
      const offer = replacedBy ? undefined : offerFor(plugin, release, lumovi)
      return {
        key: `lumovi:${plugin.name}`,
        title: label(plugin),
        plugin,
        origin: 'lumovi',
        state: replacedBy ? 'replaced' : 'in-use',
        replacedBy,
        problems: [],
        here: here(plugin),
        ...(offer ? { offer } : {}),
      }
    }),
    ...plugins.files.map((file): Row => ({
      key: `file:${file.file}`,
      // (A file's name is the file's to choose: shown with nothing in it that can't be seen.)
      title: file.plugin ? label(file.plugin) : plain(file.file),
      plugin: file.plugin,
      origin: HOST,
      file: plain(file.file),
      state: file.state,
      lumovis: file.lumovis,
      // (Under the file's own row, its name needn't be said again on each.)
      problems: file.problems.map((problem) =>
        problem.startsWith(`${file.file}: `) ? problem.slice(file.file.length + 2) : problem,
      ),
      here: file.plugin ? here(file.plugin) : false,
    })),
    // (Listed under their own filter alone: they aren't this Lumovi's.)
    ...notHere.map(({ plugin, needs }): Row => ({
      key: `store:${plugin.name}`,
      title: label(plugin),
      plugin,
      origin: 'store',
      state: 'not-here',
      problems: [],
      here: here(plugin),
      release: release!.version,
      ...(needs ? { offer: { needs: { version: plugin.version, lumovi: needs } } } : {}),
    })),
  ]
  const FILTERS: [Filter, string, (row: Row) => boolean][] = [
    ['all', 'All', carried],
    ['here', 'On this cluster', (row) => inUse(row) && row.here],
    ['yours', HOST === 'yours' ? 'Yours' : 'This server’s', (row) => row.origin === HOST],
    ['unused', 'Not in use', (row) => carried(row) && !inUse(row)],
    ['updates', 'Updates', (row) => row.offer !== undefined && 'update' in row.offer],
    ['not-here', 'Not here yet', (row) => !carried(row)],
  ]
  // The store's filters only where they'd list something: one that empties while it's on gives
  // way to All, without a word.
  const offered = FILTERS.filter(([key, , matches]) => !FOUND.includes(key) || rows.some(matches))
  const active = offered.find(([key]) => key === filter) ?? offered[0]!
  const needle = search.trim().toLowerCase()
  const shown = rows
    .filter(active[2])
    .filter((row) =>
      `${row.title} ${row.plugin?.name ?? ''} ${row.file ?? ''}`.toLowerCase().includes(needle),
    )
  // (Files, as the filter beside it counts them: one that holds no plugin is still theirs.)
  const own = rows.filter((row) => row.origin === HOST).length
  // A column at the rows' end, only where a row has something for it: over all of them, so a
  // filter never moves the columns.
  const offers = rows.some((row) => row.offer !== undefined && 'needs' in row.offer)
  const columns = offers ? 4 : 3
  // What the filter draws from: the page's own list, or (Not here yet) what this Lumovi lacks.
  const drawnFrom = rows.filter(active[0] === 'not-here' ? (row) => !carried(row) : carried)
  // Where the last check failed, its filters say whose they are: the last good check's.
  const keptFrom =
    store.check?.state === 'failed' && store.check.last
      ? `From the check at ${timeOf(store.check.last.checked)}`
      : undefined
  // Of two rows with the asked name, the one in use: what the link was about.
  const askedRow = asked
    ? (rows.find((row) => row.plugin?.name === asked && inUse(row)) ??
      rows.find((row) => row.plugin?.name === asked))
    : undefined
  const opened = byHand ? byHand.key : askedRow?.key
  const setOpened = (key: string | undefined) => {
    setByHand({ key, instead: asked })
    // (Closed or changed by hand, the address stops naming one: back and reload show the page.)
    if (named !== null) {
      params.delete(ASKED_PLUGIN)
      setParams(params, { replace: true })
    }
  }
  const selected = rows.find((row) => row.key === opened)

  // On a phone a plugin opens as a page of its own, with a way back.
  if (phone && selected?.plugin) {
    return (
      <div className="flex h-full flex-col overflow-y-auto">
        <button
          type="button"
          onClick={() => setOpened(undefined)}
          className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4 text-left text-[13px] font-medium text-ink-2"
        >
          <ArrowLeft className="size-4" /> All plugins
        </button>
        <Opening />
        <Card row={selected} names={names} directory={plugins.directory} />
        <WhatItAsks plugin={selected.plugin} names={names} focus={atSwitch(selected.plugin)} />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* (On a phone it's the first thing on a plugin's own page, not above the list.) */}
        {!phone && <Opening />}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-5 py-3 phone:px-4">
          <span className="text-[13px] text-ink-2 tabular-nums">
            {plugins.included.length} from Lumovi
            {own > 0 && (HOST === 'yours' ? `, ${own} of yours` : `, ${own} from this server`)}
          </span>
          <div
            role="group"
            aria-label="Which plugins"
            // (The one thing here that scrolls sideways on a narrow page, and says so.)
            data-scrolls-sideways
            className="flex max-w-full [scrollbar-width:none] gap-0.5 overflow-x-auto rounded-lg bg-surface-2 p-0.5"
          >
            {offered.map(([key, text, matches]) => {
              const button = (
                <button
                  key={key}
                  type="button"
                  aria-pressed={active[0] === key}
                  onClick={() => setFilter(key)}
                  className={cn(
                    'h-8 shrink-0 rounded-md px-2.5 text-[13px] whitespace-nowrap text-ink-2 phone:h-11 phone:px-2 phone:text-xs',
                    active[0] === key && 'bg-surface font-medium text-ink-1 shadow-sm',
                  )}
                >
                  {text} <span className="tabular-nums">{rows.filter(matches).length}</span>
                </button>
              )
              return FOUND.includes(key) && keptFrom ? (
                <Tooltip key={key} content={keptFrom}>
                  {button}
                </Tooltip>
              ) : (
                button
              )
            })}
          </div>
          <div className="flex-1" />
          <SearchInput
            value={search}
            onChange={setSearch}
            // Down goes from the search to the first plugin.
            onArrowDown={() => document.querySelector<HTMLElement>('[data-plugin-row]')?.focus()}
            placeholder="Search plugins"
            className="w-60 phone:w-full"
          />
          {/* (A row of its own, at its right: so nothing moves as a check ends.) */}
          {store.there && (
            <div className="flex basis-full justify-end">
              <StoreLine store={store} />
            </div>
          )}
        </div>
        {plugins.shipped.length > 0 && (
          // (Never in a release: what's wrong with one of Lumovi's own is found when it's built.)
          <ul
            aria-label="Problems with Lumovi’s plugins"
            className="space-y-0.5 border-b border-line bg-warn/8 px-5 py-2.5 font-mono text-xs text-ink-2 phone:px-4"
          >
            {plugins.shipped.map((problem) => (
              <li key={problem} className="break-words">
                {problem}
              </li>
            ))}
          </ul>
        )}
        {shown.length === 0 ? (
          <EmptyState icon={SearchX} title="Nothing matches">
            No plugin here matches.
          </EmptyState>
        ) : phone ? (
          <ul aria-label="Plugins">
            {shown.map((row) => (
              <li key={row.key} className="border-b border-line">
                <button
                  type="button"
                  disabled={!row.plugin}
                  onClick={() => setOpened(row.key)}
                  className="block w-full text-left"
                >
                  <Card row={row} names={names} directory={plugins.directory} />
                </button>
                <Problems row={row} />
              </li>
            ))}
          </ul>
        ) : (
          <table
            aria-label="Plugins"
            className="w-full table-fixed border-separate border-spacing-0 text-[13px]"
          >
            <thead className="text-left text-2xs font-medium tracking-wider text-ink-3 uppercase">
              <tr>
                <th
                  className={cn(
                    'border-b border-line py-2 pr-3 pl-[4.75rem] font-medium',
                    offers ? 'w-[34%]' : 'w-[38%]',
                  )}
                >
                  Plugin
                </th>
                <th
                  className={cn(
                    'border-b border-line py-2 pr-3 font-medium',
                    offers ? 'w-[26%]' : 'w-[34%]',
                  )}
                >
                  On {context}
                </th>
                <th className="border-b border-line py-2 pr-5 font-medium">From</th>
                {offers && (
                  <th className="w-44 border-b border-line py-2 pr-5 font-medium">
                    <span className="sr-only">Newer</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <Fragment key={row.key}>
                  <tr
                    ref={row.key === askedRow?.key ? intoView : undefined}
                    data-state={row.state}
                    className={cn(
                      'scroll-mt-10 align-top',
                      row.state === 'replaced' && 'text-ink-3',
                    )}
                  >
                    <td className="border-b border-line py-3 pr-3 pl-5">
                      <Name
                        row={row}
                        names={names}
                        expanded={opened === row.key}
                        onToggle={() => setOpened(opened === row.key ? undefined : row.key)}
                      />
                    </td>
                    <td className="border-b border-line py-3 pr-3">
                      <OnCluster row={row} />
                    </td>
                    <td className="border-b border-line py-3 pr-5">
                      <From row={row} directory={plugins.directory} />
                    </td>
                    {offers && (
                      <td className="border-b border-line py-3 pr-5">
                        <Offered row={row} />
                      </td>
                    )}
                  </tr>
                  {row.problems.length > 0 && (
                    <tr>
                      <td colSpan={columns} className="border-b border-line p-0">
                        <Problems row={row} />
                      </td>
                    </tr>
                  )}
                  {opened === row.key && row.plugin && (
                    <tr>
                      <td colSpan={columns} className="border-b border-line bg-surface-2/60 p-0">
                        <WhatItAsks
                          plugin={row.plugin}
                          names={names}
                          focus={atSwitch(row.plugin)}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <footer className="flex shrink-0 items-start gap-2 border-t border-line px-5 py-2.5 text-xs text-ink-3 phone:px-4">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0">
          {shown.length} of {drawnFrom.length} shown.{' '}
          {HOST === 'yours' ? 'Yours go in' : 'This server’s are in'}{' '}
          <span className="font-mono break-all text-ink-2 selectable">{plugins.directory}</span>.
          One with the name of one of Lumovi’s is used in its place, all of it.
        </span>
      </footer>
    </div>
  )
}

/** What a plugin is, said once at the top: in Lumovi's words, and true of every one of them. */
function Opening() {
  // (Where the organization's policy names the plugins allowed, the others aren't here: said so,
  // without naming them.)
  const allowedOnly = useSettings().data?.managed?.pluginsAllowed !== undefined
  return (
    <p className="m-5 flex gap-2.5 rounded-xl bg-surface-2 px-4 py-3 text-[13px] leading-relaxed text-ink-2 phone:m-4">
      <Info className="mt-0.5 size-4 shrink-0 text-ink-3" />
      <span data-plugins-opening>
        {CODE_PAGES ? (
          // (Where Lumovi offers pages drawn by plugins' code, said so, and of whose.)
          <>
            A plugin teaches Lumovi a tool’s kinds: their columns, status, details and actions. Its
            actions change objects only with the patches and the objects they spell out, each shown
            here.{' '}
            {HOST === 'yours' ? 'A plugin of yours' : 'A plugin this server’s administrator added'}{' '}
            is data, and runs no code. The ones Lumovi comes with may also add pages drawn by their
            own code, in a sealed box: it reads only what its file says it may, and any change it
            proposes waits for you in Lumovi’s own dialog. A plugin has no access of its own: what
            it reads and changes, it does as you, and the cluster refuses what you may not do.
            Lumovi’s come inside Lumovi;{' '}
          </>
        ) : (
          <>
            A plugin teaches Lumovi a tool’s kinds: their columns, status, details and actions.
            Plugins are data. They can’t run code, and they change objects only with the patches and
            the objects they spell out, each shown here. A plugin has no access of its own: what it
            reads and changes, it does as you, and the cluster refuses what you may not do. Lumovi’s
            come inside Lumovi;{' '}
          </>
        )}
        {HOST === 'yours'
          ? 'yours are your own files.'
          : 'this server’s are files its administrator put there.'}
        {allowedOnly && (
          <span data-plugins-allowed-only className="mt-1.5 block">
            Your organization’s policy allows only some plugins here: the others aren’t shown.
          </span>
        )}
      </span>
    </p>
  )
}

type Names = ReturnType<typeof useKindNames>

/** A plugin's name, its version and the kinds it shows: at most three, then how many more. */
function Name({
  row,
  names,
  expanded,
  onToggle,
}: {
  row: Row
  names: Names
  expanded?: boolean
  onToggle?: () => void
}) {
  const kinds = row.plugin ? [...asks(row.plugin).kinds, ...row.plugin.shows] : []
  // Three by name, in the file's order; then how many more.
  const first = kinds.slice(0, 3).map(names.plural)
  const more = kinds.length - first.length
  const title = (
    <>
      {/* (A file's name wraps, and is never cut: it's how its owner finds the file.) */}
      <span className="font-medium break-words text-ink-1 [.text-ink-3_&]:text-ink-3">
        {row.title}
      </span>
      {row.plugin && (
        <span className="ml-2 font-mono text-xs text-ink-3 tabular-nums">{row.plugin.version}</span>
      )}
    </>
  )
  return (
    <div className="flex gap-3.5">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-ink-2">
        {row.plugin?.place ? (
          <PluginIcon plugin={row.plugin.place} className="size-4" />
        ) : (
          <FileCode2 className="size-4" aria-hidden />
        )}
      </span>
      <div className="min-w-0">
        {row.plugin && onToggle ? (
          <button
            type="button"
            data-plugin-row
            aria-expanded={expanded}
            onClick={onToggle}
            className="text-left hover:text-accent-strong"
          >
            {title}
          </button>
        ) : (
          <span>{title}</span>
        )}
        {(row.origin === 'yours' || row.origin === 'server') && (
          <span className="ml-2 rounded bg-surface-3 px-1.5 py-0.5 text-2xs text-ink-2">
            {row.origin === 'yours' ? 'Yours' : 'This server’s'}
          </span>
        )}
        {kinds.length > 0 && (
          <p className="mt-0.5 text-ink-3">
            {first.join(', ')}
            {more > 0 && ` and ${more} more ${more === 1 ? 'kind' : 'kinds'}`}
          </p>
        )}
        {row.offer && 'update' in row.offer && (
          <p data-plugin-update={row.offer.update} className="mt-0.5 text-xs text-ink-2">
            Update: <span className="font-mono font-medium text-ink-1">{row.offer.update}</span>
          </p>
        )}
        {CODE_PAGES && row.plugin && <CodeOffLine plugin={row.plugin} />}
      </div>
    </div>
  )
}

/**
 * At a row's end, what the store offers that's no update: a version this Lumovi is too old for,
 * quietly, and nothing to press (Lumovi's own update is how to get it).
 */
function Offered({ row }: { row: Row }) {
  if (!row.offer || !('needs' in row.offer)) return null
  const { version, lumovi } = row.offer.needs
  return (
    <p data-plugin-needs={lumovi} className="text-right text-xs text-ink-3">
      <span className="font-medium text-ink-2">{version}</span> needs Lumovi {lumovi}
    </p>
  )
}

/**
 * Under a plugin's name, where a switch turned its code off: why its pages don't run, quietly
 * (a choice, not a fault). Nothing where its code runs, or where it has none.
 */
function CodeOffLine({ plugin }: { plugin: Plugin }) {
  const settings = useSettings().data
  const handOver = useQuery({
    queryKey: ['plugin-hand-over', plugin.name],
    queryFn: () => api.kube.pluginHandOver(plugin.name),
    enabled: plugin.added.pages.length + plugin.added.tabs.length > 0,
  })
  if (!settings || handOver.data === undefined) return null
  if (handOver.data === 'no-code' || handOver.data === 'not-in-use') return null
  const off = codeOff(plugin.name, switchesOf(settings))
  return off ? (
    <p data-plugin-code-off={plugin.name} className="mt-0.5 text-ink-3">
      {notHandedLine(
        off,
        PLUGIN_PAGES[plugin.name] ? (plugin.place?.label ?? plugin.name) : undefined,
      )}
    </p>
  ) : null
}

/** Whether it's in use on this cluster, and if not, why. */
function OnCluster({ row }: { row: Row }) {
  if (row.state === 'not-in-use') {
    const count = row.problems.length
    return (
      <p className="flex gap-2 text-warn-text">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
        <span>
          <span className="font-medium">Not in use.</span>{' '}
          {count === 1 ? '1 problem' : `${count} problems`} to fix in the file.
          {/* (It has that plugin's name, and so looks much like it.) */}
          {row.lumovis && (
            <span className="mt-0.5 block text-xs text-ink-3">
              Lumovi’s {label(row.lumovis)} is shown instead
            </span>
          )}
        </span>
      </p>
    )
  }
  if (row.state === 'not-here') {
    // (Before it's here: whether it would show anything on this cluster.)
    return (
      <p className={cn('flex gap-2', row.here ? 'text-ink-2' : 'text-ink-3')}>
        {row.here ? (
          <CircleDashed className="mt-0.5 size-4 shrink-0" />
        ) : (
          <Minus className="mt-0.5 size-4 shrink-0" />
        )}
        {row.here ? 'Its kinds are on this cluster' : 'Not on this cluster'}
      </p>
    )
  }
  if (row.state === 'replaced') {
    return (
      <p className="flex gap-2">
        <Minus className="mt-0.5 size-4 shrink-0" />
        <span className="min-w-0 break-words">
          Not in use: {HOST === 'yours' ? 'your' : 'this server’s'} {row.replacedBy} is used in its
          place, all of it.
        </span>
      </p>
    )
  }
  return (
    <div className="flex gap-2 text-ink-2">
      {row.here ? (
        <Check className="mt-0.5 size-4 shrink-0 text-good-text" />
      ) : (
        <Minus className="mt-0.5 size-4 shrink-0 text-ink-3" />
      )}
      <div className="min-w-0">
        <p className={row.here ? undefined : 'text-ink-3'}>
          {row.here
            ? row.plugin!.place
              ? 'On this cluster: in the sidebar'
              : 'On this cluster'
            : 'Not on this cluster'}
        </p>
        {row.state === 'in-place-of' && (
          <p className="mt-0.5 text-xs text-ink-3">
            In use in place of Lumovi’s {label(row.lumovis!)}
          </p>
        )}
      </div>
    </div>
  )
}

/** Where it came from: inside Lumovi, or a file of the folder. */
function From({ row, directory }: { row: Row; directory: string }) {
  const separator = directory.includes('\\') ? '\\' : '/'
  return (
    <div className="min-w-0">
      <p className="text-ink-2 [.text-ink-3_&]:text-ink-3">
        {row.origin === 'lumovi'
          ? 'Lumovi'
          : row.origin === 'store'
            ? 'Lumovi-plugins'
            : row.origin === 'yours'
              ? 'Yours'
              : 'This server’s'}
      </p>
      <p className="mt-0.5 font-mono text-xs break-all text-ink-3 selectable">
        {row.origin === 'lumovi'
          ? 'Comes with Lumovi'
          : row.origin === 'store'
            ? `From Lumovi-plugins release ${row.release}`
            : `${directory}${separator}${row.file}`}
      </p>
    </div>
  )
}

/** What's wrong with a file that isn't in use: each line as the check said it. */
function Problems({ row }: { row: Row }) {
  if (row.problems.length === 0) return null
  return (
    <ul
      aria-label={`Problems with ${row.file ?? row.title}`}
      className="space-y-0.5 bg-warn/8 py-2.5 pr-5 pl-[4.75rem] font-mono text-xs text-ink-2 phone:px-4"
    >
      {row.problems.map((problem, i) => (
        <li key={i} className="break-words">
          {problem}
        </li>
      ))}
    </ul>
  )
}

/** A plugin as a card, one fact a line: the list on a phone. */
function Card({ row, names, directory }: { row: Row; names: Names; directory: string }) {
  return (
    <div
      className={cn(
        'space-y-2.5 px-4 py-3.5 text-[13px]',
        row.state === 'replaced' && 'text-ink-3',
      )}
    >
      <Name row={row} names={names} />
      <OnCluster row={row} />
      <From row={row} directory={directory} />
    </div>
  )
}

/** What a plugin's code does, from its file: what it draws, what it reads as you, and whether it proposes. */
function codeDoes(plugin: Plugin, names: Names): string {
  const { pages, tabs } = plugin.added
  const draws = [
    ...pages.map((page) => `its ${page.title.toLowerCase()}`),
    ...tabs.map((tab) => `a tab on ${listed(tab.kinds.map(names.plural))}`),
  ]
  const reads = asks(plugin).reads.map((read) => names.plural(read.kind))
  return [
    draws.length > 0 && `Draws ${listed(draws)}.`,
    `It reads ${reads.length > 0 ? listed(reads) : 'only its own kinds'} as you, and ${
      plugin.changes.length > 0 ? 'proposes changes, each one you confirm.' : 'changes nothing.'
    }`,
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * "Run its code": the person's own switch of a plugin's code, first in its opened entry. Locked
 * off where the server or the organization's policy turned it off: then it says whose it is.
 */
/** Whether a plugin's entry has "Run its code": only where its code is part of this Lumovi. */
function useHasCode(plugin: Plugin): boolean {
  const settings = useSettings().data
  const handOver = useQuery({
    queryKey: ['plugin-hand-over', plugin.name],
    queryFn: () => api.kube.pluginHandOver(plugin.name),
    enabled: CODE_PAGES,
  })
  return (
    CODE_PAGES &&
    settings !== undefined &&
    handOver.data !== undefined &&
    handOver.data !== 'no-code' &&
    handOver.data !== 'not-in-use'
  )
}

function CodeSwitch({ plugin, names, focus }: { plugin: Plugin; names: Names; focus: boolean }) {
  const settings = useSettings().data
  const queryClient = useQueryClient()
  if (!useHasCode(plugin) || !settings) return null
  const switches = switchesOf(settings)
  const off = codeOff(plugin.name, switches)
  const locked =
    off === 'off-by-policy' || off === 'off-on-server' || off === 'off-on-server-for-it'
  const on = !off
  const line = `plugin-code-line-${plugin.name}`
  const change = async (next: boolean) => {
    try {
      const updated = await api.app.setPluginCode(plugin.name, next)
      queryClient.setQueryData(['settings'], updated)
      void queryClient.invalidateQueries({ queryKey: ['plugin-hand-over', plugin.name] })
    } catch (error) {
      toast({ tone: 'error', title: (error as Error).message })
    }
  }
  const control = `plugin-code-${plugin.name}`
  return (
    // A hairline above; the row grows with its line; the label and its switch read as one, in the
    // entry's text column, and the whole of that line is the place to press (44 px on a phone).
    <div
      data-plugin-code-switch={plugin.name}
      className="border-t border-line pt-3 pr-5 pb-1 pl-[4.75rem] text-[13px] phone:px-4"
    >
      <div className="max-w-[44rem]">
        <div className="flex min-h-8 items-center gap-3 phone:min-h-11">
          <label
            htmlFor={control}
            className="flex min-w-0 flex-1 flex-wrap items-center gap-2 self-stretch font-medium text-ink-1"
          >
            Run its code
            {(off === 'off-on-server' || off === 'off-on-server-for-it') && <LockedBadge />}
          </label>
          <Switch
            id={control}
            label="Run its code"
            checked={on}
            locked={locked}
            describedBy={line}
            autoFocus={focus}
            onCheckedChange={(next) => void change(next)}
          />
        </div>
        <p id={line} className="text-ink-2">
          {off === 'off-by-policy' ? (
            <span className="flex gap-1.5">
              <Lock className="mt-0.5 size-3.5 shrink-0 text-ink-3" aria-hidden />
              Turned off by your organization’s policy.
            </span>
          ) : locked ? (
            'Turned off on this server.'
          ) : (
            codeDoes(plugin, names)
          )}
        </p>
      </div>
    </div>
  )
}

/** What a plugin asks for, in three parts: what it may change, what it reads, and its actions. */
function WhatItAsks({
  plugin,
  names,
  focus = false,
}: {
  plugin: Plugin
  names: Names
  /** Whether its switch takes the focus: where "Open Plugins" on its page came here. */
  focus?: boolean
}) {
  const asked = asks(plugin)
  const heading = 'mb-2 text-2xs font-medium tracking-wider text-ink-3 uppercase'
  // (Under "Run its code", the next heading 12 px under its line.)
  const switched = useHasCode(plugin)
  return (
    <>
      {/* (With its pages, where Lumovi offers code pages.) */}
      {CODE_PAGES && <CodeSwitch plugin={plugin} names={names} focus={focus} />}
      <div
        className={cn(
          'grid grid-cols-2 gap-x-10 gap-y-6 pr-5 pb-5 pl-[4.75rem] text-[13px] text-ink-2 phone:grid-cols-1 phone:px-4',
          switched ? 'pt-3' : 'pt-5',
        )}
      >
        <div className="space-y-5">
          <section aria-label="May change and create">
            <h3 className={heading}>May change and create</h3>
            <MayChange asked={asked} names={names} />
          </section>
          <section aria-label="May read">
            <h3 className={heading}>May read</h3>
            <MayRead asked={asked} names={names} tool={plugin.place?.label ?? plugin.name} />
          </section>
          {/* (Its pages, tabs and commands are drawn by the door: said where Lumovi offers them.) */}
          {CODE_PAGES && (
            <section aria-label="Adds to Lumovi’s pages">
              <h3 className={heading}>Adds to Lumovi’s pages</h3>
              <Adds
                name={plugin.name}
                added={plugin.added}
                opens={plugin.opens}
                links={plugin.links}
                names={names}
                {...(PLUGIN_PAGES[plugin.name]
                  ? { standsIn: plugin.place?.label ?? plugin.name }
                  : {})}
              />
            </section>
          )}
        </div>
        <section aria-label="Its actions, and what each sends">
          <h3 className={heading}>Its actions, and what each sends</h3>
          {asked.actions.length === 0 ? (
            <p>It has no actions.</p>
          ) : (
            <>
              <ul className="space-y-3">
                {asked.actions.map((action, i) => (
                  <li
                    key={i}
                    className="grid grid-cols-[9rem_1fr] gap-3 phone:grid-cols-1 phone:gap-1.5"
                  >
                    <div>
                      <p className="font-medium text-ink-1">{action.name}</p>
                      <p className="text-xs text-ink-3">
                        {action.kinds.length === asked.kinds.length && asked.kinds.length > 1
                          ? `on all ${asked.kinds.length} kinds`
                          : `on ${listed(action.kinds.map(names.plural))}`}
                        {action.status && ', to its status'}
                      </p>
                      {/* Both grey, told apart by their words and their weight, never by a colour. */}
                      <span
                        className={cn(
                          'mt-1 inline-block rounded bg-surface-3 px-1.5 py-0.5 text-2xs',
                          action.runs === 'asks' ? 'text-ink-3' : 'font-medium text-ink-1',
                        )}
                      >
                        {action.runs === 'asks' ? 'asks first' : 'runs at once'}
                      </span>
                    </div>
                    <div className="min-w-0">
                      {action.creates !== undefined && (
                        <p className="mb-1 text-xs text-ink-3">Creates</p>
                      )}
                      {action.json && <p className="mb-1 text-xs text-ink-3">A JSON patch</p>}
                      <pre className="overflow-x-auto rounded-lg border border-line bg-surface px-3 py-2 font-mono text-xs leading-5 text-ink-1 selectable">
                        {action.patch ?? action.creates}
                      </pre>
                      {action.undo !== undefined && (
                        <>
                          {/* (Sent too, later, when Undo is pressed: the other half of the action.) */}
                          <p className="mt-2 mb-1 text-xs text-ink-3">Undo sends:</p>
                          <pre className="overflow-x-auto rounded-lg border border-line bg-surface px-3 py-2 font-mono text-xs leading-5 text-ink-1 selectable">
                            {action.undo}
                          </pre>
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              <p className="mt-3 flex gap-2 text-ink-3">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                An action that asks first shows this and its kubectl command before anything is
                sent. One that runs at once sends it when its button is pressed.
              </p>
            </>
          )}
        </section>
      </div>
    </>
  )
}

/** How a plugin's page may propose a change, as the Plugins page says it. */
const PROPOSES: Record<ChangeAction, string> = {
  patch: 'change',
  create: 'create',
  delete: 'delete',
  scale: 'scale',
}

function MayChange({ asked, names }: { asked: Asks; names: Names }) {
  // (Where Lumovi offers its pages: elsewhere, nothing of what they'd propose is said.)
  const proposes = CODE_PAGES && asked.changes.length > 0 && (
    <p data-plugin-proposes="">
      Its pages may propose to{' '}
      {listed(
        asked.changes.map(
          ({ kind, actions }) =>
            `${listed(actions.map((action) => PROPOSES[action]))} ${names.plural(kind)}`,
        ),
      )}
      , each change one you confirm in Lumovi.
    </p>
  )
  if (asked.actions.length === 0) return proposes || <p>Nothing. It has no actions.</p>
  return (
    <div className="space-y-2">
      {proposes}
      <p>Only the kinds it shows:</p>
      <p className="font-mono text-xs leading-5 text-ink-1">
        {asked.kinds.map(names.bare).join(', ')}
      </p>
      <p className="text-xs text-ink-3">
        all in the API groups it names: {asked.groups.join(', ')}
      </p>
      {asked.creates.length > 0 && (
        <p>
          Creates: {listed(asked.creates.map(names.bare))},{' '}
          {asked.creates.length === 1 ? 'one' : 'each one'} of its own kinds.
        </p>
      )}
      <p className="flex gap-2">
        <Lock className="mt-0.5 size-3.5 shrink-0 text-ink-3" />
        <span>
          Never, on an object it changes, what’s the cluster’s to set: its owners, finalizers, name
          or namespace.
          {asked.creates.length > 0 && ' Nor the owners or finalizers of one it creates.'} Never
          Kubernetes’ own kinds: no Pods, Jobs, Secrets or RoleBindings. No plugin can.
        </span>
      </p>
    </div>
  )
}

/** How many kinds the line of the lists a plugin's pages open names, before "and N more kinds". */
const OPENS_NAMED = 8

/**
 * Which of Lumovi's lists its pages may open, in its file's order: past eight, how many more,
 * and every one in its tooltip (under a finger, where nothing hovers, every one in the line).
 */
function Opens({ kinds, names }: { kinds: ResourceKind[]; names: Names }) {
  const touch = useTouch()
  if (kinds.length === 0) return null
  const plurals = kinds.map(names.plural)
  const more = plurals.length - OPENS_NAMED
  return (
    <p data-plugin-opens="">
      Its pages may open Lumovi’s lists of{' '}
      {more > 0 && !touch ? (
        <>
          {plurals.slice(0, OPENS_NAMED).join(', ')} and{' '}
          <Tooltip content={listed(plurals)}>
            <span tabIndex={0} className="underline decoration-dotted underline-offset-2">
              {more} more {more === 1 ? 'kind' : 'kinds'}
            </span>
          </Tooltip>
        </>
      ) : (
        listed(plurals)
      )}
      .
    </p>
  )
}

/** What a plugin adds to Lumovi's pages: how many of each, then each by the name its file gives. */
function Adds({
  name,
  added,
  opens,
  links,
  names,
  standsIn,
}: {
  name: string
  added: Plugin['added']
  opens: ResourceKind[]
  links: readonly Reach[]
  names: Names
  /** Its label, where Lumovi shows a page of its own in place of its code's. */
  standsIn?: string
}) {
  const { pages, tabs, commands } = added
  // Whether its code would be handed to this window or browser: where not, it says why.
  const handOver = useQuery({
    queryKey: ['plugin-hand-over', name],
    queryFn: () => api.kube.pluginHandOver(name),
    enabled: pages.length + tabs.length > 0,
  })
  const notHanded =
    handOver.data !== undefined && handOver.data !== true && handOver.data !== 'not-in-use'
      ? handOver.data
      : undefined
  const counted = (count: number, one: string, many: string) =>
    count === 0 ? [] : [count === 1 ? one : `${count} ${many}`]
  const on = (kinds: ResourceKind[]) => listed(kinds.map(names.plural))
  const parts = [
    ...counted(pages.length, 'a page', 'pages'),
    ...counted(tabs.length, `a tab on ${on(tabs[0]?.kinds ?? [])}`, 'tabs'),
    ...counted(commands.length, 'a command to the palette', 'commands to the palette'),
  ]
  if (parts.length === 0) return <p>Adds nothing to Lumovi’s pages.</p>
  return (
    <div className="space-y-2">
      <p>Adds {listed(parts)}.</p>
      {notHanded && <p data-testid="plugin-not-handed">{notHandedLine(notHanded, standsIn)}</p>}
      <ul className="space-y-1">
        {pages.map((page) => (
          <li key={`page:${page.id}`}>
            The page <span className="font-medium text-ink-1">{page.title}</span>
          </li>
        ))}
        {tabs.map((tab) => (
          <li key={`tab:${tab.id}`}>
            The tab <span className="font-medium text-ink-1">{tab.title}</span>, on {on(tab.kinds)}
          </li>
        ))}
        {commands.map((command) => (
          <li key={`command:${command.name}`}>
            The command <span className="font-medium text-ink-1">{command.name}</span>
          </li>
        ))}
      </ul>
      <Opens kinds={opens} names={names} />
      {links.length > 0 && <p data-plugin-links>{linksLine(links)}</p>}
    </div>
  )
}

/**
 * Where its pages may link to, in Lumovi's words: its own places, which the person opens and
 * does there what they do.
 */
function linksLine(links: readonly Reach[]): string {
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

function MayRead({ asked, names, tool }: { asked: Asks; names: Names; tool: string }) {
  const kinds = ({ kinds, templated }: Asks['related']) =>
    kinds.length > 0 ? listed(kinds.map(names.plural)) : templated ? 'kinds its objects name' : ''
  return (
    <div className="space-y-2">
      <p>Its own kinds’ objects: its columns, status and details are fields of the object shown.</p>
      {asked.shows.length > 0 && (
        <p>{listed(asked.shows.map(names.plural))}, which it shows and can’t change.</p>
      )}
      {kinds(asked.related) && (
        <p>
          Beside an object it lists {kinds(asked.related)}, picked by their labels or fields. The
          list is Lumovi’s own, as on any page.
        </p>
      )}
      {kinds(asked.links) && (
        <p>
          It links to {kinds(asked.links)} by name. A link opens Lumovi’s page for the object; the
          plugin reads nothing of it.
        </p>
      )}
      {asked.reads.map((read) => {
        const more = [
          read.status && 'status',
          read.events && 'events',
          read.usage && 'usage',
        ].filter((said): said is string => Boolean(said))
        return (
          <p key={read.kind}>
            Of {names.plural(read.kind)}, its code is handed only{' '}
            <span className="font-mono text-xs text-ink-1 selectable">{listed(read.fields)}</span>
            {more.length > 0 && `, with their ${listed(more)}`}, as far as you may read them.
          </p>
        )
      })}
      {asked.secrets.map((shown) => {
        const kind = apiKindOf(shown.kind)
        return (
          <p key={`${shown.kind} ${shown.path}`}>
            Shows you{' '}
            <span className="font-mono text-xs text-ink-1 selectable">{listed(shown.keys)}</span> of
            the Secret that {/^[AEIOU]/.test(kind) ? 'an' : 'a'} {kind}’s{' '}
            <span className="font-mono text-xs text-ink-1 selectable">{shown.path}</span> names.
            Lumovi reads it as you, only when you press Reveal or Copy; the plugin never sees it.
          </p>
        )
      })}
      {asked.manages.length > 0 && (
        <p>
          Every {listed(asked.manages.map(names.bare))} in the cluster you may list (or, where you
          can’t, in the namespaces you’re looking at), to say which of them manages each workload,
          by labels and annotations the workload carries under {tool}’s own groups.
        </p>
      )}
      <p>It reads no logs and no Secret’s value, and sends nothing anywhere but to this cluster.</p>
    </div>
  )
}

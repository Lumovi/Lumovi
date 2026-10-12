/**
 * Every plugin there is: Lumovi's own and a folder's files, each once. What's in use, what isn't
 * and why, and, opened, what a plugin asks for: read from its file and said in Lumovi's words.
 * Nothing here changes anything.
 */
import {
  ArrowLeft,
  Check,
  FileCode2,
  Info,
  Lock,
  Minus,
  SearchX,
  TriangleAlert,
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { Fragment, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { asks, type Asks } from '@shared/plugin-asks'
import { notHandedLine } from '@shared/plugin-hand-over'
import type { Loaded } from '@shared/plugin-loading'
import { plain, PLUGIN_NAME, type Plugin } from '@shared/plugins'
import { apiKindOf, type ResourceDefinition, type ResourceKind } from '@shared/resources'
import { PluginIcon } from '@renderer/components/KindIcon'
import { SearchInput } from '@renderer/components/SearchInput'
import { EmptyState, Loading } from '@renderer/components/States'
import { usePlugins } from '@renderer/hooks/plugins'
import { useResources } from '@renderer/hooks/resources'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { useLayout } from '@renderer/lib/layout'
import { ASKED_PLUGIN } from '@renderer/lib/routes'
import { useCluster } from '@renderer/state/cluster'

/** A line of the list: one of Lumovi's plugins, or a file of the folder. */
interface Row {
  key: string
  /** As the sidebar has it; a file that holds no plugin goes by its name. */
  title: string
  plugin?: Plugin
  origin: 'lumovi' | 'yours' | 'server'
  file?: string
  /** `replaced`: one of Lumovi's with a file in its place. */
  state: Loaded['state'] | 'replaced'
  /** For one in Lumovi's place, that plugin; for one of Lumovi's replaced, the file. */
  lumovis?: Plugin
  replacedBy?: string
  problems: string[]
  /** The cluster serves one of its kinds. */
  here: boolean
}

type Filter = 'all' | 'here' | 'yours' | 'unused'

const HOST = api.host === 'desktop' ? 'yours' : 'server'
const label = (plugin: Plugin) => plugin.place?.label ?? plugin.name
const inUse = (row: Row) => row.state === 'in-use' || row.state === 'in-place-of'

/** Set by the build: true only in the build the tests run. */
declare const LUMOVI_TEST_BUILD: boolean

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
  // The address may name a plugin to open (a link to what it asks for). A name only: anything
  // that isn't one, or that no plugin here has, opens nothing.
  const [params, setParams] = useSearchParams()
  const named = params.get(ASKED_PLUGIN)
  const asked = named !== null && PLUGIN_NAME.test(named) ? named : undefined
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
      return {
        key: `lumovi:${plugin.name}`,
        title: label(plugin),
        plugin,
        origin: 'lumovi',
        state: replacedBy ? 'replaced' : 'in-use',
        replacedBy,
        problems: [],
        here: here(plugin),
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
  ]
  const FILTERS: [Filter, string, (row: Row) => boolean][] = [
    ['all', 'All', () => true],
    ['here', 'On this cluster', (row) => inUse(row) && row.here],
    ['yours', HOST === 'yours' ? 'Yours' : 'This server’s', (row) => row.origin !== 'lumovi'],
    ['unused', 'Not in use', (row) => !inUse(row)],
  ]
  const needle = search.trim().toLowerCase()
  const shown = rows
    .filter(FILTERS.find(([key]) => key === filter)![2])
    .filter((row) =>
      `${row.title} ${row.plugin?.name ?? ''} ${row.file ?? ''}`.toLowerCase().includes(needle),
    )
  // (Files, as the filter beside it counts them: one that holds no plugin is still theirs.)
  const own = rows.filter((row) => row.origin !== 'lumovi').length
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
        <WhatItAsks plugin={selected.plugin} names={names} />
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
            {FILTERS.map(([key, text, matches]) => (
              <button
                key={key}
                type="button"
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
                className={cn(
                  'h-8 shrink-0 rounded-md px-2.5 text-[13px] whitespace-nowrap text-ink-2 phone:h-11 phone:px-2 phone:text-xs',
                  filter === key && 'bg-surface font-medium text-ink-1 shadow-sm',
                )}
              >
                {text} <span className="tabular-nums">{rows.filter(matches).length}</span>
              </button>
            ))}
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
                <th className="w-[38%] border-b border-line py-2 pr-3 pl-[4.75rem] font-medium">
                  Plugin
                </th>
                <th className="w-[34%] border-b border-line py-2 pr-3 font-medium">On {context}</th>
                <th className="border-b border-line py-2 pr-5 font-medium">From</th>
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
                  </tr>
                  {row.problems.length > 0 && (
                    <tr>
                      <td colSpan={3} className="border-b border-line p-0">
                        <Problems row={row} />
                      </td>
                    </tr>
                  )}
                  {opened === row.key && row.plugin && (
                    <tr>
                      <td colSpan={3} className="border-b border-line bg-surface-2/60 p-0">
                        <WhatItAsks plugin={row.plugin} names={names} />
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
          {shown.length} of {rows.length} shown.{' '}
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
  return (
    <p className="m-5 flex gap-2.5 rounded-xl bg-surface-2 px-4 py-3 text-[13px] leading-relaxed text-ink-2 phone:m-4">
      <Info className="mt-0.5 size-4 shrink-0 text-ink-3" />
      <span>
        A plugin teaches Lumovi a tool’s kinds: their columns, status, details and actions. Plugins
        are data. They can’t run code, and they change objects only with the patches and the objects
        they spell out, each shown here. A plugin has no access of its own: what it reads and
        changes, it does as you, and the cluster refuses what you may not do. Lumovi’s come inside
        Lumovi;{' '}
        {HOST === 'yours'
          ? 'yours are your own files.'
          : 'this server’s are files its administrator put there.'}
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
          <PluginIcon
            plugin={{
              name: row.plugin.name,
              source: row.plugin.source,
              version: row.plugin.version,
              added: row.plugin.added,
              ...row.plugin.place,
            }}
            className="size-4"
          />
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
        {row.origin !== 'lumovi' && (
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
      </div>
    </div>
  )
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
        {row.origin === 'lumovi' ? 'Lumovi' : row.origin === 'yours' ? 'Yours' : 'This server’s'}
      </p>
      <p className="mt-0.5 font-mono text-xs break-all text-ink-3 selectable">
        {row.origin === 'lumovi' ? 'came with this Lumovi' : `${directory}${separator}${row.file}`}
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

/** What a plugin asks for, in three parts: what it may change, what it reads, and its actions. */
function WhatItAsks({ plugin, names }: { plugin: Plugin; names: Names }) {
  const asked = asks(plugin)
  const heading = 'mb-2 text-2xs font-medium tracking-wider text-ink-3 uppercase'
  return (
    <div className="grid grid-cols-2 gap-x-10 gap-y-6 py-5 pr-5 pl-[4.75rem] text-[13px] text-ink-2 phone:grid-cols-1 phone:px-4">
      <div className="space-y-5">
        <section aria-label="May change and create">
          <h3 className={heading}>May change and create</h3>
          <MayChange asked={asked} names={names} />
        </section>
        <section aria-label="May read">
          <h3 className={heading}>May read</h3>
          <MayRead asked={asked} names={names} />
        </section>
        {/* (Its pages, tabs and commands are drawn by the door, and taken only in the tests'
            build until it's in: a release says nothing of them yet.) */}
        {LUMOVI_TEST_BUILD && (
          <section aria-label="Adds to Lumovi’s pages">
            <h3 className={heading}>Adds to Lumovi’s pages</h3>
            <Adds name={plugin.name} added={plugin.added} names={names} />
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
              An action that asks first shows this and its kubectl command before anything is sent.
              One that runs at once sends it when its button is pressed.
            </p>
          </>
        )}
      </section>
    </div>
  )
}

function MayChange({ asked, names }: { asked: Asks; names: Names }) {
  if (asked.actions.length === 0) return <p>Nothing. It has no actions.</p>
  return (
    <div className="space-y-2">
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

/** What a plugin adds to Lumovi's pages: how many of each, then each by the name its file gives. */
function Adds({ name, added, names }: { name: string; added: Plugin['added']; names: Names }) {
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
      {notHanded && <p data-testid="plugin-not-handed">{notHandedLine(notHanded)}</p>}
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
    </div>
  )
}

function MayRead({ asked, names }: { asked: Asks; names: Names }) {
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
      <p>It reads no logs and no Secret’s value, and sends nothing anywhere but to this cluster.</p>
    </div>
  )
}

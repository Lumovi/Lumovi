import { ChevronDown, ChevronRight, Network, List, Search, TriangleAlert } from 'lucide-react'
import { ContextMenu } from 'radix-ui'
import { useSearchParams } from 'react-router'
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import type { KubeObject } from '@shared/api'
import { isBuiltinKind, type ResourceKind } from '@shared/resources'
import { KindIcon } from '@renderer/components/KindIcon'
import { StatusDot } from '@renderer/components/Status'
import { HEALTH_STYLE } from '@renderer/components/Status'
import { useOpenObject } from '@renderer/hooks/open-object'
import { useLists } from '@renderer/hooks/queries'
import { useResources } from '@renderer/hooks/resources'
import { cn } from '@renderer/lib/cn'
import {
  bandsOf,
  gathered,
  LOOSE_PODS,
  cardsIn,
  COLUMNS,
  healthOf,
  unwell,
  type Band,
  type Column,
  type Grouping,
  type MapRow,
} from '@renderer/lib/cluster-map'
import { formatRef } from '@renderer/lib/routes'
import { useLayout } from '@renderer/lib/layout'
import {
  buildMap,
  CLUSTER_MAP_KINDS,
  MAP_KINDS,
  nodeMeta,
  nodeStatus,
  type MapNode,
} from '@renderer/lib/map'
import { useActionsUi } from '@renderer/state/actions'
import { useCluster } from '@renderer/state/cluster'
import { kindLabel, PodsBar } from '../details/MapTab'
import { usePageRoom } from '../details/SidePanel'
import { labelsMatch, nameRank, searches, termsOf, type Terms } from '../search/terms'

/** Past about this many cards, pods are counted on their workloads and what's healthy folds. */
const BIG = 400
/** Narrower than this a map's five columns don't fit: pods are counted; under the next, a list. */
const FIVE_COLUMNS = 1082
const FOUR_COLUMNS = 728

const COLUMN_NAMES: Record<Column, string> = {
  traffic: 'Traffic',
  services: 'Services',
  workloads: 'Workloads',
  pods: 'Pods',
  config: 'Config and storage',
}

const count = (n: number, noun: string) =>
  `${n.toLocaleString('en-US')} ${noun}${n === 1 ? '' : 's'}`
/** Counts said together, those of none left out. */
const saidCounts = (...counts: [number, string][]) =>
  counts
    .filter(([n]) => n > 0)
    .map(([n, noun]) => count(n, noun))
    .join(' · ')

/** Everything the map is made from: the namespaces picked, and the cluster's own kinds. */
function useMapGraph() {
  const resources = useResources()
  const { namespaces } = useCluster()
  const served = (kind: ResourceKind) =>
    isBuiltinKind(kind) || resources.data?.some((r) => r.kind === kind) === true
  const requests = [
    ...MAP_KINDS.map((kind) => ({ kind, enabled: served(kind) })),
    ...CLUSTER_MAP_KINDS.map((kind) => ({ kind, namespace: null, enabled: true })),
  ]
  const lists = useLists(requests)
  const settled =
    !resources.isPending &&
    lists.every((l, i) => !requests[i]!.enabled || l.data !== undefined || l.error !== null)
  const stamp = lists.map((l) => l.dataUpdatedAt).join()
  const graph = useMemo(() => {
    const pool = lists.flatMap((l) => l.data ?? [])
    // (Where several namespaces are picked, a reference into one not picked can't be told missing.)
    const listed = new Map<ResourceKind, string | null>(
      requests.flatMap((r, i) =>
        lists[i]!.data ? [[r.kind, namespaces?.length === 1 ? namespaces[0]! : null] as const] : [],
      ),
    )
    return buildMap({ pool, listed, expanded: new Set(), related: [] })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp, namespaces])
  return { graph, settled }
}

/** What's kept for each cluster: how it's grouped, and as a map or a list. */
function useKept(context: string) {
  const read = <T,>(name: string, fallback: T): T => {
    try {
      return (localStorage.getItem(`lumovi:map:${context}:${name}`) as T) ?? fallback
    } catch {
      return fallback
    }
  }
  const [grouping, setGrouping] = useState<Grouping>(() => read('grouping', 'namespace'))
  const [view, setView] = useState<'map' | 'list'>(() => read('view', 'map'))
  const keep = (name: string, value: string) => {
    try {
      localStorage.setItem(`lumovi:map:${context}:${name}`, value)
    } catch {
      // (Kept for convenience only.)
    }
  }
  return {
    grouping,
    view,
    setGrouping: (g: Grouping) => (setGrouping(g), keep('grouping', g)),
    setView: (v: 'map' | 'list') => (setView(v), keep('view', v)),
  }
}

/** Whether a card matches what's typed into Find on the map. */
const matches = (node: MapNode, terms: Terms) =>
  nameRank(node.name, terms.words) !== undefined &&
  labelsMatch(node.object?.metadata.labels ?? node.pods?.[0]?.metadata.labels, terms.labels)

/**
 * Map (LMV-172): everything in the namespaces picked as one picture, the Map tab's cards in five
 * columns and bands, with what's unwell and what leads to it easy to see. It only reads.
 */
export function MapPage() {
  useEffect(() => {
    document.title = 'Map — Lumovi'
  }, [])
  const { context, namespaces } = useCluster()
  const { graph, settled } = useMapGraph()
  const kept = useKept(context)
  const phone = useLayout() === 'phone'
  const [find, setFind] = useState('')
  const terms = useMemo(() => termsOf(find), [find])
  const finding = searches(terms)
  const bands = useMemo(() => bandsOf(graph, kept.grouping), [graph, kept.grouping])
  const page = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(1440)
  useLayoutEffect(() => {
    const element = page.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const total = bands.reduce((sum, band) => sum + cardsIn(band), 0)
  const big = total > BIG || width < FIVE_COLUMNS
  const listOnly = phone || width < FOUR_COLUMNS
  const view = listOnly ? 'list' : kept.view
  // A card opens its panel over the map, which would otherwise draw itself again narrower, its
  // columns and lines moved under the click; beside the list, as from any list.
  const keepRoom = usePageRoom((room) => room.keep)
  useEffect(() => {
    if (view !== 'map') return
    keepRoom(Number.POSITIVE_INFINITY)
    return () => keepRoom(undefined)
  }, [view, keepRoom])
  const found = finding
    ? bands
        .flatMap((b) => b.rows.flatMap((r) => COLUMNS.flatMap((c) => r.cards[c])))
        .filter((n) => matches(n, terms))
    : []
  const foundIds = new Set(found.map((n) => n.id))
  const [at, setAt] = useState(0)
  const pods = bands.reduce((sum, b) => sum + b.counts.pods, 0)
  // (By node, a workload on several nodes is drawn in each, and counted once.)
  const workloads = new Set(
    bands.flatMap((b) => b.rows.flatMap((r) => (r.workload ? [r.workload.id] : []))),
  ).size
  // The card opened stays lit over the panel's shade; the map moves along until it's clear of
  // the panel, as far as a column or two, and back when the panel closes.
  const [params] = useSearchParams()
  const opened = view === 'map' ? params.get('open') : null
  const drawing = useRef<HTMLDivElement>(null)
  const [shift, setShift] = useState(0)
  useEffect(() => {
    // (Measured a frame on: the panel knows it's over the page once it has measured the page.)
    const frame = requestAnimationFrame(() => {
      const aside = document.querySelector<HTMLElement>('aside[data-over]')
      const card = drawing.current?.querySelector<HTMLElement>('[data-open]')
      const by =
        opened && aside && card
          ? (now: number) => {
              const panelLeft =
                aside.parentElement!.getBoundingClientRect().right - aside.offsetWidth
              const at = card.getBoundingClientRect()
              // Clear of the panel by 24 px, 16 px or more from the page's left edge; where there
              // isn't room for both, the room there is split between the two.
              const spare = panelLeft - page.current!.getBoundingClientRect().left - at.width
              const gap = spare >= 40 ? 24 : Math.max(0, spare / 2)
              return Math.max(0, Math.round(at.right + now + gap - panelLeft))
            }
          : () => 0
      setShift(by)
    })
    return () => cancelAnimationFrame(frame)
  }, [opened, width])

  return (
    <div
      ref={page}
      data-narrow={width < 1000 || undefined}
      className="group/map flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto"
    >
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-line bg-app px-6 py-2.5 phone:px-4">
        <span className="text-[13px] text-ink-2">
          {saidCounts([bands.length, kept.grouping], [workloads, 'workload'], [pods, 'pod'])}
        </span>
        <label className="flex items-center gap-1.5 text-[13px] text-ink-3">
          Group by
          <select
            aria-label="Group by"
            value={kept.grouping}
            onChange={(event) => kept.setGrouping(event.target.value as Grouping)}
            className="h-8 rounded-lg border border-line-strong bg-surface px-2 text-[13px] font-medium text-ink-1 phone:h-10"
          >
            <option value="namespace">Namespace</option>
            <option value="node">Node</option>
            <option value="app">App</option>
          </select>
        </label>
        <span className="flex-1" />
        <label className="flex h-8 w-64 max-w-full items-center gap-2 rounded-lg border border-line-strong bg-surface px-2.5 group-data-[narrow]/map:w-44 focus-within:border-accent phone:h-11 phone:w-full">
          <Search className="size-3.5 shrink-0 text-ink-3" />
          <input
            aria-label="Find on the map"
            placeholder="Find on the map"
            value={find}
            onChange={(event) => {
              setFind(event.target.value)
              setAt(0)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setFind('')
              if (event.key === 'Enter' && found.length) {
                const next = (at + (event.shiftKey ? found.length - 1 : 1)) % found.length
                setAt(next)
                document
                  .querySelector(`[data-card="${CSS.escape(found[next]!.id)}"]`)
                  ?.scrollIntoView({ block: 'center' })
              }
            }}
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-ink-3"
          />
          {finding && (
            <span role="status" className="shrink-0 text-xs text-ink-3">
              {found.length ? `${found.length} found` : 'Nothing matches'}
            </span>
          )}
        </label>
        {!phone && (
          <span className="flex gap-0.5" role="group" aria-label="Show as">
            <button
              type="button"
              aria-label="As a map"
              title={listOnly ? 'The map needs a wider window' : 'As a map'}
              aria-pressed={view === 'map'}
              disabled={listOnly}
              onClick={() => kept.setView('map')}
              className={cn(
                'grid size-8 place-items-center rounded-lg text-ink-3 disabled:opacity-40',
                view === 'map' && 'bg-surface-3 text-ink-1',
              )}
            >
              <Network className="size-4" />
            </button>
            <button
              type="button"
              aria-label="As a list"
              title="As a list"
              aria-pressed={view === 'list'}
              onClick={() => kept.setView('list')}
              className={cn(
                'grid size-8 place-items-center rounded-lg text-ink-3',
                view === 'list' && 'bg-surface-3 text-ink-1',
              )}
            >
              <List className="size-4" />
            </button>
          </span>
        )}
      </div>
      {settled && bands.length === 0 ? (
        <p className="px-6 py-10 text-[13px] text-ink-2">Nothing to map in these namespaces.</p>
      ) : view === 'list' ? (
        <MapList
          bands={bands}
          terms={finding ? terms : undefined}
          foundIds={foundIds}
          phone={phone}
        />
      ) : (
        <div
          ref={drawing}
          // (Moved by left, not a transform: a transform would hold the lit card under the shade.)
          style={shift ? { left: -shift } : undefined}
          className="relative px-6 pb-8 transition-[left] duration-200"
        >
          <div
            className={cn(
              'sticky top-[53px] z-[5] grid gap-x-6 bg-app py-2 text-2xs font-medium tracking-wider text-ink-3 uppercase',
              big ? 'grid-cols-4' : 'grid-cols-5',
            )}
          >
            {COLUMNS.filter((c) => !big || c !== 'pods').map((c) => (
              <span key={c}>{COLUMN_NAMES[c]}</span>
            ))}
          </div>
          {bands.map((band) => (
            <BandView
              key={band.key}
              band={band}
              big={big}
              grouping={kept.grouping}
              terms={finding ? terms : undefined}
              foundIds={foundIds}
              namespaces={namespaces}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** A band's health, at its head's right: "2 failing · 1 warning", or "All healthy". */
function BandHealth({ band, noMatch }: { band: Band; noMatch?: boolean }) {
  if (noMatch) return <span className="text-xs text-ink-3">No match</span>
  if (!band.failing && !band.warning) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-ink-3">
        <StatusDot health="healthy" className="size-1.5 ring-0" />
        All healthy
      </span>
    )
  }
  return (
    <span className="flex items-center gap-2 text-xs font-medium">
      {band.failing > 0 && (
        <span className={cn('flex items-center gap-1', HEALTH_STYLE.critical.text)}>
          <StatusDot health="critical" className="size-1.5 ring-0" />
          {band.failing} failing
        </span>
      )}
      {band.warning > 0 && (
        <span className={cn('flex items-center gap-1', HEALTH_STYLE.warning.text)}>
          <StatusDot health="warning" className="size-1.5 ring-0" />
          {band.warning} {band.warning === 1 ? 'warning' : 'warnings'}
        </span>
      )}
    </span>
  )
}

const counts = (band: Band) =>
  saidCounts(
    [band.counts.workloads, 'workload'],
    [band.counts.pods, 'pod'],
    [band.counts.services, 'service'],
  )

const podsIn = (rows: MapRow[]) =>
  rows.reduce((sum, r) => sum + r.cards.pods.reduce((s, g) => s + (g.pods?.length ?? 1), 0), 0)

/** The rest of a band with something unwell, folded: its healthy workloads (only workloads fold). */
const restSaid = (rest: MapRow[]) => {
  const services = new Set(rest.flatMap((r) => r.cards.services.map((s) => s.id))).size
  const pods = podsIn(rest)
  // One of a thing is "its service", not "its 1 service".
  const some = (n: number, noun: string) => (n === 1 ? noun : n ? count(n, noun) : '')
  const with_ = [some(services, 'service'), some(pods, 'pod')].filter(Boolean).join(' and ')
  return `${count(rest.length, 'more workload')}, all healthy${
    with_ ? `, with ${rest.length === 1 ? 'its' : 'their'} ${with_}` : ''
  }`
}

/** A band: its head, then its rows in columns, with lines between their cards. */
function BandView({
  band: listed,
  big,
  grouping,
  terms,
  foundIds,
  namespaces,
}: {
  band: Band
  big: boolean
  grouping: Grouping
  terms?: Terms
  foundIds: Set<string>
  namespaces: readonly string[] | null
}) {
  const [shut, setShut] = useState(false)
  const [shown, setShown] = useState(false)
  const [restShown, setRestShown] = useState(false)
  const band = big && !terms ? gathered(listed) : listed
  const rowMatches = (row: MapRow) =>
    COLUMNS.some((c) => row.cards[c].some((n) => foundIds.has(n.id)))
  const anyMatch = band.rows.some(rowMatches)
  const healthy = !band.failing && !band.warning
  // A big map: a healthy band folds to one card; a band with something unwell draws what's
  // unwell with its chain, the rest one card at its end. A match unfolds what it's in.
  const rowUnwell = (row: MapRow) => COLUMNS.some((c) => row.cards[c].some(unwell))
  const folded = !shown && big && healthy && !(terms && anyMatch)
  // (A service with no pods, a claim no pod holds, is always drawn: only workloads fold.)
  const rest =
    big && !healthy && !restShown && !terms
      ? band.rows.filter((r) => r.workload && !rowUnwell(r))
      : []
  const rows = rest.length ? band.rows.filter((r) => !rest.includes(r)) : band.rows
  const noMatch = terms !== undefined && !anyMatch
  const closed = shut || noMatch
  // Folded, the head is the band's one row; Show (or its chevron) opens all of it.
  const show = () => {
    setShut(false)
    setShown(true)
  }

  return (
    <section aria-label={band.label} className="border-t border-line">
      <div className={cn('flex items-center gap-2 py-2.5', folded && !closed && 'pb-3')}>
        <button
          type="button"
          aria-expanded={!closed && !folded}
          aria-label={`${closed || folded ? 'Show' : 'Fold'} ${band.label}`}
          onClick={() => (closed || folded ? show() : setShut(true))}
          className="grid size-6 place-items-center rounded text-ink-3 hover:bg-surface-3"
        >
          {closed || folded ? (
            <ChevronRight className="size-4" />
          ) : (
            <ChevronDown className="size-4" />
          )}
        </button>
        <h2 className="text-[14px] font-semibold text-ink-1">{band.label}</h2>
        {band.trouble && (
          <span className="rounded-full bg-critical/10 px-2 text-2xs font-medium text-critical-text">
            {band.trouble}
          </span>
        )}
        <span className="text-xs text-ink-3">
          {grouping === 'node' && band.counts.workloads
            ? `${count(band.counts.pods, 'pod')} of ${count(band.counts.workloads, 'workload')}`
            : counts(band)}
          {band.namespaces?.length ? ` · in ${band.namespaces.join(', ')}` : ''}
        </span>
        <span className="flex-1" />
        <BandHealth band={band} noMatch={noMatch} />
        {folded && !closed && (
          <button
            type="button"
            onClick={show}
            className="ml-2 rounded px-1.5 text-xs font-medium text-accent-strong hover:bg-surface-3"
          >
            Show
          </button>
        )}
      </div>
      {!closed && !folded && (
        <Rows
          band={band}
          rows={rows}
          big={big}
          terms={terms}
          foundIds={foundIds}
          namespaces={namespaces}
          rest={
            rest.length > 0 && (
              <button
                type="button"
                onClick={() => setRestShown(true)}
                className="col-span-full mt-1 flex w-full items-center gap-2 rounded-xl border border-dashed border-line-strong px-4 py-3 text-left text-[13px] text-ink-2"
              >
                {restSaid(rest)}
                <span className="flex-1" />
                <span className="font-medium text-accent-strong">Show them</span>
              </button>
            )
          }
        />
      )}
    </section>
  )
}

/** A band's rows, five (or four) columns, and the lines between their cards. */
function Rows({
  band,
  rows,
  big,
  terms,
  foundIds,
  rest,
}: {
  band: Band
  rows: MapRow[]
  big: boolean
  terms?: Terms
  foundIds: Set<string>
  namespaces: readonly string[] | null
  rest: ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const [paths, setPaths] = useState<
    { key: string; d: string; color: string; dashed: boolean; ids: [string, string] }[]
  >([])
  const [lit, setLit] = useState<string>()
  const columns = COLUMNS.filter((c) => !big || c !== 'pods')
  const drawnIds = new Set(rows.flatMap((r) => columns.flatMap((c) => r.cards[c].map((n) => n.id))))
  // (Big, a workload stands for its pods: a line to them goes to it.)
  const via = new Map<string, string>()
  if (big)
    for (const r of rows) for (const p of r.cards.pods) if (r.workload) via.set(p.id, r.workload.id)
  const lines = band.lines
    .map((l) => ({ ...l, from: via.get(l.from) ?? l.from, to: via.get(l.to) ?? l.to }))
    .filter((l) => l.from !== l.to && drawnIds.has(l.from) && drawnIds.has(l.to))
  const healthById = new Map(
    rows.flatMap((r) => COLUMNS.flatMap((c) => r.cards[c])).map((n) => [n.id, healthOf(n)]),
  )
  const linesKey = lines.map((l) => `${l.from}>${l.to}`).join()

  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    const draw = () => {
      const origin = element.getBoundingClientRect()
      const at = (id: string) =>
        element.querySelector(`[data-card="${CSS.escape(id)}"]`)?.getBoundingClientRect()
      setPaths(
        lines.flatMap((l) => {
          const a = at(l.from)
          const b = at(l.to)
          if (!a || !b) return []
          const x1 = a.right - origin.left
          const y1 = a.top + a.height / 2 - origin.top
          const x2 = b.left - origin.left
          const y2 = b.top + b.height / 2 - origin.top
          const mid = (x1 + x2) / 2
          const health = healthById.get(l.to)
          return [
            {
              key: `${l.from}>${l.to}`,
              d: `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`,
              color:
                health === 'critical'
                  ? 'var(--critical)'
                  : health === 'warning'
                    ? 'var(--warn)'
                    : 'var(--line-strong)',
              dashed: l.dashed,
              ids: [l.from, l.to] as [string, string],
            },
          ]
        }),
      )
    }
    draw()
    const observer = new ResizeObserver(draw)
    observer.observe(element)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linesKey, big, rows.length])

  // Hovering or focusing a card lights its chain both ways (its row, as the lines go) and dims the rest.
  const chain = useMemo(() => {
    if (!lit) return undefined
    const keep = new Set([lit])
    let grew = true
    while (grew) {
      grew = false
      for (const l of lines) {
        const next =
          keep.has(l.from) && !keep.has(l.to)
            ? l.to
            : keep.has(l.to) && !keep.has(l.from)
              ? l.from
              : undefined
        if (next) {
          keep.add(next)
          grew = true
        }
      }
    }
    return keep
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lit, linesKey])
  // Finding: a match keeps its look, and so does its row; the rest dims.
  const kept = terms
    ? new Set(
        rows
          .filter((r) => COLUMNS.some((c) => r.cards[c].some((n) => foundIds.has(n.id))))
          .flatMap((r) => COLUMNS.flatMap((c) => r.cards[c].map((n) => via.get(n.id) ?? n.id))),
      )
    : undefined
  // (Finding wins over the chain a card shows on hover.)
  const dimmed = (id: string) => (kept ? !kept.has(id) : chain ? !chain.has(id) : false)

  return (
    <div ref={box} className="relative pb-3">
      <svg aria-hidden className="pointer-events-none absolute inset-0 size-full overflow-visible">
        {paths.map((p) => (
          <path
            key={p.key}
            d={p.d}
            fill="none"
            stroke={p.color}
            strokeWidth={1.5}
            strokeDasharray={p.dashed ? '4 4' : undefined}
            opacity={dimmed(p.ids[0]) || dimmed(p.ids[1]) ? 0.2 : 1}
          />
        ))}
      </svg>
      <div className={cn('relative grid gap-x-6 gap-y-3', big ? 'grid-cols-4' : 'grid-cols-5')}>
        {rows.map((row) =>
          columns.map((c) => (
            <div key={`${row.key}:${c}`} className="flex min-w-0 flex-col gap-3">
              {/* (Big, the Pods column goes: a pod of no workload stands for itself.) */}
              {(big && c === 'workloads' && !row.workload ? row.cards.pods : row.cards[c]).map(
                (node) => (
                  <MapCard
                    key={node.id}
                    node={node}
                    counted={
                      (big || row.spread) && c === 'workloads' && row.workload
                        ? row.cards.pods
                        : undefined
                    }
                    here={row.spread}
                    bar={big}
                    dim={dimmed(node.id)}
                    found={foundIds.has(node.id)}
                    onLit={(on) => setLit(on ? node.id : undefined)}
                  />
                ),
              )}
            </div>
          )),
        )}
        {rest}
      </div>
    </div>
  )
}

/** A card, as the Map tab's: its kind and how it is, then its name; it opens beside. */
function MapCard({
  node,
  counted,
  here,
  bar,
  dim,
  found,
  onLit,
}: {
  node: MapNode
  /** Big: the workload's pods, counted on its card. By node, those on its node, when it's spread. */
  counted?: MapNode[]
  /** Its pods are spread over nodes: those counted are the ones here. */
  here?: boolean
  /** The counted pods' health bar too (where the pods aren't drawn beside it). */
  bar?: boolean
  dim: boolean
  found: boolean
  onLit: (on: boolean) => void
}) {
  const openObject = useOpenObject()
  const showTab = useActionsUi((state) => state.showTab)
  // Pods of no workload, gathered (only those that are well), are counted as a workload's are.
  const status = node.id.startsWith(LOOSE_PODS)
    ? { ...nodeStatus(node)!, label: count(node.pods!.length, 'pod') }
    : nodeStatus(node)
  const meta = nodeMeta(node)
  const quiet = !status || ['healthy', 'neutral'].includes(status.health)
  const pods: KubeObject[] = counted?.flatMap((g) => g.pods ?? (g.object ? [g.object] : [])) ?? []
  const failing = pods.filter(
    (p) => nodeStatus({ id: '', kind: 'Pod', name: '', object: p })!.health === 'critical',
  ).length
  const label = `${kindLabel(node)} ${node.name}${status ? `, ${status.label}` : ''}`
  const target = node.pods
    ? {
        kind: node.pods[0]!.kind === 'Pod' ? 'Pod' : node.kind,
        name: node.pods[0]!.metadata.name,
        namespace: node.namespace,
      }
    : node
  const open = () => openObject(target.kind, target.name, target.namespace)
  const [params] = useSearchParams()
  const opened = params.get('open') === formatRef(target)
  // Opened, with the panel over the map, the card stays lit above the panel's shade: a copy of it,
  // where it is, as the page under the shade (a layer of its own, for page transitions) can't
  // lift it. Clicks go through it to the shade, which closes the panel.
  const self = useRef<HTMLButtonElement>(null)
  const [lifted, setLifted] = useState<{ box: CSSProperties; narrow: boolean } | null>(null)
  useEffect(() => {
    if (!opened) return
    const place = () => {
      const holder = document.getElementById('content')?.parentElement
      const card = self.current
      if (!holder || !card || !holder.querySelector(':scope > div[data-over]'))
        return setLifted(null)
      const at = card.getBoundingClientRect()
      const from = holder.getBoundingClientRect()
      setLifted({
        box: { top: at.top - from.top, left: at.left - from.left, width: at.width },
        narrow: card.closest('[data-narrow]') !== null,
      })
    }
    const frame = requestAnimationFrame(place)
    window.addEventListener('transitionend', place)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('transitionend', place)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [opened])
  const content = (
    <>
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-surface-3 text-ink-2 group-data-[narrow]/map:hidden">
        <KindIcon kind={node.kind} className="size-[15px]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center text-2xs whitespace-nowrap">
          {/* The kind, then its detail (ClusterIP · 9090, a host) only where it fits whole: what
              doesn't wraps to a line that isn't shown. Short of room, the status wins. */}
          <span className="flex h-[1lh] min-w-0 flex-1 flex-wrap overflow-hidden text-ink-3">
            <span className="max-w-full min-w-0 truncate">{kindLabel(node)}</span>
            {meta && !node.pods && !counted && <span>&nbsp;· {meta}</span>}
          </span>
          {status && (
            <span
              className={cn(
                'flex min-w-0 shrink-0 items-center gap-1 pl-2 font-medium',
                quiet ? 'text-ink-2' : HEALTH_STYLE[status.health].text,
              )}
            >
              <StatusDot health={status.health} className="size-1.5 ring-0" />
              <span className="max-w-28 truncate">{status.label}</span>
            </span>
          )}
        </span>
        {/* The name whole, where it can be; its pods counted beside it only where that fits too. */}
        <span className="flex h-5 min-w-0 flex-wrap items-baseline gap-x-1.5 overflow-hidden text-[13px] leading-5">
          <span className="max-w-full min-w-0 truncate font-medium text-ink-1">{node.name}</span>
          {counted && pods.length > 0 && (
            <span
              className={cn(
                'text-2xs whitespace-nowrap',
                failing ? 'text-critical-text' : 'text-ink-3',
              )}
            >
              {here
                ? `${pods.length.toLocaleString('en-US')} here${failing ? `, ${failing} failing` : ''}`
                : failing
                  ? `${failing} of ${pods.length.toLocaleString('en-US')} failing`
                  : count(pods.length, 'pod')}
            </span>
          )}
        </span>
      </span>
      {node.pods && <PodsBar pods={node.pods} />}
      {bar && counted && pods.length > 0 && <PodsBar pods={pods} />}
    </>
  )
  const look = cn(
    'relative flex h-14 w-full items-center gap-2.5 rounded-xl border px-3 text-left transition-[opacity,border-color] outline-none focus-visible:ring-3 focus-visible:ring-accent-soft',
    node.missing
      ? 'border-dashed border-critical/45 bg-critical/5'
      : opened
        ? 'border-accent bg-surface ring-3 ring-accent-soft'
        : found
          ? 'border-accent bg-surface'
          : 'border-line bg-surface shadow-xs hover:border-line-strong',
    dim && !opened && 'opacity-35',
  )
  if (node.missing) {
    return (
      <div role="img" aria-label={label} data-card={node.id} className={look}>
        {content}
      </div>
    )
  }
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <button
          ref={self}
          type="button"
          data-card={node.id}
          data-open={opened || undefined}
          aria-label={label}
          title={`${kindLabel(node)} ${node.name}`}
          className={cn(look, 'cursor-pointer')}
          onMouseEnter={() => onLit(true)}
          onMouseLeave={() => onLit(false)}
          onFocus={() => onLit(true)}
          onBlur={() => onLit(false)}
          onClick={open}
        >
          {content}
          {opened &&
            lifted &&
            createPortal(
              <div aria-hidden data-narrow={lifted.narrow || undefined} className="group/map">
                <div
                  data-lifted
                  style={lifted.box}
                  className={cn(look, 'pointer-events-none absolute z-[15]')}
                >
                  {content}
                </div>
              </div>,
              document.getElementById('content')!.parentElement!,
            )}
        </button>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="z-50 min-w-44 rounded-xl border border-line-strong bg-surface-2 p-1 shadow-pop">
          <ContextMenu.Item
            className="flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-[13px] outline-none data-[highlighted]:bg-surface-3"
            onSelect={() => {
              open()
              showTab(formatRef(target), 'map')
            }}
          >
            <Network className="size-4 text-ink-3" />
            Open its map
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}

/** The map as a list: the same bands, a row a workload, then what's not of one. */
function MapList({
  bands,
  terms,
  foundIds,
  phone,
}: {
  bands: Band[]
  terms?: Terms
  foundIds: Set<string>
  phone: boolean
}) {
  const openObject = useOpenObject()
  // A name more than one object goes by (an Ingress, its route and its Service) once, with their kinds.
  const names = (nodes: MapNode[]) => {
    const kinds = new Map<string, string[]>()
    for (const n of nodes) kinds.set(n.name, [...(kinds.get(n.name) ?? []), kindLabel(n)])
    return [...kinds]
      .map(([name, of]) => (of.length > 1 ? `${name} (${of.join(', ')})` : name))
      .join(', ')
  }
  return (
    <div role="table" aria-label="Map" className="pb-8">
      {!phone && (
        <div
          role="row"
          className="grid grid-cols-[minmax(0,1.3fr)_150px_140px_minmax(0,1fr)_minmax(0,1fr)] gap-x-4 border-b border-line px-6 py-2 text-2xs font-medium tracking-wider text-ink-3 uppercase"
        >
          <span role="columnheader">Name</span>
          <span role="columnheader">Status</span>
          <span role="columnheader">Pods</span>
          <span role="columnheader">Reached by</span>
          <span role="columnheader">Uses</span>
        </div>
      )}
      {bands.map((band) => {
        const rows = terms
          ? band.rows.filter((r) => COLUMNS.some((c) => r.cards[c].some((n) => foundIds.has(n.id))))
          : band.rows
        return (
          <div role="rowgroup" aria-label={band.label} key={band.key}>
            <div
              role="row"
              className="flex items-center gap-2 border-b border-line bg-surface-2/60 px-6 py-2 phone:px-4"
            >
              <span role="rowheader" className="text-[13px] font-semibold text-ink-1">
                {band.label}
              </span>
              <span className="text-xs text-ink-3">{counts(band)}</span>
              <span className="flex-1" />
              <BandHealth band={band} noMatch={terms !== undefined && rows.length === 0} />
            </div>
            {rows.map((row) => {
              const lead =
                row.workload ?? row.cards.pods[0] ?? row.cards.services[0] ?? row.cards.config[0]!
              const status = nodeStatus(lead)
              const pods = row.cards.pods.flatMap((g) => g.pods ?? (g.object ? [g.object] : []))
              const failing = pods.filter(
                (p) =>
                  nodeStatus({ id: '', kind: 'Pod', name: '', object: p })!.health === 'critical',
              ).length
              const podsSaid = pods.length
                ? `${pods.length}${failing ? ` · ${failing} failing` : ''}`
                : '—'
              const target = lead.pods ? { kind: 'Pod', name: lead.pods[0]!.metadata.name } : lead
              return (
                <button
                  type="button"
                  role="row"
                  key={row.key}
                  onClick={() => openObject(target.kind, target.name, lead.namespace)}
                  className={cn(
                    'w-full border-b border-line px-6 py-2 text-left text-[13px] hover:bg-surface-3/50 phone:px-4',
                    !phone &&
                      'grid grid-cols-[minmax(0,1.3fr)_150px_140px_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-4',
                  )}
                >
                  <span role="cell" className="flex min-w-0 flex-col">
                    <span className="truncate font-medium text-ink-1">{lead.name}</span>
                    <span className="text-xs text-ink-3">
                      {kindLabel(lead)}
                      {phone && pods.length ? ` · ${count(pods.length, 'pod')}` : ''}
                      {phone && failing ? (
                        <span className="text-critical-text"> · {failing} failing</span>
                      ) : null}
                    </span>
                  </span>
                  {!phone && (
                    <>
                      <span
                        role="cell"
                        className={cn(
                          'flex items-center gap-1.5 text-xs',
                          status && HEALTH_STYLE[status.health].text,
                        )}
                      >
                        {status && <StatusDot health={status.health} className="size-1.5 ring-0" />}
                        {status?.label ?? '—'}
                      </span>
                      <span
                        role="cell"
                        className={cn('text-xs', failing ? 'text-critical-text' : 'text-ink-2')}
                      >
                        {podsSaid}
                      </span>
                      <span role="cell" className="truncate text-xs text-ink-2">
                        {names([...row.cards.traffic, ...row.cards.services]) || '—'}
                      </span>
                      <span role="cell" className="truncate text-xs text-ink-2">
                        {names(row.cards.config) || '—'}
                        {row.cards.config.some((c) => c.missing) && (
                          <TriangleAlert className="ml-1 inline size-3 text-critical-text" />
                        )}
                      </span>
                    </>
                  )}
                </button>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

import { ChevronsDownUp, Plus, Waypoints } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { KubeObject } from '@shared/api'
import { apiKindOf, isBuiltinKind, kindOf, type ResourceKind } from '@shared/resources'
import { KindIcon } from '@renderer/components/KindIcon'
import { EmptyState, Loading } from '@renderer/components/States'
import { HEALTH_STYLE, StatusDot } from '@renderer/components/Status'
import { useOpenObject } from '@renderer/hooks/open-object'
import { useLists } from '@renderer/hooks/queries'
import { useResources } from '@renderer/hooks/resources'
import { cn } from '@renderer/lib/cn'
import type { Health } from '@renderer/lib/health'
import {
  buildMap,
  CLUSTER_MAP_KINDS,
  MAP_KINDS,
  nodeMeta,
  nodeStatus,
  RELATION_NAMES,
  USES,
  type MapGraph,
  type MapNode,
} from '@renderer/lib/map'
import { CARD_HEIGHT, layoutMap, type MapLayout, type PlacedCard } from '@renderer/lib/map-layout'
import { formatRef } from '@renderer/lib/routes'
import { useActionsUi } from '@renderer/state/actions'
import { relatedOf } from './RelatedTab'

/** Kinds by shorter names, as the sidebar has them. */
const SHORT: Record<string, string> = {
  HorizontalPodAutoscaler: 'Autoscaler',
  PersistentVolumeClaim: 'Volume claim',
  PersistentVolume: 'Volume',
  NetworkPolicy: 'Network policy',
  ServiceAccount: 'Service account',
  StorageClass: 'Storage class',
  PodDisruptionBudget: 'Disruption budget',
}

/** What a card calls its node's kind: "Deployment", "HTTPRoute", "Pods". */
const kindLabel = (node: MapNode) => {
  const kind = apiKindOf(node.kind)
  return node.pods ? 'Pods' : (SHORT[kind] ?? kind)
}

const COUNT = new Intl.NumberFormat()

/** Lines to what's unwell take its color. */
const EDGE_COLOR: Partial<Record<Health, string>> = {
  critical: 'var(--critical)',
  warning: 'var(--warn)',
}

/** Everything the map is made from: the object's namespace (or the cluster), and its view's relations. */
function useMapData(object: KubeObject) {
  const resources = useResources()
  const related = relatedOf(object)
  const namespace = object.metadata.namespace ?? null
  // Kinds that aren't Kubernetes' own are listed only where the cluster serves them.
  const served = (kind: ResourceKind) =>
    isBuiltinKind(kind) || resources.data?.some((r) => r.kind === kind) === true
  const requests = [
    ...MAP_KINDS.map((kind) => ({ kind, namespace, enabled: served(kind) })),
    ...CLUSTER_MAP_KINDS.map((kind) => ({ kind, namespace: null, enabled: true })),
    ...related.map((r) => ({
      kind: r.kind,
      namespace: r.namespace,
      labelSelector: r.labelSelector,
      fieldSelector: r.fieldSelector,
      enabled: served(r.kind),
    })),
  ]
  const lists = useLists(requests)
  const settled =
    !resources.isPending &&
    lists.every((l, i) => !requests[i]!.enabled || l.data !== undefined || l.error !== null)
  const own = MAP_KINDS.length + CLUSTER_MAP_KINDS.length
  return {
    settled,
    pool: lists.slice(0, own).flatMap((l) => l.data ?? []),
    listed: new Set(requests.filter((_, i) => i < own && lists[i]!.data).map((r) => r.kind)),
    related: lists.slice(own).flatMap((l) => l.data ?? []),
    stamp: lists.map((l) => l.dataUpdatedAt).join(),
  }
}

/**
 * How an object is connected: above it, what leads to it (traffic, the
 * controllers and policies acting on it); below, what it owns, uses and
 * runs on. Each card opens its object, on its own map.
 */
export function MapTab({ object }: { object: KubeObject }) {
  const data = useMapData(object)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set())
  const { stamp } = data
  const graph = useMemo(
    () =>
      data.settled
        ? buildMap({
            pool: data.pool,
            listed: data.listed,
            focus: object,
            expanded,
            related: data.related,
          })
        : undefined,
    // The lists are new arrays each render; `stamp` says when what's in them changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.settled, stamp, object, expanded],
  )

  if (!graph) return <Loading label="Finding what it’s connected to…" />
  if (graph.nodes.size === 1) return <Alone object={object} />
  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-5 py-2.5 text-xs text-ink-3">
        <p className="min-w-0 flex-1">Above it, what leads to it; below, what it uses.</p>
        {(expanded.size > 0 || open.size > 0) && (
          <button
            type="button"
            onClick={() => {
              setExpanded(new Set())
              setOpen(new Set())
            }}
            className="flex items-center gap-1 font-medium text-accent-strong hover:underline"
          >
            <ChevronsDownUp className="size-3.5" />
            Collapse
          </button>
        )}
        <Legend />
      </header>
      <Canvas
        graph={graph}
        open={open}
        onOpenRow={(row) => setOpen(new Set([...open, row]))}
        onExpand={(id) => setExpanded(new Set([...expanded, id]))}
      />
    </div>
  )
}

function Legend() {
  const line = (dashed: boolean) => (
    <svg width="22" height="6" aria-hidden className="shrink-0">
      <path
        d="M 1 3 L 21 3"
        stroke="var(--text-3)"
        strokeWidth="1.5"
        strokeDasharray={dashed ? '3 3' : undefined}
      />
    </svg>
  )
  return (
    <p className="flex items-center gap-3">
      <span className="flex items-center gap-1.5">
        {line(false)}
        Routes, owns
      </span>
      <span className="flex items-center gap-1.5">
        {line(true)}
        Uses
      </span>
    </p>
  )
}

/** What a kind's object being alone means. */
const ALONE: Partial<Record<ResourceKind, string>> = {
  ConfigMap: 'No pod, workload or ingress here refers to it.',
  Secret: 'No pod, workload or ingress here refers to it.',
  PersistentVolumeClaim: 'No pod mounts it.',
  Service: 'It selects no pods, and nothing routes to it.',
}

function Alone({ object }: { object: KubeObject }) {
  const kind = kindOf(object)
  return (
    <EmptyState icon={Waypoints} title="Nothing connected">
      {ALONE[kind] ?? `Nothing here refers to this ${apiKindOf(kind)}, and it refers to nothing.`}
    </EmptyState>
  )
}

function Canvas({
  graph,
  open,
  onOpenRow,
  onExpand,
}: {
  graph: MapGraph
  open: ReadonlySet<number>
  onOpenRow: (row: number) => void
  onExpand: (group: string) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<string | null>(null)
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width))
    observer.observe(box.current!)
    return () => observer.disconnect()
  }, [])
  const layout = useMemo(() => layoutMap(graph, width, open), [graph, width, open])
  const lit = useMemo(() => (hover ? litFrom(layout, hover) : null), [layout, hover])

  return (
    <div className="min-h-0 flex-1 overflow-auto px-5 py-5">
      <div
        ref={box}
        role="group"
        aria-label="Map"
        className="relative"
        style={{ height: layout.height }}
      >
        {width > 0 && (
          <>
            <svg
              aria-hidden
              width={width}
              height={layout.height}
              className="pointer-events-none absolute inset-0 overflow-visible"
            >
              {/* Where lines share a lane, the ones that say something are drawn last, on top. */}
              {layout.edges
                .map((e) => {
                  const target = layout.cards.find((c) => c.key === e.to)!.node
                  const color = target && EDGE_COLOR[nodeStatus(target)?.health ?? 'neutral']
                  const on = lit?.has(e.from) === true && lit.has(e.to)
                  return { e, color, on, order: on ? 2 : color ? 1 : 0 }
                })
                .sort((a, b) => a.order - b.order)
                .map(({ e, color, on }) => (
                  <path
                    key={e.key}
                    d={e.path}
                    fill="none"
                    stroke={on ? 'var(--accent)' : (color ?? 'var(--line-strong)')}
                    strokeWidth={on ? 2 : 1.5}
                    strokeDasharray={USES.has(e.edge.relation) ? '4 4' : undefined}
                    strokeLinejoin="round"
                    className="transition-[d,stroke,opacity] duration-300 ease-out"
                    style={{ opacity: lit && !on ? 0.2 : 1 }}
                  />
                ))}
            </svg>
            {layout.cards.map((card) => (
              <Card
                key={card.key}
                card={card}
                graph={graph}
                layout={layout}
                dim={lit ? !lit.has(card.key) : false}
                onHover={(on) => setHover(on ? card.key : null)}
                onOpenRow={onOpenRow}
                onExpand={onExpand}
              />
            ))}
          </>
        )}
      </div>
    </div>
  )
}

/** The cards a card leads to and is led to from, all the way: its chain through the map. */
function litFrom(layout: MapLayout, key: string): Set<string> {
  const lit = new Set([key])
  for (const side of ['to', 'from'] as const) {
    const other = side === 'to' ? 'from' : 'to'
    let frontier = [key]
    const seen = new Set([key])
    while (frontier.length > 0) {
      frontier = layout.edges
        .filter((e) => frontier.includes(e[other]) && !seen.has(e[side]))
        .map((e) => e[side])
      for (const next of frontier) {
        seen.add(next)
        lit.add(next)
      }
    }
  }
  return lit
}

function Card({
  card,
  graph,
  layout,
  dim,
  onHover,
  onOpenRow,
  onExpand,
}: {
  card: PlacedCard
  graph: MapGraph
  layout: MapLayout
  dim: boolean
  onHover: (on: boolean) => void
  onOpenRow: (row: number) => void
  onExpand: (group: string) => void
}) {
  const openObject = useOpenObject()
  const showTab = useActionsUi((state) => state.showTab)
  const describedBy = useId()
  const style: CSSProperties = {
    width: card.width,
    height: CARD_HEIGHT,
    transform: `translate(${card.x}px, ${card.y}px)`,
  }
  const base =
    'absolute top-0 left-0 flex items-center gap-2.5 rounded-xl border px-3 text-left transition-[transform,opacity,border-color,box-shadow] duration-300 ease-out outline-none focus-visible:ring-3 focus-visible:ring-accent-soft'
  const hovering = { onMouseEnter: () => onHover(true), onMouseLeave: () => onHover(false) }

  if (card.more) {
    const { row, count } = card.more
    return (
      <button
        type="button"
        style={style}
        onClick={() => onOpenRow(row)}
        onFocus={() => onHover(true)}
        onBlur={() => onHover(false)}
        {...hovering}
        className={cn(
          base,
          'justify-center border-dashed border-line-strong bg-surface-2 text-[13px] font-medium text-ink-2 hover:border-accent/50 hover:text-accent-strong',
          dim && 'opacity-40',
        )}
      >
        <Plus className="size-4" />
        {COUNT.format(count)} more
      </button>
    )
  }

  const node = card.node!
  const focus = node.id === graph.focus
  const status = nodeStatus(node)
  const meta = nodeMeta(node)
  const quiet = !status || ['healthy', 'neutral'].includes(status.health)
  const label = `${kindLabel(node)} ${node.name}${status ? `, ${status.label}` : ''}`
  // The kind and how it's doing; then its name, and a word about it (a Service's ports).
  const content = (
    <>
      <span
        className={cn(
          'grid size-7 shrink-0 place-items-center rounded-lg',
          focus ? 'bg-accent text-white' : 'bg-surface-3 text-ink-2',
        )}
      >
        <KindIcon kind={node.kind} className="size-[15px]" />
      </span>
      <span className="min-w-0 flex-1">
        {/* What gives way first when it's narrow: the detail, then the kind; never how it's doing. */}
        <span className="flex min-w-0 items-center text-2xs whitespace-nowrap">
          <span className="shrink-0 text-ink-3">{kindLabel(node)}</span>
          {meta && !node.pods && (
            <span className="min-w-0 shrink-[999] truncate text-ink-3">&nbsp;· {meta}</span>
          )}
          {status && (
            <span
              className={cn(
                'ml-auto flex min-w-0 shrink-0 items-center gap-1 pl-2 font-medium',
                quiet ? 'text-ink-2' : HEALTH_STYLE[status.health].text,
              )}
            >
              <StatusDot health={status.health} className="size-1.5 ring-0" />
              <span className="max-w-28 truncate">{status.label}</span>
            </span>
          )}
        </span>
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-[13px] font-medium text-ink-1">{node.name}</span>
          {/* A revision goes with the name of the Deployment it's one of. */}
          {meta && node.pods && <span className="shrink-0 text-2xs text-ink-3">{meta}</span>}
        </span>
      </span>
      {node.pods && <PodsBar pods={node.pods} />}
      <Connections id={describedBy} card={card} layout={layout} />
    </>
  )
  const look = cn(
    base,
    focus
      ? 'border-accent bg-surface shadow-[0_0_0_4px_var(--accent-soft)]'
      : node.missing
        ? 'border-dashed border-critical/45 bg-critical/5'
        : 'border-line bg-surface shadow-xs hover:border-line-strong hover:shadow-sm',
    dim && 'opacity-35',
  )

  // The map's own object is where it is, and what's missing can't be opened.
  if (focus || node.missing) {
    return (
      <div
        role="img"
        aria-label={focus ? `${label} (this ${kindLabel(node)})` : label}
        aria-describedby={describedBy}
        style={style}
        className={look}
        {...hovering}
      >
        {content}
      </div>
    )
  }
  return (
    <button
      type="button"
      aria-label={node.pods ? `${label}: show each pod` : label}
      aria-describedby={describedBy}
      style={style}
      className={cn(look, 'cursor-pointer')}
      onFocus={() => onHover(true)}
      onBlur={() => onHover(false)}
      {...hovering}
      onClick={() => {
        if (node.pods) {
          onExpand(node.id)
          return
        }
        // Another object's map: where it leads, from there.
        openObject(node.kind, node.name, node.namespace)
        showTab(formatRef(node), 'map')
      }}
    >
      {content}
    </button>
  )
}

/** A group's pods by health, along the bottom of its card. */
function PodsBar({ pods }: { pods: KubeObject[] }) {
  const healths = pods.map((p) => nodeStatus({ id: '', kind: 'Pod', name: '', object: p })!.health)
  const order: Health[] = ['healthy', 'progressing', 'warning', 'critical', 'neutral']
  return (
    <span
      aria-hidden
      className="absolute inset-x-3 bottom-1.5 flex h-[3px] gap-px overflow-hidden rounded-full"
    >
      {order.map((health) => {
        const n = healths.filter((h) => h === health).length
        return n > 0 ? (
          <span key={health} className={HEALTH_STYLE[health].dot} style={{ flexGrow: n }} />
        ) : null
      })}
    </span>
  )
}

/** What a card's object is connected to, in words, for screen readers. */
function Connections({ id, card, layout }: { id: string; card: PlacedCard; layout: MapLayout }) {
  const named = (key: string) => {
    const other = layout.cards.find((c) => c.key === key)!
    return other.node ? `${kindLabel(other.node)} ${other.node.name}` : 'more'
  }
  const sentences = layout.edges.flatMap((e) => {
    if (e.from === card.key) return [`${RELATION_NAMES[e.edge.relation]} ${named(e.to)}.`]
    if (e.to === card.key) {
      return [`${named(e.from)}: ${RELATION_NAMES[e.edge.relation].toLowerCase()} it.`]
    }
    return []
  })
  return (
    <span id={id} hidden>
      {sentences.join(' ')}
    </span>
  )
}

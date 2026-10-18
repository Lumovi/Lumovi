/**
 * The Map page's picture (LMV-172): everything in the namespaces picked, as the Map tab draws one
 * object's (map.ts's graph of all of it), laid out in five columns (traffic, services, workloads,
 * pods, config and storage) and in bands: by namespace, node or app label.
 *
 * A row is a workload and its chain: what routes to it, the services that select its pods, its
 * pods, and what it uses or mounts. What belongs to no workload (a service with no pods, a claim
 * nothing mounts, a pod of its own) has a row of its own. ConfigMaps and Secrets nothing uses
 * aren't drawn; nor are service accounts, roles and bindings (the Map tab has them).
 */
import type { Health } from '@shared/health'
import { GATEWAY, HTTP_ROUTE, nodeStatus, type MapEdge, type MapGraph, type MapNode } from './map'

export type Column = 'traffic' | 'services' | 'workloads' | 'pods' | 'config'
export const COLUMNS: Column[] = ['traffic', 'services', 'workloads', 'pods', 'config']

const TRAFFIC = new Set<string>(['Ingress', HTTP_ROUTE])
const WORKLOADS = new Set<string>([
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'CronJob',
  'Job',
  'ReplicaSet',
])
const CONFIG = new Set<string>(['ConfigMap', 'Secret', 'PersistentVolumeClaim'])

/** Where a node is drawn. */
export function columnOf(node: MapNode): Column | undefined {
  if (TRAFFIC.has(node.kind)) return 'traffic'
  if (node.kind === 'Service') return 'services'
  if (WORKLOADS.has(node.kind)) return 'workloads'
  if (node.kind === 'Pod') return 'pods'
  if (CONFIG.has(node.kind)) return 'config'
  return undefined
}

/** A row: its cards, a column at a time; and its workload, where it has one. */
export interface MapRow {
  key: string
  cards: Record<Column, MapNode[]>
  workload?: MapNode
  /** By node, its workload has pods on other nodes too: its pods here are some of them. */
  spread?: boolean
}

/** A line between two cards drawn: dashed for what's used or mounted. */
export interface MapLine {
  from: string
  to: string
  dashed: boolean
}

export interface Band {
  key: string
  /** The namespace's, node's or app's name; or what a band of the rest is called. */
  label: string
  rows: MapRow[]
  lines: MapLine[]
  counts: { workloads: number; pods: number; services: number }
  /** How many things in it are failing, and how many warn. */
  failing: number
  warning: number
  /** A node's own trouble, by node (NotReady, Memory pressure…). */
  trouble?: string
  /** An app's band: the namespaces it's in. */
  namespaces?: string[]
}

export type Grouping = 'namespace' | 'node' | 'app'

/** How a node is: its status's health, or none. */
export const healthOf = (node: MapNode): Health | undefined => nodeStatus(node)?.health

const empty = (): Record<Column, MapNode[]> => ({
  traffic: [],
  services: [],
  workloads: [],
  pods: [],
  config: [],
})

/** A pod group's pods on one node: drawn in that node's band. */
const onNode = (group: MapNode, node: string | undefined): MapNode => ({
  ...group,
  id: `${group.id}@${node ?? ''}`,
  pods: group.pods!.filter((pod) => (pod.spec?.nodeName ?? undefined) === node),
})

/** The app a node belongs to by its labels: app.kubernetes.io/name, else app. */
const appOf = (node: MapNode) => {
  const labels = node.object?.metadata.labels ?? node.pods?.[0]?.metadata.labels
  return labels?.['app.kubernetes.io/name'] ?? labels?.app
}

/**
 * The picture's rows and bands, from the graph of everything in the namespaces picked: in name
 * order, a band never moving when its health changes. Bands with nothing to draw aren't there.
 */
export function bandsOf(graph: MapGraph, grouping: Grouping): Band[] {
  const out = new Map<string, MapEdge[]>()
  const into = new Map<string, MapEdge[]>()
  for (const edge of graph.edges) {
    if (!out.has(edge.from)) out.set(edge.from, [])
    if (!into.has(edge.to)) into.set(edge.to, [])
    out.get(edge.from)!.push(edge)
    into.get(edge.to)!.push(edge)
  }
  const node = (id: string) => graph.nodes.get(id)
  const targets = (id: string, keep: (n: MapNode, e: MapEdge) => boolean) =>
    (out.get(id) ?? []).flatMap((e) => {
      const n = node(e.to)
      return n && keep(n, e) ? [n] : []
    })
  const sources = (id: string, keep: (n: MapNode, e: MapEdge) => boolean) =>
    (into.get(id) ?? []).flatMap((e) => {
      const n = node(e.from)
      return n && keep(n, e) ? [n] : []
    })

  // A workload's chain. A Job a CronJob owns is part of its CronJob's.
  const ownedJob = (n: MapNode) =>
    n.kind === 'Job' &&
    sources(n.id, (s, e) => s.kind === 'CronJob' && e.relation === 'owns').length > 0
  const workloads = [...graph.nodes.values()]
    .filter((n) => WORKLOADS.has(n.kind) && n.object && !ownedJob(n))
    .sort((a, b) => a.name.localeCompare(b.name))
  const podsOf = (w: MapNode): MapNode[] => [
    ...targets(w.id, (n, e) => n.kind === 'Pod' && e.relation === 'owns'),
    ...targets(w.id, (n, e) => n.kind === 'Job' && e.relation === 'owns').flatMap(podsOf),
  ]
  const chain = (anchor: MapNode, pods: MapNode[]) => {
    const services = [
      ...new Map(
        // (A service selects a workload's pods: its line is to the workload, or to a pod of its own.)
        [anchor, ...pods]
          .flatMap((p) => sources(p.id, (s, e) => s.kind === 'Service' && e.relation === 'selects'))
          .map((s) => [s.id, s]),
      ).values(),
    ]
    const traffic = [
      ...new Map(
        services
          .flatMap((s) => sources(s.id, (t, e) => TRAFFIC.has(t.kind) && e.relation === 'routes'))
          .map((t) => [t.id, t]),
      ).values(),
    ]
    const used = (from: MapNode) => targets(from.id, (n) => CONFIG.has(n.kind))
    const config = [...new Map([anchor, ...pods].flatMap(used).map((c) => [c.id, c])).values()]
    return { services, traffic, config }
  }

  type Placed = { row: MapRow; band: string }
  const placed: Placed[] = []
  const add = (
    band: string,
    key: string,
    cards: Record<Column, MapNode[]>,
    workload?: MapNode,
    spread = false,
  ) =>
    placed.push({
      band,
      row: { key, cards, ...(workload ? { workload } : {}), ...(spread ? { spread } : {}) },
    })

  const bandOf = (n: MapNode, nodeName?: string): string =>
    grouping === 'namespace'
      ? (n.namespace ?? '')
      : grouping === 'node'
        ? (nodeName ?? '\u0000unscheduled')
        : (appOf(n) ?? '\u0000none')

  const drawn = new Set<string>()
  for (const w of workloads) {
    const groups = podsOf(w)
    // By node, a workload is drawn in each node it has pods on, with those pods.
    const splits =
      grouping === 'node'
        ? [
            ...new Set(
              groups.flatMap((g) => g.pods!.map((p) => p.spec?.nodeName as string | undefined)),
            ),
          ].map((name) => ({
            name,
            pods: groups.map((g) => onNode(g, name)).filter((g) => g.pods!.length),
          }))
        : [{ name: undefined, pods: groups }]
    for (const split of splits.length ? splits : [{ name: undefined, pods: [] }]) {
      const { services, traffic, config } = chain(w, split.pods)
      for (const n of [w, ...services, ...traffic, ...config, ...groups]) drawn.add(n.id)
      add(
        bandOf(w, split.name),
        `${w.id}@${split.name ?? ''}`,
        {
          ...empty(),
          traffic,
          services,
          workloads: [w],
          pods: split.pods,
          config,
        },
        w,
        splits.length > 1,
      )
    }
  }
  // A pod of its own (no workload), and what it's connected to.
  for (const p of graph.nodes.values()) {
    if (p.kind !== 'Pod' || p.pods || drawn.has(p.id) || !p.object) continue
    const { services, traffic, config } = chain(p, [p])
    for (const n of [p, ...services, ...traffic, ...config]) drawn.add(n.id)
    add(bandOf(p, p.object.spec?.nodeName), p.id, {
      ...empty(),
      traffic,
      services,
      pods: [p],
      config,
    })
  }
  // A service with no pods (said with its warning), what routes to it; then claims nothing mounts.
  for (const s of graph.nodes.values()) {
    if (s.kind !== 'Service' || drawn.has(s.id) || !s.object) continue
    const traffic = sources(s.id, (t, e) => TRAFFIC.has(t.kind) && e.relation === 'routes')
    for (const n of [s, ...traffic]) drawn.add(n.id)
    add(bandOf(s), s.id, { ...empty(), traffic, services: [s] })
  }
  for (const c of graph.nodes.values()) {
    if (c.kind !== 'PersistentVolumeClaim' || drawn.has(c.id) || !c.object) continue
    drawn.add(c.id)
    add(bandOf(c), c.id, { ...empty(), config: [c] })
  }

  const bands = new Map<string, MapRow[]>()
  for (const { band, row } of placed) {
    if (!bands.has(band)) bands.set(band, [])
    bands.get(band)!.push(row)
  }
  const nodeTrouble = (name: string) => {
    const n = node(`Node//${name}`)
    const status = n && healthOf(n) !== 'healthy' ? nodeStatus(n) : undefined
    return status?.label
  }
  return [...bands.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, rows]): Band => {
      const seen = new Set<string>()
      let failing = 0
      let warning = 0
      const count = (n: MapNode) => {
        if (seen.has(n.id)) return
        seen.add(n.id)
        const health = healthOf(n)
        if (health === 'critical') failing++
        else if (health === 'warning') warning++
      }
      // Each workload as its card says; what's outside a workload on its own, as what it uses or
      // mounts is (a claim that's Pending, a Secret that's missing).
      // By node, a workload's pods on this node, not how it is overall (its card still says that).
      for (const row of rows) {
        if (row.workload && grouping === 'node' && row.cards.pods.length)
          for (const p of row.cards.pods) count(p)
        else if (row.workload) count(row.workload)
        else for (const n of COLUMNS.flatMap((c) => row.cards[c])) count(n)
        for (const c of row.cards.config) count(c)
      }
      // By node, the node too: one that's NotReady or under pressure is trouble of the band's.
      const own = grouping === 'node' ? node(`Node//${key}`) : undefined
      if (own) count(own)
      const services = new Set(rows.flatMap((r) => r.cards.services.map((s) => s.id)))
      const pods = new Set(
        rows.flatMap((r) =>
          r.cards.pods.flatMap((g) =>
            (g.pods ?? (g.object ? [g.object] : [])).map((p) => p.metadata.uid),
          ),
        ),
      )
      const trouble =
        grouping === 'node' && !key.startsWith('\u0000') ? nodeTrouble(key) : undefined
      return {
        key,
        label:
          key === '\u0000unscheduled' ? 'No node' : key === '\u0000none' ? 'No app label' : key,
        rows,
        lines: linesOf(rows, out),
        counts: {
          workloads: new Set(rows.flatMap((r) => (r.workload ? [r.workload.id] : []))).size,
          pods: pods.size,
          services: services.size,
        },
        failing,
        warning,
        ...(trouble ? { trouble } : {}),
        ...(grouping === 'app'
          ? {
              namespaces: [
                ...new Set(
                  rows.flatMap((r) =>
                    COLUMNS.flatMap((c) => r.cards[c]).map((n) => n.namespace ?? ''),
                  ),
                ),
              ]
                .filter(Boolean)
                .sort(),
            }
          : {}),
      }
    })
}

/**
 * A big map's rows: a band's healthy pods of no workload are one card at its end, as a controller's pods
 * are, with what routes to them, selects them or is used by them; a card a pod would be thousands.
 */
export const LOOSE_PODS = 'pods:\u0000loose:'

export function gathered(band: Band): Band {
  const loose = band.rows.filter(
    (r) =>
      !r.workload &&
      r.cards.pods.some((p) => !p.pods) &&
      !COLUMNS.some((c) => r.cards[c].some(unwell)),
  )
  if (loose.length < 2) return band
  const first = loose[0]!.cards.pods[0]!
  const all = (c: Column) => [
    ...new Map(loose.flatMap((r) => r.cards[c]).map((n) => [n.id, n])).values(),
  ]
  const pods: MapNode = {
    id: `${LOOSE_PODS}${first.id}`,
    kind: 'Pod',
    name: 'of no workload',
    namespace: first.namespace,
    pods: all('pods').flatMap((p) => p.pods ?? (p.object ? [p.object] : [])),
  }
  const gone = new Set(all('pods').map((p) => p.id))
  const at = (id: string) => (gone.has(id) ? pods.id : id)
  const lines = new Map(
    band.lines.map((l) => {
      const line = { ...l, from: at(l.from), to: at(l.to) }
      return [`${line.from}>${line.to}`, line]
    }),
  )
  return {
    ...band,
    rows: [
      ...band.rows.filter((r) => !loose.includes(r)),
      {
        key: '\u0000loose',
        cards: {
          traffic: all('traffic'),
          services: all('services'),
          workloads: [],
          pods: [pods],
          config: all('config'),
        },
      },
    ],
    lines: [...lines.values()],
  }
}

/**
 * A band's lines, card to card, row by row: traffic to the services it routes to, a service to
 * the row's workload (whose pods it selects), the workload to its pods, and what's used or
 * mounted (dashed).
 */
function linesOf(rows: MapRow[], out: Map<string, MapEdge[]>): MapLine[] {
  const lines = new Map<string, MapLine>()
  const line = (from: string, to: string, dashed = false) =>
    lines.set(`${from}>${to}`, { from, to, dashed })
  const has = (from: string, to: string) => (out.get(from) ?? []).some((e) => e.to === to)
  const base = (id: string) => id.split('@')[0]!
  for (const row of rows) {
    const { traffic, services, workloads, pods, config } = row.cards
    for (const t of traffic) for (const s of services) if (has(t.id, s.id)) line(t.id, s.id)
    const anchor = workloads[0] ?? pods[0]
    if (anchor) {
      for (const s of services) line(s.id, anchor.id)
      for (const p of workloads.length ? pods : []) line(anchor.id, p.id)
      // What's used or mounted, from the pods that use it (next to it), else the workload.
      for (const c of config) {
        const by = pods.find((n) => has(base(n.id), c.id)) ?? pods[0] ?? anchor
        line(by.id, c.id, true)
      }
    }
  }
  return [...lines.values()]
}

/** How many cards a band draws: past about 400 on the page, pods are counted on their workloads. */
export const cardsIn = (band: Band) =>
  band.rows.reduce((sum, row) => sum + COLUMNS.reduce((s, c) => s + row.cards[c].length, 0), 0)

/** Whether a node's health is unwell (what never folds). */
export const unwell = (node: MapNode) => {
  const health = healthOf(node)
  return health === 'critical' || health === 'warning'
}

/** A gateway routes to routes, not to services: left out of the columns. */
export const NOT_DRAWN = new Set<string>([GATEWAY])

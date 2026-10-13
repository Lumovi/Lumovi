/**
 * The kit's parts, each with the cases that break it first: a page of the tests' build alone
 * (App.tsx), where a part can be seen, tested and measured before anything in Lumovi draws a
 * plugin's page from it. A release build has none of this.
 */
import { useState } from 'react'
import { useParams } from 'react-router'
import type { Health } from '@shared/health'
import { handedFields, wrongWithFields, type WrittenProps } from '@shared/kit/declare'
import { graph, type GraphProps } from '@shared/kit/graph'
import { table, tableProblem, type ObjectRef, type TableProps } from '@shared/kit/table'
import { Graph } from './Graph'
import { KIT_SWAP, token } from './handing'
import { KitFrame } from './KitFrame'
import { KitShown } from './KitShown'
import { Table } from './Table'

/** What a release build is checked not to hold (tests/integration/release-build.spec.ts). */
export const KIT_PAGE = 'lumovi-kit-page'

/** A table as a plugin writes it: its texts as text, an object as the token Lumovi gave it. */
type Written = WrittenProps<typeof table>
type WrittenRow = NonNullable<Written['rows']>[number]
type WrittenInnerRow = NonNullable<WrittenRow['rows']>[number]

/** A table as the door hands it to the Table: every text a `Their`, every token its object. */
const handed = (written: Written) => handedFields(written, table.props, KIT_SWAP) as TableProps

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const ahead = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString()

const NODE_POOLS: Written = {
  title: 'Node pools',
  headings: false,
  columns: [
    { name: 'Nodes', kind: 'number', width: 'narrow' },
    { name: 'CPU', kind: 'meter' },
    { name: 'Status', kind: 'status' },
    { name: 'Age', kind: 'age', width: 'text' },
  ],
  rows: [
    {
      key: 'general',
      lead: { level: 'healthy', name: 'general', under: 'On demand and spot · amd64, arm64' },
      cells: [
        { kind: 'number', value: 7, text: '7 nodes' },
        { kind: 'meter', label: 'CPU', used: 24, of: 64, text: '24 of 64 cores' },
        { kind: 'status', level: 'healthy', word: 'Ready' },
        { kind: 'age', time: ago(41 * 1440) },
      ],
    },
    {
      key: 'batch',
      lead: { level: 'warning', name: 'batch', under: 'Spot only · arm64' },
      cells: [
        { kind: 'number', value: 12, text: '12 nodes' },
        { kind: 'meter', label: 'CPU', used: 105, of: 128, text: '105 of 128 cores' },
        { kind: 'status', level: 'warning', word: 'Near its limit' },
        { kind: 'age', time: ago(9 * 1440) },
      ],
    },
    {
      key: 'gpu',
      lead: { name: 'gpu', under: 'No nodes yet' },
      cells: [
        { kind: 'number', value: 0, text: '0 nodes' },
        { kind: 'meter', label: 'CPU', used: 0, text: 'no limit' },
        { kind: 'status', level: 'neutral', word: 'Idle' },
        { kind: 'age', time: ago(120) },
      ],
    },
  ],
}

const certificate = (
  name: string,
  namespace: string,
  level: Health,
  word: string,
  renews: number | null,
  days: number,
): WrittenRow => ({
  key: `${namespace}/${name}`,
  lead: { level, name, beside: namespace },
  cells: [
    { kind: 'status', level, word },
    renews === null ? { kind: 'none' } : { kind: 'age', time: ahead(renews) },
    { kind: 'age', time: ago(days * 1440) },
  ],
  opens: token({ kind: 'Certificate.cert-manager.io', name, namespace }),
})

const CERTIFICATES: Written = {
  title: 'Certificates',
  headings: true,
  nameSorts: true,
  columns: [
    { name: 'Status', kind: 'status', sorts: true },
    { name: 'Renews', kind: 'age', width: 'narrow', sorts: true },
    { name: 'Age', kind: 'age', width: 'narrow', sorts: true },
  ],
  rows: [
    certificate('api-tls', 'platform', 'healthy', 'Ready', 61, 29),
    certificate('payments-tls', 'shop', 'critical', 'Failed', null, 88),
    certificate('grafana-tls', 'monitoring', 'healthy', 'Ready', 74, 16),
    certificate('storefront-tls', 'shop', 'warning', 'Expires soon', 3, 87),
  ],
}

const resource = (
  name: string,
  kind: string,
  level: Health,
  sync: string,
  health: string,
): WrittenInnerRow => ({
  key: `${kind}/${name}`,
  lead: { level, name, under: kind },
  cells: [
    sync ? { kind: 'text', text: sync } : { kind: 'none' },
    { kind: 'status', level, word: health },
  ],
})

const RESOURCES: Written = {
  title: 'Resources',
  headings: true,
  shows: 5,
  columns: [
    { name: 'Sync', kind: 'text' },
    { name: 'Health', kind: 'status' },
  ],
  rows: [
    {
      ...resource('storefront', 'Deployment', 'healthy', 'Synced', 'Healthy'),
      group: 'Workloads',
      rows: [resource('storefront-7d9f8c6b5-2xk4p', 'Pod', 'healthy', '', 'Running')],
    },
    {
      ...resource('checkout', 'Deployment', 'healthy', 'Synced', 'Healthy'),
      group: 'Workloads',
      rows: [resource('checkout-5b6c7d8e9-q8w7z', 'Pod', 'healthy', '', 'Running')],
    },
    {
      ...resource('cart', 'Deployment', 'critical', 'Out of sync', 'Degraded'),
      group: 'Workloads',
      rows: [
        resource('cart-6c9d7f5b44-8xk2p', 'Pod', 'healthy', '', 'Running'),
        resource('cart-6c9d7f5b44-w4nq7', 'Pod', 'critical', '', 'CrashLoopBackOff'),
      ],
    },
    { ...resource('storefront', 'Service', 'healthy', 'Synced', 'Healthy'), group: 'Network' },
    {
      ...resource('shop-old', 'Ingress', 'neutral', 'Not in the repository', 'Unknown'),
      group: 'Network',
    },
    ...Array.from({ length: 18 }, (_, i) => ({
      ...resource(`route-${i + 1}`, 'HTTPRoute', 'healthy', 'Synced', 'Healthy'),
      group: 'Network',
    })),
  ],
}

/** Tables that can't be drawn as they're described, each wrong in one way: what's said of each. */
const REFUSED: Written[] = [
  { ...RESOURCES, rows: [RESOURCES.rows![0]!, RESOURCES.rows![0]!] },
  {
    ...RESOURCES,
    rows: [
      {
        ...RESOURCES.rows![2]!,
        rows: [RESOURCES.rows![2]!.rows![0]!, RESOURCES.rows![2]!.rows![0]!],
      },
    ],
  },
  { ...RESOURCES, rows: [{ ...RESOURCES.rows![3]!, cells: [{ kind: 'none' }] }] },
  {
    ...RESOURCES,
    rows: [{ ...RESOURCES.rows![3]!, cells: [{ kind: 'number', value: 1 }, { kind: 'none' }] }],
  },
  { ...RESOURCES, rows: [{ ...RESOURCES.rows![3]!, rest: { from: 2, text: 'Nowhere' } }] },
  { ...RESOURCES, rows: [{ ...RESOURCES.rows![3]!, rest: { from: -1, text: 'Nowhere' } }] },
  // (A kind that isn't one: said so, and never looked up as if it were.)
  {
    ...RESOURCES,
    rows: [
      {
        ...RESOURCES.rows![3]!,
        cells: [{ kind: 'constructor' } as never, { kind: 'none' }],
      },
    ],
  },
  {
    ...RESOURCES,
    rows: [
      RESOURCES.rows![0]!,
      {
        ...RESOURCES.rows![2]!,
        rows: [
          RESOURCES.rows![2]!.rows![0]!,
          { ...RESOURCES.rows![2]!.rows![1]!, cells: [{ kind: 'none' }] },
        ],
      },
    ],
  },
]

const NODES: Written = {
  title: 'Nodes',
  headings: false,
  columns: [
    { name: 'CPU', kind: 'meter', width: 'narrow' },
    { name: 'Memory', kind: 'meter', width: 'narrow' },
  ],
  rows: [
    {
      key: 'long',
      lead: {
        level: 'healthy',
        name: 'worker-eu-west-1a-m6i-2xlarge-on-demand-7f3a9c2d-b1e4-1c9aa7',
        under: 'm6i.2xlarge · on demand · eu-west-1a',
      },
      cells: [
        { kind: 'meter', label: 'CPU', used: 62, of: 100, text: '62%' },
        { kind: 'meter', label: 'Memory', used: 81, of: 100, text: '81%' },
      ],
    },
    {
      key: 'short',
      lead: { level: 'healthy', name: 'worker-2', under: 'c7g.xlarge · spot · eu-west-1b' },
      cells: [{ kind: 'none' }, { kind: 'none' }],
      rest: { from: 0, text: 'Ready · 4 cores' },
    },
    {
      key: 'launching',
      lead: { level: 'progressing', name: 'worker-3', under: 'c7g.xlarge · spot · eu-west-1c' },
      cells: [{ kind: 'none' }, { kind: 'none' }],
      // (Its age is Lumovi's to say, after the words.)
      rest: { from: 0, text: 'Launching', time: ago(3) },
    },
    {
      key: 'right-to-left',
      lead: { level: 'healthy', name: 'worker-4', under: 'c7g.large · spot · il-central-1a' },
      cells: [{ kind: 'none' }, { kind: 'none' }],
      // (Written right to left, with a number and its unit in it: read as written, one text.)
      rest: { from: 0, text: 'מוכן · 4 ליבות' },
    },
  ],
}

/**
 * Columns that sort by what they hold: a number, a meter by how full it is, a text; a cell with
 * nothing is last either way. Its rows open nothing.
 */
const SPARES: Written = {
  title: 'Spare parts',
  headings: true,
  nameSorts: true,
  columns: [
    { name: 'Count', kind: 'number', width: 'narrow', sorts: true },
    { name: 'Used', kind: 'meter', sorts: true },
    { name: 'Shelf', kind: 'text', sorts: true },
  ],
  rows: (
    [
      ['bolt', 40, [10, 40], 'B'],
      ['nut', 5, [4, 5], 'A'],
      ['gear', undefined, [1, undefined], undefined],
      ['axle', 12, [6, 12], 'C'],
    ] as const
  ).map(([name, count, [used, of], shelf]) => ({
    key: name,
    lead: { name },
    cells: [
      count === undefined ? { kind: 'none' } : { kind: 'number', value: count, text: `${count}` },
      {
        kind: 'meter',
        label: 'Used',
        used,
        ...(of === undefined ? {} : { of }),
        text: of === undefined ? 'no limit' : `${used} of ${of}`,
      },
      shelf === undefined ? { kind: 'none' } : { kind: 'text', text: shelf },
    ],
  })),
}

/** A list with no groups that shows its first two, the rest behind its one "Show all". */
const CLAIMS: Written = {
  title: 'Node claims',
  headings: false,
  columns: [],
  rows: ['claim-a', 'claim-b', 'claim-c', 'claim-d'].map((name) => ({
    key: name,
    lead: { name },
    cells: [],
  })),
  shows: 2,
}

/** From a read cut at Lumovi's limit, of a whole the cluster counted: Lumovi says so. */
const UNSCHEDULED: Written = {
  title: 'Not yet scheduled',
  headings: false,
  columns: [{ name: 'Waiting', kind: 'age', width: 'text' }],
  rows: [
    {
      key: 'a',
      lead: { level: 'warning', name: 'reports-7f9c' },
      cells: [{ kind: 'age', time: ago(9) }],
    },
  ],
  cut: 'cut-unscheduled',
}

const WAITING: Written = {
  title: 'Waiting for a node',
  headings: false,
  columns: [{ name: 'Waiting', kind: 'age', width: 'text' }],
  rows: [
    {
      key: 'a',
      lead: {
        level: 'warning',
        name: 'checkout-payments-reconciliation-worker-5d8f7c6b9-x2kqp',
        beside: 'shop',
      },
      cells: [{ kind: 'age', time: ago(11) }],
      note: '0/9 nodes are available: 3 Insufficient memory, 6 node(s) didn’t match Pod’s node affinity/selector. preemption: 0/9 nodes are available: 9 No preemption victims found for incoming pod. It has waited since its Deployment was scaled, and nothing has changed for it in that time.',
      opens: token({
        kind: 'Pod',
        name: 'checkout-payments-reconciliation-worker-5d8f7c6b9-x2kqp',
        namespace: 'shop',
      }),
    },
    {
      key: 'b',
      lead: { level: 'warning', name: 'reports-nightly-28931', beside: 'data' },
      // (One cell more than there are columns: drawn by its columns all the same.)
      cells: [
        { kind: 'age', time: ago(2) },
        { kind: 'text', text: 'one cell too many' },
      ],
      note: '0/9 nodes are available: 9 Insufficient cpu.',
    },
  ],
}

/**
 * Texts that aren't Lumovi's, each holding what can't be seen or would act, as design's frame
 * has them: a letter that draws as nothing, a mark that turns text round, marks in the part of
 * a long name that's cut, a name written right to left, a run of marks, and a heading with one.
 * (Written by their code points: none is in this file as itself.)
 */
const application = (
  name: string,
  namespace: string,
  level: Health,
  stage: string,
  image: string,
): WrittenRow => ({
  key: `${namespace}/${name}`,
  lead: { level, name, beside: namespace },
  cells: [{ kind: 'text', text: stage }, image ? { kind: 'text', text: image } : { kind: 'none' }],
})

const MARKS: Written = {
  title: 'Applications',
  headings: true,
  nameSorts: true,
  columns: [
    { name: 'Sta\u180ege', kind: 'text', sorts: true },
    { name: 'Image', kind: 'text', width: 'wide' },
  ],
  rows: [
    application('cart\u3164-api', 'shop', 'healthy', 'Ready', 'ghcr.io/acme/cart:v2.3.1'),
    application(
      'invoice-\u202efdp.exe',
      'billing',
      'warning',
      'Syncing',
      'ghcr.io/acme/\u202egpj.exe:1.0',
    ),
    application(
      'platform-observability-shared-infrastructure-\u3164\u180eeu-west',
      'monitoring',
      'healthy',
      'Ready',
      'quay.io/team/collector:0.98.0',
    ),
    application(
      '\u0637\u0644\u0628\u0627\u062a-\u0627\u0644\u062f\u0641\u0639',
      'payments',
      'healthy',
      '\u062c\u0627\u0647\u0632',
      'ghcr.io/acme/payments:3.1.0',
    ),
    application(`spam${'\u3164'.repeat(120)}`, 'shop', 'critical', 'Failed', ''),
  ],
}

const nothing = (title: string, state: Written['state']): Written => ({
  title,
  headings: true,
  columns: CERTIFICATES.columns,
  rows: [],
  state,
})

/** Thousands, every one of them a row like any other: what the long list is measured with. */
const many = (count: number, tick: number, grouped = false): Written => ({
  title: 'Pods',
  // (In groups, many enough to be drawn as they're scrolled to, each its own "Show all".)
  ...(grouped ? { shows: 150 } : {}),
  headings: true,
  columns: [
    { name: 'Status', kind: 'status', sorts: true },
    { name: 'Restarts', kind: 'number', width: 'narrow', sorts: true },
    { name: 'Age', kind: 'age', width: 'text', sorts: true },
  ],
  rows: Array.from({ length: count }, (_, i) => {
    const failing = (i + tick) % 37 === 0
    return {
      key: `pod-${i}`,
      ...(grouped ? { group: `team-${Math.floor(i / 500)}` } : {}),
      lead: {
        level: failing ? 'critical' : 'healthy',
        name: `storefront-${String(i).padStart(4, '0')}-7d9f8c6b5-${(i * 7919).toString(36)}`,
        beside: `team-${i % 12}`,
      },
      cells: [
        {
          kind: 'status',
          level: failing ? 'critical' : 'healthy',
          word: failing ? 'CrashLoopBackOff' : 'Running',
        },
        { kind: 'number', value: (i + tick) % 9 },
        { kind: 'age', time: ago(i + 1) },
      ],
    } satisfies WrittenRow
  }),
})

/** A graph as a plugin writes it, and as the door hands it to the Graph. */
type WrittenGraph = WrittenProps<typeof graph>
type WrittenNode = NonNullable<WrittenGraph['nodes']>[number]
const handedGraph = (written: WrittenGraph) =>
  handedFields(written, graph.props, KIT_SWAP) as GraphProps

/** A card of an application's resources: a Sync column and a Health column, as in the frame. */
const resourceCard = (
  key: string,
  kind: string,
  name: string,
  icon: WrittenNode['icon'],
  status?: [Health, string],
  sync?: string,
  opens?: ObjectRef,
): WrittenNode => ({
  key,
  name,
  kind,
  ...(icon && !opens && { icon }),
  ...(status && { status: { level: status[0], word: status[1] } }),
  cells: [
    sync ? { kind: 'text', text: sync } : { kind: 'none' },
    status ? { kind: 'status', level: status[0], word: status[1] } : { kind: 'none' },
  ],
  ...(opens && { opens: token(opens) }),
})

/** The app's map, grown: an application, its workloads and their pods, and one shared ConfigMap. */
const APPLICATION: WrittenGraph = {
  title: 'Resources of shop',
  legend: { solid: 'Owns', dashed: 'Uses' },
  columns: [
    { name: 'Sync', kind: 'text' },
    { name: 'Health', kind: 'status' },
  ],
  nodes: [
    {
      ...resourceCard(
        'app',
        'Application',
        'shop',
        'git-branch',
        ['critical', 'Degraded'],
        '4f1c9aa',
      ),
      beside: '4f1c9aa',
    },
    resourceCard('d1', 'Deployment', 'storefront', 'layers', ['healthy', 'Healthy'], 'Synced', {
      kind: 'Deployment',
      name: 'storefront',
      namespace: 'shop',
    }),
    resourceCard('d2', 'Deployment', 'cart', 'layers', ['critical', 'Degraded'], 'Out of sync', {
      kind: 'Deployment',
      name: 'cart',
      namespace: 'shop',
    }),
    resourceCard('svc', 'Service', 'storefront', 'server', ['healthy', 'Healthy'], 'Synced'),
    resourceCard('ing', 'Ingress', 'shop', 'globe', ['healthy', 'Healthy'], 'Synced'),
    resourceCard('p1', 'Pod', 'storefront-7d9f6c5b8-x2kqp', 'box', ['healthy', 'Running']),
    resourceCard('p2', 'Pod', 'cart-6c9d7f5b44-8xk2p', 'box', ['healthy', 'Running']),
    resourceCard('p3', 'Pod', 'cart-6c9d7f5b44-w4nq7', 'box', ['critical', 'CrashLoopBackOff']),
    resourceCard('cm', 'ConfigMap', 'cart-config', 'file-check'),
  ],
  edges: [
    { from: 'app', to: 'd1' },
    { from: 'app', to: 'd2' },
    { from: 'app', to: 'svc' },
    { from: 'app', to: 'ing' },
    { from: 'd1', to: 'p1' },
    { from: 'd2', to: 'p2' },
    { from: 'd2', to: 'p3' },
    { from: 'd2', to: 'cm', style: 'dashed', label: 'mounts' },
    { from: 'd1', to: 'cm', style: 'dashed' },
  ],
}

/** A workflow whose failed test sends it back to the build: a loop, and the longest name. */
const STEPS: WrittenGraph = {
  title: 'Steps',
  columns: [],
  nodes: (
    [
      ['checkout', 'healthy', 'Succeeded'],
      ['build-and-push-the-image-for-every-architecture', 'healthy', 'Succeeded'],
      ['integration-tests', 'critical', 'Failed'],
      ['deploy', 'neutral', 'Skipped'],
    ] as const
  ).map(([name, level, word], i) => ({
    key: `step-${i + 1}`,
    name,
    kind: 'Step',
    beside: `${i + 1} of 4`,
    icon: 'play' as const,
    status: { level, word },
    cells: [],
  })),
  edges: [
    { from: 'step-1', to: 'step-2' },
    { from: 'step-2', to: 'step-3' },
    { from: 'step-3', to: 'step-4' },
    { from: 'step-3', to: 'step-2', label: 'retried after a failed test' },
  ],
}

/** Five services into one database, and more of its pods than a row holds. */
const ORDERS_DB: WrittenGraph = {
  title: 'What uses orders-db',
  legend: { dashed: 'Reads and writes' },
  columns: [],
  nodes: [
    ...['gateway', 'storefront', 'cart', 'checkout', 'reports'].map((name) => ({
      key: `svc-${name}`,
      name,
      kind: 'Service',
      icon: 'server' as const,
      status: { level: 'healthy' as const, word: 'Healthy' },
      cells: [],
    })),
    {
      key: 'db',
      name: 'orders-db',
      kind: 'Cluster',
      beside: '17 pods',
      icon: 'database',
      status: { level: 'warning', word: 'Not all ready' },
      cells: [],
    },
    ...Array.from({ length: 17 }, (_, i) => ({
      key: `pod-${i + 1}`,
      name: `orders-db-${i + 1}`,
      kind: 'Pod',
      icon: 'box' as const,
      status:
        i === 2
          ? { level: 'critical' as const, word: 'CrashLoopBackOff' }
          : { level: 'healthy' as const, word: 'Running' },
      cells: [],
    })),
  ],
  edges: [
    ...['gateway', 'storefront', 'cart', 'checkout', 'reports'].map((name) => ({
      from: `svc-${name}`,
      to: 'db',
      style: 'dashed' as const,
      label: 'reads and writes',
    })),
    ...Array.from({ length: 17 }, (_, i) => ({ from: 'db', to: `pod-${i + 1}` })),
  ],
}

/**
 * Names and lines' labels holding marks, by the kit's rule: in place, never cut away. And a name
 * whose letters, lowered, are more of them: its first is a capital I with a dot.
 */
const MARKED_NAMES: WrittenGraph = {
  title: 'Resources with marks',
  columns: [],
  nodes: [
    'cart\u202Eipa',
    'payments-eu-\u3164\u180Eu-west',
    `spam${'\u3164'.repeat(40)}`,
    '\u0130zmir-gateway',
  ].map((name, i) => ({
    key: `marked-${i + 1}`,
    name,
    kind: 'Deployment',
    icon: 'layers' as const,
    cells: [],
  })),
  edges: [
    { from: 'marked-1', to: 'marked-2', label: 'calls\u3164it' },
    // (Sixteen letters, then a mark: past what a label shows.)
    { from: 'marked-1', to: 'marked-4', label: 'sixteen-letters!\u3164 and more' },
  ],
}

/** As many cards as past the ceiling: listed, and saying why. */
/** Forty cards, each linked to every one after it: few enough cards, far too many links. */
const TANGLE: WrittenGraph = {
  title: 'Who talks to whom',
  columns: [],
  nodes: Array.from({ length: 40 }, (_, i) => ({
    key: `s-${i}`,
    name: `service-${String(i).padStart(2, '0')}`,
    kind: 'Service',
    cells: [],
  })),
  edges: Array.from({ length: 40 }, (_, i) =>
    Array.from({ length: 39 - i }, (_, j) => ({ from: `s-${i}`, to: `s-${i + j + 1}` })),
  ).flat(),
}

const tooMany = (count: number): WrittenGraph => ({
  title: 'Every resource',
  columns: [{ name: 'Health', kind: 'status' }],
  nodes: Array.from({ length: count }, (_, i) => ({
    key: `r-${i}`,
    name: `resource-${String(i).padStart(3, '0')}`,
    kind: i % 3 ? 'Pod' : 'Deployment',
    cells: [{ kind: 'status', level: 'healthy', word: 'Healthy' }],
  })),
  edges: Array.from({ length: count - 1 }, (_, i) => ({
    from: `r-${Math.floor(i / 3) * 3}`,
    to: `r-${i + 1}`,
  })).filter((edge) => edge.from !== edge.to),
})

/**
 * As many cards as a graph may have (`GRAPH_LIMITS.cards`), in a chain each card deep in the one
 * before; or, `loops`, each leading to the next two and every tenth back up, circles everywhere.
 */
const deep = (loops: boolean): WrittenGraph => ({
  title: loops ? 'Cards in loops' : 'A long chain',
  columns: [],
  nodes: Array.from({ length: 5_000 }, (_, i) => ({ key: `k${i}`, name: `card ${i}`, cells: [] })),
  edges: Array.from({ length: 5_000 }, (_, i) =>
    (loops ? (i % 10 === 9 ? [i + 1, i - 9] : [i + 1, i + 2]) : [i + 1])
      .filter((to) => to < 5_000)
      .map((to) => ({ from: `k${i}`, to: `k${to}` })),
  ).flat(),
})

/** The kit's parts: the Table's cases, (`kit/frame`) a page's frame, or (`kit/shown`) what's shown by reference. */
export function KitPage() {
  const { part } = useParams()
  return (
    <div id={KIT_PAGE} className="h-full overflow-y-auto">
      {part === 'frame' ? <KitFrame /> : part === 'shown' ? <KitShown /> : <Tables />}
    </div>
  )
}

function Tables() {
  const [events, setEvents] = useState<string[]>([])
  const [rows, setRows] = useState(0)
  const [grouped, setGrouped] = useState(false)
  const [cards, setCards] = useState(0)
  const [big, setBig] = useState<'chain' | 'loops'>()
  // What a plugin would be told: a text as text, as the door sends it down.
  const said = (table: string, what: string) => (carries: object) =>
    setEvents((was) => [
      ...was,
      `${table}: ${what} ${JSON.stringify(carries, (_, value: unknown) =>
        value !== null && typeof value === 'object' && 'their' in value ? value.their : value,
      )}`,
    ])
  return (
    <>
      <div className="grid grid-cols-2 items-start gap-x-8 gap-y-7 p-8 phone:grid-cols-1 phone:gap-y-6 phone:p-4">
        <Table {...handed(NODE_POOLS)} />
        <Table
          {...handed(CERTIFICATES)}
          go={said('Certificates', 'go')}
          onOpen={said('Certificates', 'open')}
        />
        <Table {...handed(RESOURCES)} />
        <div className="grid min-w-0 grid-cols-1 gap-4">
          <Table {...handed(NODES)} />
          <Table
            {...handed({ ...WAITING, cut: 'cut-waiting' })}
            onOpen={said('Waiting for a node', 'open')}
          />
          <Table {...handed(UNSCHEDULED)} />
          <Table {...handed(SPARES)} onOpen={said('Spare parts', 'open')} />
          <Table {...handed(CLAIMS)} />
          {/* A cut token this page holds no read for: nothing is said. */}
          <Table {...handed({ ...UNSCHEDULED, title: 'Not cut', cut: 'made-up' })} />
        </div>
        <Table {...handed(nothing('Loading certificates', { is: 'busy' }))} />
        <Table
          {...handed(
            nothing('Forbidden certificates', {
              is: 'failed',
              title: 'Couldn’t list certificates',
              said: 'certificates.cert-manager.io is forbidden for jane@example.com in shop.',
            }),
          )}
          onRetry={said('Forbidden certificates', 'retry')}
        />
        <Table
          {...handed(
            nothing('No certificates', {
              is: 'empty',
              title: 'No certificates',
              line: 'Nothing in shop matches “tls-old”.',
            }),
          )}
        />
        <Table
          {...handed(
            nothing('Nothing waiting', {
              is: 'quiet',
              line: 'No pods are waiting for a node.',
              good: true,
            }),
          )}
        />
        {/* (The whole width, as design's frame has it: names with room to show their marks.) */}
        <div className="col-span-full">
          <Table {...handed(MARKS)} />
        </div>
        <div className="col-span-full">
          <button
            type="button"
            onClick={() => setRows(rows ? 0 : 2500)}
            className="mb-3 text-xs text-ink-3 underline phone:flex phone:h-11 phone:items-center"
          >
            {rows ? 'Without the long list' : 'With 2,500 rows'}
          </button>
          {rows > 0 && <Table {...handed(many(rows, 0))} />}
        </div>
        <div className="col-span-full">
          <button
            type="button"
            onClick={() => setGrouped(!grouped)}
            className="mb-3 text-xs text-ink-3 underline phone:flex phone:h-11 phone:items-center"
          >
            {grouped ? 'Without the grouped list' : 'With 2,500 rows in groups'}
          </button>
          {grouped && <Table {...handed({ ...many(2500, 0, true), title: 'Pods by team' })} />}
        </div>
      </div>
      <div className="grid grid-cols-1 items-start gap-y-7 px-8 pb-8 phone:gap-y-6 phone:px-4">
        <Graph
          {...handedGraph(APPLICATION)}
          go={said('Resources of shop', 'go')}
          onOpen={said('Resources of shop', 'open')}
        />
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-start gap-x-8 phone:grid-cols-1 phone:gap-y-6">
          <Graph {...handedGraph(STEPS)} onOpen={said('Steps', 'open')} />
          <Graph {...handedGraph(ORDERS_DB)} />
        </div>
        <div className="grid grid-cols-2 items-start gap-x-8 phone:grid-cols-1 phone:gap-y-6">
          <Graph
            {...handedGraph({
              title: 'Resources of storefront',
              columns: [],
              nodes: [],
              edges: [],
              state: {
                is: 'empty',
                title: 'Nothing to show',
                line: 'storefront has no resources yet.',
              },
            })}
          />
        </div>
        {/* (The whole width: its three cards on one row, their names with room for their marks.) */}
        <Graph {...handedGraph(MARKED_NAMES)} />
        <Graph {...handedGraph(TANGLE)} />
        <Graph
          {...handedGraph({
            title: 'Reading the steps',
            columns: [],
            nodes: [],
            edges: [],
            state: { is: 'busy' },
          })}
        />
        <div>
          <button
            type="button"
            onClick={() => setCards(cards ? 0 : 412)}
            className="mb-3 text-xs text-ink-3 underline phone:flex phone:h-11 phone:items-center"
          >
            {cards ? 'Without the many cards' : 'With 412 cards'}
          </button>
          {cards > 0 && <Graph {...handedGraph(tooMany(cards))} />}
        </div>
        <div>
          {(['chain', 'loops'] as const).map((which) => (
            <button
              key={which}
              type="button"
              onClick={() => setBig(big === which ? undefined : which)}
              className="mr-4 mb-3 text-xs text-ink-3 underline phone:flex phone:h-11 phone:items-center"
            >
              {which === 'chain' ? 'With a chain of 5,000 cards' : 'With 5,000 cards in loops'}
            </button>
          ))}
          {big && <Graph key={big} {...handedGraph(deep(big === 'loops'))} />}
        </div>
      </div>
      <ul
        aria-label="What a table is refused for"
        className="px-8 pb-4 text-xs text-ink-3 phone:px-4"
      >
        {[CERTIFICATES, RESOURCES, ...REFUSED].map((written, i) => (
          <li key={i}>
            {/* (As the door checks one: its kinds first, then what they can't say.) */}
            {wrongWithFields(written, table.props, table.required, 'Table') ??
              tableProblem(written) ??
              'Nothing: it can be drawn.'}
          </li>
        ))}
      </ul>
      <ol
        aria-label="What was pressed"
        className="px-8 pb-8 font-mono text-xs text-ink-3 phone:px-4"
      >
        {events.map((event, i) => (
          <li key={i}>{event}</li>
        ))}
      </ol>
    </>
  )
}

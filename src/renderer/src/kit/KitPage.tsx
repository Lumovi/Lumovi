/**
 * The kit's parts, each with the cases that break it first: a page of the tests' build alone
 * (App.tsx), where a part can be seen, tested and measured before anything in Lumovi draws a
 * plugin's page from it. A release build has none of this.
 */
import { useState } from 'react'
import { useParams } from 'react-router'
import type { Health } from '@shared/health'
import {
  tableProblem,
  type Table as TableSaid,
  type TableInnerRow,
  type TableRow,
} from '@shared/kit/table'
import { KitFrame } from './KitFrame'
import { KitShown } from './KitShown'
import { Table } from './Table'

/** What a release build is checked not to hold (tests/integration/release-build.spec.ts). */
export const KIT_PAGE = 'lumovi-kit-page'

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const ahead = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString()

const NODE_POOLS: TableSaid = {
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
): TableRow => ({
  key: `${namespace}/${name}`,
  lead: { level, name, beside: namespace },
  cells: [
    { kind: 'status', level, word },
    renews === null ? { kind: 'none' } : { kind: 'age', time: ahead(renews) },
    { kind: 'age', time: ago(days * 1440) },
  ],
  opens: { kind: 'Certificate.cert-manager.io', name, namespace },
})

const CERTIFICATES: TableSaid = {
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
): TableInnerRow => ({
  key: `${kind}/${name}`,
  lead: { level, name, under: kind },
  cells: [
    sync ? { kind: 'text', text: sync } : { kind: 'none' },
    { kind: 'status', level, word: health },
  ],
})

const RESOURCES: TableSaid = {
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
const REFUSED: TableSaid[] = [
  { ...RESOURCES, rows: [RESOURCES.rows[0]!, RESOURCES.rows[0]!] },
  {
    ...RESOURCES,
    rows: [
      { ...RESOURCES.rows[2]!, rows: [RESOURCES.rows[2]!.rows![0]!, RESOURCES.rows[2]!.rows![0]!] },
    ],
  },
  { ...RESOURCES, rows: [{ ...RESOURCES.rows[3]!, cells: [{ kind: 'none' }] }] },
  {
    ...RESOURCES,
    rows: [{ ...RESOURCES.rows[3]!, cells: [{ kind: 'number', value: 1 }, { kind: 'none' }] }],
  },
  { ...RESOURCES, rows: [{ ...RESOURCES.rows[3]!, rest: { from: 2, text: 'Nowhere' } }] },
  { ...RESOURCES, rows: [{ ...RESOURCES.rows[3]!, rest: { from: -1, text: 'Nowhere' } }] },
  // (A kind that isn't one: said so, and never looked up as if it were.)
  {
    ...RESOURCES,
    rows: [
      {
        ...RESOURCES.rows[3]!,
        cells: [{ kind: 'constructor' } as never, { kind: 'none' }],
      },
    ],
  },
  {
    ...RESOURCES,
    rows: [
      RESOURCES.rows[0]!,
      {
        ...RESOURCES.rows[2]!,
        rows: [
          RESOURCES.rows[2]!.rows![0]!,
          { ...RESOURCES.rows[2]!.rows![1]!, cells: [{ kind: 'none' }] },
        ],
      },
    ],
  },
]

const NODES: TableSaid = {
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
  ],
}

const WAITING: TableSaid = {
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
      opens: {
        kind: 'Pod',
        name: 'checkout-payments-reconciliation-worker-5d8f7c6b9-x2kqp',
        namespace: 'shop',
      },
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

const nothing = (title: string, state: TableSaid['state']): TableSaid => ({
  title,
  headings: true,
  columns: CERTIFICATES.columns,
  rows: [],
  state,
})

/** Thousands, every one of them a row like any other: what the long list is measured with. */
const many = (count: number, tick: number): TableSaid => ({
  title: 'Pods',
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
    } satisfies TableRow
  }),
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
  const said = (table: string, what: string) => (carries: object) =>
    setEvents((was) => [...was, `${table}: ${what} ${JSON.stringify(carries)}`])
  return (
    <>
      <div className="grid grid-cols-2 items-start gap-x-8 gap-y-7 p-8 phone:grid-cols-1 phone:gap-y-6 phone:p-4">
        <Table table={NODE_POOLS} />
        <Table
          table={CERTIFICATES}
          go={said('Certificates', 'go')}
          onOpen={said('Certificates', 'open')}
        />
        <Table table={RESOURCES} />
        <div className="grid min-w-0 grid-cols-1 gap-4">
          <Table table={NODES} />
          <Table table={WAITING} onOpen={said('Waiting for a node', 'open')} />
        </div>
        <Table table={nothing('Loading certificates', { is: 'busy' })} />
        <Table
          table={nothing('Forbidden certificates', {
            is: 'failed',
            title: 'Couldn’t list certificates',
            said: 'certificates.cert-manager.io is forbidden for jane@example.com in shop.',
          })}
          onRetry={said('Forbidden certificates', 'retry')}
        />
        <Table
          table={nothing('No certificates', {
            is: 'empty',
            title: 'No certificates',
            line: 'Nothing in shop matches “tls-old”.',
          })}
        />
        <Table
          table={nothing('Nothing waiting', {
            is: 'quiet',
            line: 'No pods are waiting for a node.',
            good: true,
          })}
        />
        <div className="col-span-full">
          <button
            type="button"
            onClick={() => setRows(rows ? 0 : 2500)}
            className="mb-3 text-xs text-ink-3 underline phone:flex phone:h-11 phone:items-center"
          >
            {rows ? 'Without the long list' : 'With 2,500 rows'}
          </button>
          {rows > 0 && <Table table={many(rows, 0)} />}
        </div>
      </div>
      <ul
        aria-label="What a table is refused for"
        className="px-8 pb-4 text-xs text-ink-3 phone:px-4"
      >
        {[CERTIFICATES, RESOURCES, ...REFUSED].map((table, i) => (
          <li key={i}>{tableProblem(table) ?? 'Nothing: it can be drawn.'}</li>
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

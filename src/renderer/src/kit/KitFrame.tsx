/**
 * A page's frame with the cases that break it first: the pick list, the header, tiles and the
 * three arrangements, on the tests' build's page for the kit's parts (KitPage.tsx).
 */
import { useState } from 'react'
import type { Health } from '@shared/health'
import {
  headerProblem,
  pickListProblem,
  tilesProblem,
  type Header,
  type HeaderButton,
  type Pick,
  type PickList,
  type Tile,
} from '@shared/kit/page'
import type { Table as TableSaid } from '@shared/kit/table'
import { Split, Stack, Tiles } from './Arrangements'
import { PageHeader } from './PageHeader'
import { Table } from './Table'

/** A name of 64 characters: longer than any side or header has room for. */
const LONGEST = 'checkout-payments-reconciliation-ledger-archive-eu-west1-main-db'

const cluster = (
  name: string,
  ready: number,
  of: number,
  namespace: string,
  level: Health,
  word: string,
): Pick => ({
  key: `${namespace}/${name}`,
  lead: { level, name, under: `${ready} of ${of} ready · ${namespace}` },
  status: { level, word },
})

const FEW: Pick[] = [
  cluster('payments-db', 3, 3, 'shop', 'healthy', 'Healthy'),
  cluster('orders-db', 2, 3, 'shop', 'warning', 'Not all ready'),
  cluster('reports-db', 1, 1, 'data', 'healthy', 'Healthy'),
  cluster('sessions-db', 1, 2, 'shop', 'progressing', 'Switching over'),
  cluster(LONGEST, 0, 3, 'shop', 'critical', 'Unrecoverable'),
]
const MANY: Pick[] = [
  ...FEW,
  ...Array.from({ length: 33 }, (_, i) =>
    cluster(`search-db-${String(i + 1).padStart(2, '0')}`, 3, 3, 'search', 'healthy', 'Healthy'),
  ),
]
const LISTS: Record<string, PickList> = {
  '38 clusters': { title: 'Clusters', rows: MANY },
  '5 clusters, as given': { title: 'Clusters', rows: FEW, asGiven: true, picked: 'shop/orders-db' },
  // (Its picked row is gone: the first is taken.)
  'One cluster': { title: 'Clusters', rows: [FEW[0]!], picked: 'shop/gone-db' },
  'No clusters': {
    title: 'Clusters',
    rows: [],
    state: { is: 'empty', title: 'No clusters', line: 'Nothing in demo has one yet.' },
  },
}

const BUTTONS: HeaderButton[] = [
  { key: 'logs', name: 'Show logs' },
  { key: 'hibernate', name: 'Hibernate', changes: true, asks: true },
  { key: 'restart', name: 'Restart', changes: true, asks: true },
  { key: 'switch', name: 'Switch over', changes: true, asks: true },
  { key: 'backup', name: 'Back up now', changes: true, asks: true },
]

/** The rest of the page for what's picked, as a plugin would describe it anew for each. */
function described(pick: Pick): { header: Header; tiles: Tile[]; instances: TableSaid } {
  const name = pick.lead.name
  const few = name === 'reports-db' ? 1 : name === 'orders-db' ? 3 : name === LONGEST ? 5 : 2
  return {
    header: { name, status: pick.status, buttons: BUTTONS.slice(-few) },
    tiles: [
      {
        key: 'ready',
        icon: 'server',
        label: 'Instances ready',
        value: { kind: 'figure', text: pick.lead.under!.slice(0, 1) + '/' + pick.lead.under![5] },
        detail:
          pick.status!.level === 'healthy'
            ? 'All ready'
            : `${Number(pick.lead.under![5]) - Number(pick.lead.under![0])} not ready`,
        level: pick.status!.level,
        opens: { kind: 'Pod', name: `${name}-1`, namespace: 'shop' },
      },
      {
        key: 'primary',
        icon: 'database',
        label: 'Primary',
        value: { kind: 'words', text: `${name}-1` },
        detail: 'since 12 days ago',
      },
      {
        key: 'backup',
        icon: 'timer',
        label: 'Last backup',
        value: { kind: 'figure', text: '3h' },
        detail: 'Completed',
        level: 'healthy',
      },
      { key: 'version', icon: 'layers', label: 'Version', value: { kind: 'figure', text: '17.2' } },
    ],
    instances: {
      title: 'Instances',
      headings: true,
      columns: [
        { name: 'Role', kind: 'text' },
        { name: 'Status', kind: 'status' },
      ],
      rows: [1, 2, 3].map((n) => ({
        key: `${n}`,
        lead: { level: 'healthy', name: `${name}-${n}` },
        cells: [
          { kind: 'text', text: n === 1 ? 'Primary' : 'Replica' },
          { kind: 'status', level: 'healthy', word: 'Ready' },
        ],
      })),
    },
  }
}

/** Tiles' own hard cases: words that don't fit, a long label, no line under, three and two. */
const HARD: Tile[][] = [
  [
    {
      key: 'a',
      icon: 'git-branch',
      label: 'Out of sync',
      value: { kind: 'figure', text: '2/5' },
      detail: '2 resources differ',
      level: 'warning',
    },
    {
      key: 'b',
      icon: 'git-branch',
      label: 'Revision',
      value: { kind: 'words', text: 'main at 4f1c9aa' },
      detail: 'platform/apps/shop',
    },
    { key: 'c', icon: 'timer', label: 'Auto-sync', value: { kind: 'words', text: 'Off' } },
  ],
  [
    {
      key: 'a',
      icon: 'gauge',
      label: 'Requests',
      value: { kind: 'figure', text: '1,234,567,890,123,456,789,012,345,678,901,234' },
      detail: 'a figure longer than its tile',
    },
    { key: 'b', icon: 'gauge', label: 'Errors', value: { kind: 'figure', text: '0' } },
  ],
  [
    {
      key: 'a',
      icon: 'package',
      label: 'Storage for each instance, of what its claim asked for when it was made',
      value: { kind: 'figure', text: '1.2 TiB' },
      detail: 'of 2 TiB, and the line under a value is cut at its end where it has no room',
    },
    {
      key: 'b',
      label: 'Primary',
      value: { kind: 'words', text: `${LONGEST}-1` },
      detail: 'since 12 days ago',
    },
  ],
]

/** Parts that can't be drawn as they're described, each wrong in one way. */
const REFUSED: (string | undefined)[] = [
  tilesProblem(HARD[0]!),
  tilesProblem([HARD[0]![0]!]),
  tilesProblem([...HARD[0]!, ...HARD[1]!]),
  tilesProblem([HARD[0]![0]!, HARD[0]![0]!]),
  tilesProblem([HARD[0]![1]!, HARD[0]![0]!, HARD[0]![0]!], 2),
  headerProblem({ name: 'a', buttons: BUTTONS }),
  headerProblem({ name: 'a' }),
  headerProblem({ name: 'a', buttons: [BUTTONS[0]!, BUTTONS[0]!] }),
  pickListProblem(LISTS['38 clusters']!),
  pickListProblem({ title: 'Clusters', rows: [FEW[0]!, FEW[0]!] }),
  // (Not refused: what was picked may be gone from the cluster, and the list takes its first.)
  pickListProblem({ title: 'Clusters', rows: FEW, picked: 'nowhere' }),
]

export function KitFrame() {
  const [which, setWhich] = useState('38 clusters')
  const [events, setEvents] = useState<string[]>([])
  // What the "plugin" last described the rest of the page for.
  const [picked, setPicked] = useState<string>()
  const said = (what: string) => (carries: object) =>
    setEvents((was) => [...was, `${what} ${JSON.stringify(carries)}`])
  const list = LISTS[which]!
  const pick =
    list.rows.find((row) => row.key === picked) ??
    list.rows.find((row) => row.key === list.picked) ??
    // (As the list stands: the worst first, here the longest name.)
    (list.asGiven ? list.rows[0] : list.rows.find((row) => row.status?.level === 'critical')) ??
    list.rows[0]
  const rest = pick && described(pick)
  return (
    <>
      <div className="flex flex-col gap-4 p-8 phone:p-4">
        <div role="group" aria-label="Which list" className="flex flex-wrap gap-x-4">
          {Object.keys(LISTS).map((name) => (
            <button
              key={name}
              type="button"
              aria-pressed={name === which}
              onClick={() => {
                setWhich(name)
                setPicked(undefined)
              }}
              className="text-xs text-ink-3 underline aria-pressed:text-ink-1 phone:flex phone:h-11 phone:items-center"
            >
              {name}
            </button>
          ))}
        </div>
        <Split
          key={which}
          list={list}
          onPick={(carries) => {
            setPicked(carries.row)
            said('pick')(carries)
          }}
        >
          {rest && (
            <>
              <PageHeader header={rest.header} onPress={said('press')} />
              <Tiles tiles={rest.tiles} go={said('go')} onOpen={said('open')} />
              <Table table={rest.instances} />
            </>
          )}
        </Split>
        <Stack>
          {HARD.map((tiles, i) => (
            <Tiles key={i} tiles={tiles} />
          ))}
        </Stack>
      </div>
      <ul
        aria-label="What a part is refused for"
        className="px-8 pb-4 text-xs text-ink-3 phone:px-4"
      >
        {REFUSED.map((problem, i) => (
          <li key={i}>{problem ?? 'Nothing: it can be drawn.'}</li>
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

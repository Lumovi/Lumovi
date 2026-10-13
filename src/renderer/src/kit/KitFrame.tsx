/**
 * A page's frame with the cases that break it first: the pick list, the header, tiles and the
 * three arrangements, on the tests' build's page for the kit's parts (KitPage.tsx).
 */
import { useState } from 'react'
import type { Health } from '@shared/health'
import { wrongWithFields, type Part, type WrittenProps } from '@shared/kit/declare'
import {
  card as cardPart,
  counts as countsPart,
  header as headerPart,
  pair as pairPart,
  split as splitPart,
  tiles as tilesPart,
  type WrittenCounts,
  type WrittenHeader,
  type WrittenPick,
  type WrittenPickList,
  type WrittenTiles,
} from '@shared/kit/page'
import { table, type WrittenTable } from '@shared/kit/table'
import { Pair, Split, Stack, Tiles } from './Arrangements'
import { Card } from './Card'
import { Counts } from './Counts'
import { handedAs } from './handing'
import { PageHeader } from './PageHeader'
import { Table } from './Table'

/** A header's button, and a tile, as a plugin writes them. */
type WrittenButton = NonNullable<WrittenHeader['buttons']>[number]
type WrittenTile = NonNullable<WrittenTiles['tiles']>[number]

/** A name of 64 characters: longer than any side or header has room for. */
const LONGEST = 'checkout-payments-reconciliation-ledger-archive-eu-west1-main-db'

const cluster = (
  name: string,
  ready: number,
  of: number,
  namespace: string,
  level: Health,
  word: string,
): WrittenPick => ({
  key: `${namespace}/${name}`,
  lead: { level, name, under: `${ready} of ${of} ready · ${namespace}` },
  status: { level, word },
})

const FEW: WrittenPick[] = [
  cluster('payments-db', 3, 3, 'shop', 'healthy', 'Healthy'),
  cluster('orders-db', 2, 3, 'shop', 'warning', 'Not all ready'),
  cluster('reports-db', 1, 1, 'data', 'healthy', 'Healthy'),
  cluster('sessions-db', 1, 2, 'shop', 'progressing', 'Switching over'),
  cluster(LONGEST, 0, 3, 'shop', 'critical', 'Unrecoverable'),
]
const MANY: WrittenPick[] = [
  ...FEW,
  ...Array.from({ length: 33 }, (_, i) =>
    cluster(`search-db-${String(i + 1).padStart(2, '0')}`, 3, 3, 'search', 'healthy', 'Healthy'),
  ),
]
const LISTS: Record<string, WrittenPickList> = {
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

const BUTTONS: WrittenButton[] = [
  { key: 'logs', name: 'Show logs' },
  { key: 'hibernate', name: 'Hibernate', changes: true, asks: true },
  { key: 'restart', name: 'Restart', changes: true, asks: true },
  { key: 'switch', name: 'Switch over', changes: true, asks: true },
  { key: 'backup', name: 'Back up now', changes: true, asks: true },
]
/**
 * Orders-db's: what two of them do said under them (one at length, cut at two lines), and the
 * filled one off while a backup runs.
 */
const NOTED: WrittenButton[] = [
  BUTTONS[2]!,
  {
    ...BUTTONS[3]!,
    note: 'Promotes the most up-to-date replica to primary: writes pause for a few seconds.',
  },
  {
    ...BUTTONS[4]!,
    note: 'Writes a base backup of every database to the object store now, besides those its schedule takes, kept like the rest.',
    off: 'A backup is running.',
  },
]
/** More that change than a phone's line names, and one that only reads, last of them all. */
const EVERY_BUTTON: WrittenButton[] = [
  ...BUTTONS.slice(1),
  // (One the "…" holds that's off.)
  {
    key: 'scale',
    name: 'Scale',
    changes: true,
    off: 'Scaling waits for the switchover to finish.',
  },
  { key: 'failover', name: 'Fail over', changes: true, asks: true },
  { key: 'metrics', name: 'Show metrics' },
]

/** The rest of the page for what's picked, as a plugin would describe it anew for each. */
function described(pick: WrittenPick): {
  header: WrittenHeader
  tiles: WrittenTile[]
  instances: WrittenTable
} {
  const name = pick.lead?.name ?? ''
  // ("3 of 3 ready · shop": how many are ready, of how many.)
  const under = pick.lead?.under ?? ''
  const few = name === 'reports-db' ? 1 : name === 'orders-db' ? 3 : name === LONGEST ? 5 : 2
  return {
    header: {
      name,
      // (Where it says why: the line under its name and word.)
      status:
        name === LONGEST
          ? { ...pick.status!, detail: 'No instance can be promoted: all three lost their storage' }
          : pick.status,
      buttons:
        name === 'sessions-db' ? EVERY_BUTTON : name === 'orders-db' ? NOTED : BUTTONS.slice(-few),
    },
    tiles: [
      {
        key: 'ready',
        icon: 'server',
        label: 'Instances ready',
        value: { kind: 'figure', text: `${under[0]}/${under[5]}` },
        detail:
          pick.status!.level === 'healthy'
            ? 'All ready'
            : `${Number(under[5]) - Number(under[0])} not ready`,
        level: pick.status!.level,
        opens: { list: '/Pod', labels: ['cnpg.io/cluster'] },
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
        // (A moment: Lumovi says how long ago, never the plugin.)
        value: { kind: 'time', time: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() },
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
const HARD: WrittenTile[][] = [
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
  // Still reading, and counted from a read cut at Lumovi's limit (the line under is Lumovi's).
  [
    { key: 'reading', icon: 'server', label: 'Still reading' },
    {
      key: 'waiting',
      icon: 'timer',
      label: 'Pods waiting',
      value: { kind: 'figure', text: '4,980' },
      detail: 'The plugin’s own line, which a cut read replaces',
      level: 'warning',
      cut: 'cut-pods',
    },
  ],
]

/** Karpenter's tiles: what's ready, what's coming and going, each opening a list. */
const KARPENTER_TILES: WrittenTile[] = [
  {
    key: 'pools',
    icon: 'layers',
    label: 'Node pools ready',
    value: { kind: 'figure', text: '3/3' },
    detail: 'All ready',
    level: 'healthy',
    opens: { list: 'karpenter.sh/NodePool' },
  },
  {
    key: 'nodes',
    icon: 'server',
    label: 'Nodes ready',
    value: { kind: 'figure', text: '17/20' },
    detail: '3 still starting',
    level: 'progressing',
    opens: { list: '/Node', labels: ['karpenter.sh/nodepool'] },
  },
  {
    key: 'launching',
    icon: 'rocket',
    label: 'Launching',
    value: { kind: 'figure', text: '2' },
    opens: { list: 'karpenter.sh/NodeClaim', health: ['progressing'] },
  },
  {
    key: 'replacing',
    icon: 'refresh-cw',
    label: 'Being replaced',
    value: { kind: 'figure', text: '1' },
    detail: 'Drifted',
    level: 'warning',
    opens: { list: 'karpenter.sh/NodeClaim' },
  },
]

/** A table of a card, with nothing to say but its rows' names and states. */
/** CPU or memory: how much is used of how much, and its words. */
type Use = [used: number, of: number, text: string]

/**
 * A card's table as Karpenter's: each row's CPU and memory against what it may have (a node
 * pool's limit, a node's own), and its state.
 */
const metered = (title: string, rows: [string, Health, string, Use, Use][]): WrittenTable => ({
  title,
  headings: false,
  columns: [
    { name: 'CPU', kind: 'meter' },
    { name: 'Memory', kind: 'meter' },
    { name: 'Status', kind: 'status' },
  ],
  rows: rows.map(([name, level, word, cpu, memory]) => ({
    key: name,
    lead: { level, name },
    cells: [
      { kind: 'meter', label: 'CPU', used: cpu[0], of: cpu[1], text: cpu[2] },
      { kind: 'meter', label: 'Memory', used: memory[0], of: memory[1], text: memory[2] },
      { kind: 'status', level, word },
    ],
  })),
})

/** What the nodes are: twenty of them, three ways, the zones as they came (not largest first). */
const MIX: WrittenCounts = {
  groups: [
    {
      title: 'Instance types',
      code: true,
      rows: (
        [
          ['m6i.2xlarge', 7],
          ['c6i.4xlarge', 5],
          ['r6i.xlarge', 3],
          ['m6i.large', 1],
          ['m5.large', 1],
          ['t3.medium', 1],
          ['c5.xlarge', 1],
          ['m6g.large', 1],
        ] as const
      ).map(([value, count]) => ({ value, count })),
    },
    {
      title: 'Capacity types',
      rows: [
        { value: 'On demand', count: 13 },
        { value: 'Spot', count: 7 },
        // (None of these: listed, with no bar.)
        { value: 'Reserved', count: 0 },
      ],
    },
    {
      title: 'Zones',
      code: true,
      rows: [
        { value: 'eu-central-1b', count: 5 },
        { value: 'eu-central-1a', count: 6 },
        { value: 'eu-west-1a', count: 3 },
        { value: 'eu-central-1c', count: 4 },
        // (Longer than its column, with a mark in it.)
        { value: 'eu-central-1-wl1-berlin-1\u202ewlz-1', count: 2 },
      ],
    },
  ],
}

/** What the door says of a part's description, as it says it: its kinds first, then the part's own check. */
const refusal = <P extends Part>(part: P, written: WrittenProps<P>) =>
  wrongWithFields(written, part.props, part.required ?? [], part.name) ?? part.also?.(written)

/** Parts that can't be drawn as they're described, each wrong in one way. */
const REFUSED: (string | undefined)[] = [
  refusal(tilesPart, { tiles: HARD[0]! }),
  refusal(tilesPart, { tiles: [HARD[0]![0]!] }),
  refusal(tilesPart, { tiles: [...HARD[0]!, ...HARD[1]!] }),
  refusal(tilesPart, { tiles: [HARD[0]![0]!, HARD[0]![0]!] }),
  refusal(tilesPart, { tiles: [HARD[0]![1]!, HARD[0]![0]!, HARD[0]![0]!] }),
  // (A value that's neither a figure nor words: its kind says so.)
  refusal(tilesPart, {
    tiles: [HARD[1]![1]!, { ...HARD[1]![0]!, value: { kind: 'big' as never, text: '1' } }],
  }),
  refusal(headerPart, { name: 'a', buttons: BUTTONS }),
  refusal(headerPart, { name: 'a' }),
  refusal(headerPart, { name: 'a', buttons: [BUTTONS[0]!, BUTTONS[0]!] }),
  refusal(headerPart, { name: 'a', buttons: [{ ...BUTTONS[0]!, note: 'x'.repeat(121) }] }),
  refusal(headerPart, { name: 'a', buttons: [{ ...BUTTONS[0]!, off: 'x'.repeat(81) }] }),
  refusal(splitPart, { list: LISTS['38 clusters']! }),
  refusal(splitPart, { list: { title: 'Clusters', rows: [FEW[0]!, FEW[0]!] } }),
  // (Not refused: what was picked may be gone from the cluster, and the list takes its first.)
  refusal(splitPart, { list: { title: 'Clusters', rows: FEW, picked: 'nowhere' } }),
]

export function KitFrame() {
  const [which, setWhich] = useState('38 clusters')
  const [events, setEvents] = useState<string[]>([])
  // What the "plugin" last described the rest of the page for.
  const [picked, setPicked] = useState<string>()
  // What a plugin would be told: a text as text, as the door sends it down.
  const said = (what: string) => (carries: object) =>
    setEvents((was) => [
      ...was,
      `${what} ${JSON.stringify(carries, (_, value: unknown) =>
        value !== null && typeof value === 'object' && 'their' in value ? value.their : value,
      )}`,
    ])
  const list = LISTS[which]!
  const rows = list.rows ?? []
  const pick =
    rows.find((row) => row.key === picked) ??
    rows.find((row) => row.key === list.picked) ??
    // (As the list stands: the worst first, here the longest name.)
    (list.asGiven ? rows[0] : rows.find((row) => row.status?.level === 'critical')) ??
    rows[0]
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
          list={handedAs({ list }, splitPart).list!}
          onPick={(carries) => {
            setPicked(carries.row.their)
            said('pick')(carries)
          }}
        >
          {rest && (
            <>
              <PageHeader header={handedAs(rest.header, headerPart)} onPress={said('press')} />
              <Tiles
                tiles={handedAs({ tiles: rest.tiles }, tilesPart).tiles}
                go={said('go')}
                onOpen={said('open')}
              />
              <Table {...handedAs(rest.instances, table)} />
            </>
          )}
        </Split>
        <Stack>
          {HARD.map((row, i) => (
            <Tiles key={i} tiles={handedAs({ tiles: row }, tilesPart).tiles} />
          ))}
        </Stack>
        {/* Karpenter's overview, as the frame's parts draw it. */}
        <section aria-label="Karpenter’s overview">
          <Stack>
            <Tiles tiles={handedAs({ tiles: KARPENTER_TILES }, tilesPart).tiles} />
            <Card {...handedAs({ title: 'Node pools' }, cardPart)}>
              <Table
                {...handedAs(
                  metered('Node pools', [
                    [
                      'default',
                      'healthy',
                      'Ready',
                      [24, 64, '24 of 64 cores'],
                      [96, 256, '96 of 256 GiB'],
                    ],
                    [
                      'gpu',
                      'healthy',
                      'Ready',
                      [8, 32, '8 of 32 cores'],
                      [60, 128, '60 of 128 GiB'],
                    ],
                    [
                      'spot-batch',
                      'warning',
                      'At its limit',
                      [64, 64, '64 of 64 cores'],
                      [200, 256, '200 of 256 GiB'],
                    ],
                  ]),
                  table,
                )}
              />
            </Card>
            <Pair {...handedAs({ first: 'wider' }, pairPart)}>
              <Card {...handedAs({ title: 'Nodes', note: '20 · 3 still starting' }, cardPart)}>
                <Table
                  {...handedAs(
                    metered('Nodes', [
                      [
                        'ip-10-0-1-17.eu-central-1.compute.internal',
                        'healthy',
                        'Ready',
                        [3.4, 8, '42%'],
                        [21, 32, '66%'],
                      ],
                      [
                        'ip-10-0-2-44.eu-central-1.compute.internal',
                        'progressing',
                        'Starting',
                        [0.2, 8, '3%'],
                        [2, 32, '6%'],
                      ],
                      [
                        'ip-10-0-3-91.eu-central-1.compute.internal',
                        'healthy',
                        'Ready',
                        [6.9, 8, '86%'],
                        [12, 32, '38%'],
                      ],
                    ]),
                    table,
                  )}
                />
              </Card>
              <Card {...handedAs({ title: 'Node mix' }, cardPart)}>
                <Counts {...handedAs(MIX, countsPart)} />
              </Card>
            </Pair>
          </Stack>
        </section>
        {/* A card whose table is still reading: the card says its title, once. */}
        <Card {...handedAs({ title: 'Disruption' }, cardPart)}>
          <Table
            {...handedAs(
              {
                title: 'Disruption',
                headings: false,
                columns: [],
                rows: [],
                state: { is: 'busy' },
              },
              table,
            )}
          />
        </Card>
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

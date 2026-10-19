/**
 * What assistants' tools answer with, as plain functions: the lines get_logs answers with
 * (src/backend/mcp/log-lines.ts: a line's level as a log says it, the lines with a text or of a
 * level, and never more than an answer holds, with what was left out said and the line to ask
 * from); and an object as get_resource shows it (long annotations left out, or only chosen
 * fields); a workload's rollouts with what its images resolved to; and the config
 * find_problems warns of. Nothing is launched.
 */
import { expect, test } from '../temp-folders.ts'
import { fitted, levelOf, linesOf } from '../../src/backend/mcp/log-lines.ts'
import {
  digestOf,
  fieldsOf,
  resolvedBy,
  rollouts,
  withoutLongAnnotations,
} from '../../src/backend/mcp/present.ts'
import { floatingTag, riskyConfig } from '../../src/backend/mcp/problems.ts'
import type { KubeObject, Revision } from '../../src/shared/api.ts'

test('a line’s level is what the log says: a structured field, or a word of its own at its start', () => {
  for (const [line, level] of [
    ['{"level":"error","msg":"payments client not initialised"}', 'error'],
    ['{"severity":"WARNING","message":"slow"}', 'warn'],
    ['time=2026-10-14T03:00:00Z level=info msg="listening"', 'info'],
    ['ERROR 2026-10-14 could not open the data files', 'error'],
    ['[warn] retrying', 'warn'],
    ['panic: runtime error: invalid memory address or nil pointer dereference', 'error'],
    ['Traceback (most recent call last):', 'error'],
    ['  at main.go:42', undefined],
    ['listening on :8080', undefined],
  ] as const) {
    expect(levelOf(line), line).toBe(level)
  }
})

test('the lines with a text in them, and of a level and above: a line that says none goes with the one before', () => {
  const log = [
    '{"level":"info","msg":"starting"}',
    '{"level":"warn","msg":"database connection failed, retrying"}',
    '{"level":"error","msg":"payments client not initialised"}',
    'panic: runtime error',
    '[signal SIGSEGV: segmentation violation]',
    '{"level":"info","msg":"shutting down"}',
    '',
  ].join('\n')
  expect(linesOf(log)).toHaveLength(6)
  expect(linesOf(log, { level: 'error' })).toEqual([
    '{"level":"error","msg":"payments client not initialised"}',
    'panic: runtime error',
    '[signal SIGSEGV: segmentation violation]',
  ])
  expect(linesOf(log, { level: 'warn' })).toHaveLength(4)
  expect(linesOf(log, { match: 'PAYMENTS' })).toEqual([
    '{"level":"error","msg":"payments client not initialised"}',
  ])
  expect(linesOf(log, { match: 'retrying', level: 'error' })).toEqual([])
})

test('more lines than an answer holds: the first and the last, what was left out between, and the line to ask from', () => {
  const lines = Array.from({ length: 5_000 }, (_, n) => `line ${n + 1} ${'x'.repeat(90)}`)
  const answer = fitted(lines, 48_000)
  expect(answer.length).toBeLessThanOrEqual(48_000)
  const shown = answer.split('\n')
  expect(shown[0]).toMatch(/^line 1 /)
  expect(shown.at(-1)).toMatch(/^line 5000 /)
  const said = shown.find((line) => line.startsWith('… '))!
  const [, leftOut, first, last, of, askFrom] =
    /^… (\d+) lines left out here \(lines (\d+) to (\d+) of (\d+)\): ask again with from: (\d+), and the same tailLines, match and level, for them \(a log that has grown since numbers its lines anew\)\.$/.exec(
      said,
    )!
  expect(Number(of)).toBe(5_000)
  expect(Number(last) - Number(first) + 1).toBe(Number(leftOut))
  expect(shown.length - 1 + Number(leftOut)).toBe(5_000)
  // Asked from there: the lines it left out come first.
  expect(fitted(lines, 48_000, Number(askFrom)).split('\n')[0]).toMatch(
    new RegExp(`^line ${askFrom} `),
  )
  // What fits is all there, with nothing said; and a line too long for anyone is cut, and said so.
  expect(fitted(lines.slice(0, 10), 48_000)).toBe(lines.slice(0, 10).join('\n'))
  expect(fitted(['y'.repeat(5_000)], 48_000)).toBe(`${'y'.repeat(2_000)}… (3000 more characters)`)
})

const pod = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: {
    name: 'db-0',
    namespace: 'data',
    annotations: { short: 'kept', 'tool.example.com/record': 'z'.repeat(5_000) },
  },
  spec: {
    containers: [
      { name: 'db', image: 'postgres:latest' },
      { name: 'exporter', image: 'exp:1' },
    ],
  },
  status: { containerStatuses: [{ name: 'db', restartCount: 14 }] },
} as unknown as KubeObject

test('an annotation too long to read at a glance is left out, saying how long and how to have it', () => {
  const shown = withoutLongAnnotations(pod)
  expect(shown.metadata.annotations).toEqual({
    short: 'kept',
    'tool.example.com/record':
      '(5000 characters, left out: ask for the field metadata.annotations to have it)',
  })
  // (A copy: the object read is as it was.)
  expect(pod.metadata.annotations!['tool.example.com/record']).toHaveLength(5_000)
})

test('only the fields asked for, a list followed into each item, and a path that leads nowhere said so', () => {
  expect(
    fieldsOf(pod, ['spec.containers.image', 'status.containerStatuses.restartCount', 'spec.nope']),
  ).toEqual({
    kind: 'Pod',
    name: 'db-0',
    namespace: 'data',
    'spec.containers.image': ['postgres:latest', 'exp:1'],
    'status.containerStatuses.restartCount': [14],
    'spec.nope': '(not in this object)',
  })
  expect(fieldsOf(pod, ['metadata.annotations'])['metadata.annotations']).toEqual(
    pod.metadata.annotations,
  )
})

test('a warning a later event says is over is resolved: scheduled, pulled, ready again; a back-off never is', () => {
  const event = (reason: string, type: string, at: number, name = 'web-0') =>
    ({
      apiVersion: 'v1',
      kind: 'Event',
      metadata: { name: `${name}.${reason}`, namespace: 'shop' },
      involvedObject: { kind: 'Pod', name, namespace: 'shop' },
      reason,
      type,
      lastTimestamp: new Date(at).toISOString(),
    }) as unknown as KubeObject
  const seen = (e: KubeObject) => Date.parse(String(e.lastTimestamp))
  const failed = event('FailedScheduling', 'Warning', 1_000)
  const scheduled = event('Scheduled', 'Normal', 2_000)
  expect(resolvedBy(failed, [failed, scheduled], seen)).toBe(scheduled)
  // Not by what came before it, nor about another object, nor by an event that doesn't say so.
  expect(resolvedBy(failed, [event('Scheduled', 'Normal', 500), failed], seen)).toBeUndefined()
  expect(resolvedBy(failed, [event('Scheduled', 'Normal', 2_000, 'web-1')], seen)).toBeUndefined()
  expect(resolvedBy(failed, [event('Pulled', 'Normal', 2_000)], seen)).toBeUndefined()
  // A "Failed" is over once its image is pulled only where it was a failure to pull: one that
  // fails to start (a missing key) fails again right after "Pulled", every time.
  const pull = {
    ...event('Failed', 'Warning', 1_000),
    message: 'Failed to pull image "db:17": not found',
  }
  const pulled = event('Pulled', 'Normal', 2_000)
  expect(resolvedBy(pull as KubeObject, [pull as KubeObject, pulled], seen)).toBe(pulled)
  const config = {
    ...event('Failed', 'Warning', 3_000),
    message: 'Error: couldn’t find key PAYMENTS_API_KEY in Secret shop/payments',
  } as KubeObject
  expect(resolvedBy(config, [config, event('Pulled', 'Normal', 4_000)], seen)).toBeUndefined()
  // A container started after a back-off is still the one that keeps crashing.
  const backOff = event('BackOff', 'Warning', 1_000)
  expect(resolvedBy(backOff, [backOff, event('Started', 'Normal', 2_000)], seen)).toBeUndefined()
})

test('a tag that moves: none, latest, or a major version alone; never a version or a digest', () => {
  for (const [image, moves] of [
    ['postgres', 'no tag, so latest'],
    ['registry.example.com:5000/team/db', 'no tag, so latest'],
    ['postgres:latest', 'latest'],
    ['postgres:16', 'a major version alone'],
    ['ghcr.io/acme/api:v2', 'a major version alone'],
    ['postgres:16-alpine', 'a major version alone'],
    ['postgres:16.4-alpine', undefined],
    ['nginx:1.29-alpine', undefined],
    ['ghcr.io/acme/build:20261014', undefined],
    ['registry.example.com:5000/team/db:3.1.0', undefined],
    [`postgres:latest@sha256:${'a'.repeat(64)}`, undefined],
  ] as const) {
    expect(floatingTag(image), image).toBe(moves)
  }
})

test('risky config: data in a volume claim, and an image whose tag moves pulled at every start', () => {
  const workload = (
    containers: { name: string; image: string; imagePullPolicy?: string }[],
    claims: 'templates' | 'volume' | 'none',
  ) =>
    ({
      kind: 'StatefulSet',
      metadata: { name: 'db', namespace: 'data' },
      spec: {
        ...(claims === 'templates' ? { volumeClaimTemplates: [{ metadata: { name: 'd' } }] } : {}),
        template: {
          spec: {
            containers,
            ...(claims === 'volume'
              ? { volumes: [{ name: 'd', persistentVolumeClaim: { claimName: 'd' } }] }
              : { volumes: [{ name: 'tmp', emptyDir: {} }] }),
          },
        },
      },
    }) as unknown as KubeObject
  const risky = riskyConfig(
    'StatefulSet',
    workload(
      [
        { name: 'db', image: 'postgres:16', imagePullPolicy: 'Always' },
        { name: 'pinned', image: 'postgres:16.4', imagePullPolicy: 'Always' },
        // (Unsaid, latest is pulled at every start: Kubernetes makes it Always.)
        { name: 'sidecar', image: 'busybox' },
        // (Unsaid for any other tag, it's pulled once a node.)
        { name: 'major', image: 'redis:8' },
      ],
      'templates',
    ),
  )
  expect(risky).toMatchObject({
    object: 'StatefulSet/db',
    namespace: 'data',
    containers: [
      { container: 'db', image: 'postgres:16', tag: 'a major version alone' },
      { container: 'sidecar', image: 'busybox', tag: 'no tag, so latest' },
    ],
  })
  expect(
    riskyConfig('Deployment', workload([{ name: 'db', image: 'postgres:latest' }], 'volume')),
  ).not.toBeNull()
  expect(
    riskyConfig('Deployment', workload([{ name: 'db', image: 'postgres:latest' }], 'none')),
  ).toBeNull()
  expect(
    riskyConfig(
      'StatefulSet',
      workload(
        [{ name: 'db', image: 'postgres:latest', imagePullPolicy: 'IfNotPresent' }],
        'templates',
      ),
    ),
  ).toBeNull()
})

test('a workload’s rollouts: each container’s image with the digest its pods pulled, or why there is none', () => {
  const sha = (n: string) => `sha256:${n.repeat(64)}`
  expect(digestOf(`ghcr.io/acme/api@${sha('a')}`)).toBe(sha('a'))
  expect(digestOf(`docker-pullable://ghcr.io/acme/api@${sha('b')}`)).toBe(sha('b'))
  expect(digestOf(sha('c'))).toBe(sha('c'))
  expect(digestOf('')).toBeUndefined()
  const revision = (n: number, hash: string, image: string): Revision => ({
    revision: n,
    createdAt: '2026-10-10T00:00:00Z',
    template: {
      spec: {
        initContainers: [{ name: 'init', image: 'busybox:1.37' }],
        containers: [{ name: 'api', image }],
      },
    },
    current: n === 3,
    ...(n === 3 ? { changeCause: 'Release 3' } : {}),
    pods: { label: 'pod-template-hash', values: [hash] },
  })
  const pod = (hash: string, api: string, init?: string) =>
    ({
      metadata: { name: `api-${hash}`, labels: { 'pod-template-hash': hash } },
      status: {
        containerStatuses: [{ name: 'api', imageID: api }],
        ...(init === undefined ? {} : { initContainerStatuses: [{ name: 'init', imageID: init }] }),
      },
    }) as unknown as KubeObject
  const shown = rollouts(
    [
      revision(3, 'c3', 'ghcr.io/acme/api:3'),
      revision(2, 'b2', 'ghcr.io/acme/api:2'),
      revision(1, 'a1', 'ghcr.io/acme/api:1'),
    ],
    [
      pod('c3', `ghcr.io/acme/api@${sha('1')}`, `busybox@${sha('9')}`),
      pod('c3', `ghcr.io/acme/api@${sha('2')}`, `busybox@${sha('9')}`),
      pod('b2', ''),
    ],
    Date.parse('2026-10-14T00:00:00Z'),
  )
  // (Its pods couldn't be listed: its images alone.)
  expect(rollouts([revision(1, 'a1', 'ghcr.io/acme/api:1')], undefined, 0)[0]).toEqual({
    revision: 1,
    made: expect.any(String),
    containers: [
      { name: 'init', image: 'busybox:1.37' },
      { name: 'api', image: 'ghcr.io/acme/api:1' },
    ],
  })
  expect(shown).toEqual([
    {
      revision: 3,
      made: '2026-10-10T00:00:00Z (4d ago)',
      current: true,
      changeCause: 'Release 3',
      pods: 2,
      containers: [
        { name: 'init', image: 'busybox:1.37', digest: sha('9') },
        // (Its tag moved between its pods' pulls: both are said.)
        { name: 'api', image: 'ghcr.io/acme/api:3', digests: [sha('1'), sha('2')] },
      ],
    },
    {
      revision: 2,
      made: '2026-10-10T00:00:00Z (4d ago)',
      pods: 1,
      containers: [
        { name: 'init', image: 'busybox:1.37', digest: 'none of its pods has pulled it yet' },
        { name: 'api', image: 'ghcr.io/acme/api:2', digest: 'none of its pods has pulled it yet' },
      ],
    },
    {
      revision: 1,
      made: '2026-10-10T00:00:00Z (4d ago)',
      pods: 0,
      containers: [
        { name: 'init', image: 'busybox:1.37', digest: 'no pod of it is left to say' },
        { name: 'api', image: 'ghcr.io/acme/api:1', digest: 'no pod of it is left to say' },
      ],
    },
  ])
})

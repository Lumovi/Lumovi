/**
 * Changes through the door, as plain functions: what a page's proposal may say and what the door
 * refuses of it, the person's values put in only where the page marked them, each field's words
 * in Lumovi's, a press's token good once and for a moment, and what a plugin may propose at all.
 */
import { expect, test } from '@playwright/test'
import {
  CHANGE_LIMITS,
  changedFields,
  fieldAt,
  fieldWrong,
  filled,
  mayPropose,
  proposalProblem,
  sentProblem,
  startingValues,
  type Field,
  type Proposed,
} from '../../src/shared/plugin-changes.ts'
import { Tokens } from '../../src/shared/plugin-presses.ts'
import { parse as parseYaml } from 'yaml'
import {
  annotatedAs,
  commandOf,
  createdObject,
  heredocEnd,
  effectOf,
  pluginChanges,
  takenFrom,
  writesStatus,
} from '../../src/backend/plugin-changes.ts'

/** A whole proposal: a patch of one field, the size, with what's said otherwise. */
const proposal = (also: Record<string, unknown> = {}, change: Record<string, unknown> = {}) => ({
  propose: 1,
  press: 'p1',
  verb: 'Resize',
  change: {
    action: 'patch',
    target: 'o1',
    patch: { spec: { size: { field: 'size' } } },
    ...change,
  },
  fields: [{ kind: 'number', key: 'size', label: 'Size', min: 1, max: 10, value: 3 }],
  ...also,
})
const read = (said: unknown) => {
  const got = proposalProblem(said)
  if (typeof got === 'string') throw new Error(got)
  return got
}

test('a whole proposal is read as it was written: its press, its word, its change and its fields', () => {
  expect(read(proposal())).toEqual({
    id: 1,
    press: 'p1',
    verb: 'Resize',
    action: 'patch',
    target: 'o1',
    body: { spec: { size: { field: 'size' } } },
    fields: [{ kind: 'number', key: 'size', label: 'Size', min: 1, max: 10, value: 3 }],
  })
  // A create names its own kind, and maybe an object whose namespace it's made in.
  expect(
    read({
      propose: 2,
      press: 'p1',
      change: {
        action: 'create',
        kind: 'postgresql.cnpg.io/Backup',
        in: 'o2',
        object: { metadata: { generateName: 'nightly-' }, spec: { cluster: { name: 'db' } } },
      },
    }),
  ).toMatchObject({ action: 'create', kind: 'postgresql.cnpg.io/Backup', in: 'o2' })
  // A scale's count, or the field it comes from.
  expect(
    read({ propose: 3, press: 'p1', change: { action: 'scale', target: 'o1', replicas: 2 } })
      .replicas,
  ).toBe(2)
  // A choice's options carry any JSON they put in.
  const choice = read(
    proposal(
      {
        fields: [
          {
            kind: 'choice',
            key: 'how',
            label: 'Strategy',
            options: [
              { label: 'Apply', value: { apply: {} } },
              { label: 'Hook', value: { hook: {} } },
            ],
          },
        ],
      },
      { patch: { syncStrategy: { field: 'how' } } },
    ),
  )
  expect((choice.fields[0] as Extract<Field, { kind: 'choice' }>).options[0]!.value).toEqual({
    apply: {},
  })
})

test('what the door refuses of a proposal, in its own words, quoting nothing the plugin wrote', () => {
  const refused = (said: unknown) => proposalProblem(said)
  expect(refused('propose')).toBe('propose: should be named values')
  expect(refused(proposal({ propose: 0 }))).toMatch(/^propose: should be a whole number/)
  expect(refused(proposal({ press: 'not a token!' }))).toMatch(/^propose\.press:/)
  expect(refused(proposal({}, { action: 'restart' }))).toMatch(
    /^propose\.change\.action: should be one of patch, create, delete, scale/,
  )
  // The button: one line, short, never the way out, and never for a deletion.
  for (const verb of [
    'Cancel',
    '  don’t ',
    'Cancel…',
    'Not now!',
    'Dismiss',
    'Never mind',
    'Skip',
    'Got it',
    'EXIT',
    'Ｃａｎｃｅｌ',
  ]) {
    expect(refused(proposal({ verb })), verb).toMatch(/would read as the way out/)
  }
  expect(typeof refused(proposal({ verb: 'Sync' }))).toBe('object')
  expect(refused(proposal({ verb: 'a'.repeat(CHANGE_LIMITS.verb + 1) }))).toMatch(/longer than 24/)
  expect(refused(proposal({ verb: 'Two\nlines' }))).toMatch(/one line/)
  expect(refused(proposal({ verb: 'Delete it' }, { action: 'delete', patch: undefined }))).toBe(
    'propose.verb: a deletion’s button is Lumovi’s own',
  )
  // Fields: at most five, each key once, each going somewhere, each place a field's.
  const five = Array.from({ length: 6 }, (_, i) => ({ kind: 'switch', key: `k${i}`, label: 'L' }))
  expect(refused(proposal({ fields: five }))).toMatch(/longer than 5/)
  expect(
    refused(
      proposal({
        fields: [
          { kind: 'switch', key: 'a', label: 'A' },
          { kind: 'switch', key: 'a', label: 'B' },
        ],
      }),
    ),
  ).toBe('propose.fields: each key once')
  expect(refused(proposal({}, { patch: { spec: { size: 4 } } }))).toBe(
    'propose.fields: size goes nowhere in the change',
  )
  expect(refused(proposal({}, { patch: { spec: { size: { field: 'other' } } } }))).toMatch(
    /names no field other/,
  )
  expect(
    refused(proposal({ fields: [{ kind: 'number', key: 'size', label: 'Size', min: 5, max: 1 }] })),
  ).toMatch(/its min is above its max/)
  expect(
    refused(
      proposal({
        fields: [{ kind: 'text', key: 'size', label: 'x'.repeat(CHANGE_LIMITS.label + 1) }],
      }),
    ),
  ).toMatch(/longer than 40/)
  expect(
    refused(
      proposal({
        fields: [
          { kind: 'choice', key: 'size', label: 'One', options: [{ label: 'only', value: 1 }] },
        ],
      }),
    ),
  ).toMatch(/two at least/)
  expect(
    refused(
      proposal({
        fields: [
          {
            kind: 'choice',
            key: 'size',
            label: 'C',
            options: [{ label: 'a' }, { label: 'b', value: 2 }],
          },
        ],
      }),
    ),
  ).toMatch(/options\[0\]\.value: is required/)
  // A patch's metadata holds its labels and annotations, and nothing else; and never a status.
  for (const meta of [
    { ownerReferences: [] },
    { managedFields: [] },
    { finalizers: ['x'] },
    { resourceVersion: '1' },
    { name: 'other' },
  ]) {
    expect(
      refused(proposal({ fields: [] }, { patch: { metadata: meta } })),
      JSON.stringify(meta),
    ).toMatch(/metadata: holds only labels, annotations/)
  }
  expect(refused(proposal({ fields: [] }, { patch: { status: { phase: 'Done' } } }))).toMatch(
    /status: isn’t a plugin’s to write/,
  )
  // A field never stands for the whole of it, or for its metadata whole: what a value brings in
  // there could be anything (the two shapes that once let owners and managers back in).
  const choiceOf = (value: unknown) => [
    {
      kind: 'choice',
      key: 'm',
      label: 'M',
      options: [
        { label: 'a', value },
        { label: 'b', value: {} },
      ],
    },
  ]
  expect(
    refused(
      proposal(
        { fields: choiceOf({ ownerReferences: [{}] }) },
        { patch: { metadata: { field: 'm' } } },
      ),
    ),
  ).toBe('propose.change.patch.metadata: a field can’t stand for the whole of it')
  expect(
    refused(
      proposal(
        { fields: choiceOf({ metadata: { managedFields: [] } }) },
        { patch: { field: 'm' } },
      ),
    ),
  ).toBe('propose.change.patch: a field can’t stand for the whole of it')
  // Never deeper than 20, nor a key longer than 253.
  let deep: unknown = 1
  for (let i = 0; i < 25; i++) deep = { a: deep }
  expect(refused(proposal({ fields: [] }, { patch: deep }))).toMatch(/nested deeper than 20/)
  expect(refused(proposal({ fields: [] }, { patch: { ['k'.repeat(254)]: 1 } }))).toMatch(
    /key longer than 253/,
  )
  // A create: a kind of its own as group/Kind, a name or a generateName, and no namespace of its own.
  const create = (object: unknown, kind = 'example.com/Widget') =>
    refused({ propose: 1, press: 'p1', change: { action: 'create', kind, object } })
  expect(create({ metadata: { name: 'w' } }, '/Secret')).toMatch(/should be a kind of its own/)
  expect(create({ metadata: {} })).toMatch(/a name or a generateName/)
  for (const meta of [
    { name: 'w', namespace: 'kube-system' },
    { name: 'w', uid: 'u' },
    { name: 'w', finalizers: [] },
  ]) {
    expect(create({ metadata: meta }), JSON.stringify(meta)).toMatch(
      /metadata: holds only name, generateName, labels, annotations/,
    )
  }
  expect(create({ metadata: { name: 'w' }, status: {} })).toMatch(
    /status: isn’t a plugin’s to write/,
  )
})

test('the person’s values go in only where the page marked them, each a value of its kind', () => {
  const proposed = read(
    proposal(
      {
        fields: [
          { kind: 'text', key: 'note', label: 'Note' },
          { kind: 'switch', key: 'prune', label: 'Prune' },
        ],
      },
      { patch: { spec: { note: { field: 'note' }, prune: { field: 'prune' } } } },
    ),
  )
  const values = startingValues(proposed.fields)
  expect(values).toEqual({ note: '', prune: false })
  // A text that holds what JSON quotes, a brace and a line's end stays one string, never more.
  const typed = 'a "b" } c\nd'
  expect(filled(proposed, { ...values, note: typed })).toEqual({
    body: { spec: { note: typed, prune: false } },
  })
  // Nothing while a value is wrong; and nothing past what a proposal may send.
  const sized = read(proposal())
  expect(filled(sized, { size: 11 })).toBe('fields')
  const big = read(
    proposal(
      { fields: [{ kind: 'text', key: 'size', label: 'Big', most: 256 }] },
      { patch: { spec: { size: { field: 'size' }, pad: 'x'.repeat(CHANGE_LIMITS.bytes) } } },
    ),
  )
  expect(filled(big, { size: 'y' })).toBe('too-big')
  // The fields the person changed: what the history keeps, never the values.
  expect(changedFields(proposed.fields, { note: 'hi', prune: false })).toEqual(['note'])
})

test('what the person’s values make of a change is held to the door’s rule too, and the backend asks it again', () => {
  // (Made by hand, past the door: what a value brings in is asked of the change as it's sent.)
  const placed = (body: unknown, value: unknown): Proposed => ({
    id: 1,
    press: 'p',
    action: 'patch',
    target: 'o',
    body,
    fields: [
      {
        kind: 'choice',
        key: 'm',
        label: 'M',
        options: [
          { label: 'a', value },
          { label: 'b', value: 1 },
        ],
        value: 0,
      },
    ],
  })
  expect(filled(placed({ metadata: { field: 'm' } }, { ownerReferences: [{}] }), { m: 0 })).toBe(
    'not-allowed',
  )
  expect(filled(placed({ field: 'm' }, { metadata: { managedFields: [] } }), { m: 0 })).toBe(
    'not-allowed',
  )
  let deep: unknown = 1
  for (let i = 0; i < 19; i++) deep = { a: deep }
  expect(filled(placed({ spec: { here: { field: 'm' } } }, deep), { m: 0 })).toBe('not-allowed')
  expect(filled(placed({ spec: { here: { field: 'm' } } }, 'fine'), { m: 0 })).toEqual({
    body: { spec: { here: 'fine' } },
  })
  // As the backend asks it of what it's sent: the same rule, and no place left, no key too long,
  // nothing past what a proposal may send.
  expect(sentProblem({ metadata: { ownerReferences: [] } }, 'patch')).toMatch(
    /holds only labels, annotations/,
  )
  expect(sentProblem({ spec: { size: { field: 'size' } } }, 'patch')).toBe(
    'change: a field’s place is left in it',
  )
  expect(sentProblem({ ['k'.repeat(254)]: 1 }, 'patch')).toMatch(/key is longer than 253/)
  expect(sentProblem({ spec: { pad: 'x'.repeat(CHANGE_LIMITS.bytes) } }, 'patch')).toMatch(
    /more than a plugin may send/,
  )
  expect(sentProblem({ metadata: { generateName: 'nightly-' } }, 'create')).toBeUndefined()
  expect(sentProblem(undefined, 'patch')).toMatch(/should be named values/)
  expect(sentProblem(JSON.parse('{"spec":{"__proto__":{"a":1}}}'), 'patch')).toMatch(
    /a key no object may have/,
  )
})

test('each field says what’s wrong with it in Lumovi’s words, by its kind', () => {
  const text: Field = { kind: 'text', key: 't', label: 'T', required: true, most: 5 }
  expect(fieldWrong(text, '  ')).toBe('Fill this in.')
  expect(fieldWrong(text, 'abcdef')).toBe('At most 5 characters.')
  expect(fieldWrong(text, 'abc')).toBeUndefined()
  const number: Field = { kind: 'number', key: 'n', label: 'N', min: 1, max: 10 }
  for (const wrong of [undefined, 0, 11, 2.5])
    expect(fieldWrong(number, wrong)).toBe('A whole number from 1 to 10.')
  expect(fieldWrong(number, 10)).toBeUndefined()
  const choice: Field = {
    kind: 'choice',
    key: 'c',
    label: 'C',
    options: [
      { label: 'a', value: 1 },
      { label: 'b', value: 2 },
    ],
  }
  expect(fieldWrong(choice, undefined)).toBe('Choose one.')
  expect(fieldWrong(choice, 1)).toBeUndefined()
  expect(fieldWrong({ kind: 'switch', key: 's', label: 'S' }, true)).toBeUndefined()
})

test('the cluster’s words are said under the field whose place they name', () => {
  const proposed: Proposed = read(
    proposal({}, { patch: { operation: { sync: { revision: { field: 'size' } } } } }),
  )
  expect(fieldAt(proposed, 'operation.sync.revision')).toBe('size')
  expect(fieldAt(proposed, '.operation.sync.revision')).toBe('size')
  expect(fieldAt(proposed, 'spec.other')).toBeUndefined()
  const scaled = read({
    propose: 1,
    press: 'p',
    change: { action: 'scale', target: 'o', replicas: { field: 'n' } },
    fields: [{ kind: 'number', key: 'n', label: 'N', min: 0, max: 5 }],
  })
  expect(fieldAt(scaled, 'spec.replicas')).toBe('n')
})

test('a press’s token is good once, for a moment, and only the latest press’s', () => {
  let made = 0
  const tokens = new Tokens({ objects: 0 }, () => `t${++made}`)
  const first = tokens.pressed(1_000)
  const second = tokens.pressed(2_000)
  // The next press lets go of the one before.
  expect(tokens.spendPress(first, 2_100)).toBe(false)
  expect(tokens.spendPress(second, 2_100)).toBe(true)
  expect(tokens.spendPress(second, 2_200)).toBe(false)
  // Past its moment, or let go (the page hidden), or with the page gone: nothing.
  const late = tokens.pressed(10_000)
  expect(tokens.spendPress(late, 10_000 + CHANGE_LIMITS.pressMs + 1)).toBe(false)
  const hidden = tokens.pressed(20_000)
  tokens.letPressGo()
  expect(tokens.spendPress(hidden, 20_001)).toBe(false)
  const closed = tokens.pressed(30_000)
  tokens.close()
  expect(tokens.spendPress(closed, 30_001)).toBe(false)
})

test('a plugin proposes only what its file says, and never to one of Kubernetes’ own kinds', () => {
  const changes = [
    { kind: 'argoproj.io/Application', actions: ['patch', 'delete'] as const },
  ] as const
  expect(mayPropose('argoproj.io/Application', 'patch', changes)).toBe(true)
  expect(mayPropose('argoproj.io/Application', 'create', changes)).toBe(false)
  expect(mayPropose('argoproj.io/AppProject', 'patch', changes)).toBe(false)
  for (const kind of [
    '/Secret',
    'apps/Deployment',
    'rbac.authorization.k8s.io/Role',
    'batch/Job',
  ]) {
    expect(mayPropose(kind, 'patch', [{ kind, actions: ['patch'] }]), kind).toBe(false)
  }
  // (A group of a project of Kubernetes' that isn't its own API is a plugin's to claim.)
  expect(
    mayPropose('cluster.x-k8s.io/Cluster', 'patch', [
      { kind: 'cluster.x-k8s.io/Cluster', actions: ['patch'] },
    ]),
  ).toBe(true)
})

test('whose fields a patch would take, read from the cluster’s own words', () => {
  expect(
    takenFrom(
      'Apply failed with 2 conflicts: conflict with "argocd-application-controller" using argoproj.io/v1alpha1: .operation\nconflict with "helm" using argoproj.io/v1alpha1: .spec.source.targetRevision',
    ),
  ).toEqual([
    { manager: 'argocd-application-controller', field: 'operation' },
    { manager: 'helm', field: 'spec.source.targetRevision' },
  ])
  expect(takenFrom('something else')).toEqual([])
})

test('a patch of only annotations, or only labels, is said as kubectl annotate or label: exactly what it sends', () => {
  const application = {
    kind: 'Application.argoproj.io',
    apiKind: 'Application',
    plural: 'applications',
    group: 'argoproj.io',
    version: 'v1alpha1',
    namespaced: true,
    label: 'Applications',
  }
  const said = (body: unknown) =>
    commandOf(
      {
        step: 'try',
        plugin: 'argo-cd',
        digest: '',
        codeDigest: '',
        context: 'prod',
        action: 'patch',
        body,
      },
      application,
      'argocd',
      'storefront',
    )
  expect(said({ metadata: { annotations: { 'argocd.argoproj.io/refresh': 'normal' } } })).toBe(
    'kubectl annotate application.argoproj.io/storefront argocd.argoproj.io/refresh=normal --overwrite -n argocd --context prod',
  )
  expect(said({ metadata: { labels: { team: 'web', old: null } } })).toBe(
    'kubectl label application.argoproj.io/storefront team=web old- --overwrite -n argocd --context prod',
  )
  // What kubectl's form sets, read back, is the patch: each key to its text, or taken away.
  for (const body of [
    { metadata: { annotations: { a: '1', 'b.example.com/c': 'two words', d: null } } },
    { metadata: { labels: { tier: 'web' } } },
  ]) {
    const { verb, pairs } = annotatedAs(body)!
    const back = Object.fromEntries(
      pairs.map((pair) =>
        pair.endsWith('-') && !pair.includes('=')
          ? [pair.slice(0, -1), null]
          : [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)],
      ),
    )
    expect({ metadata: { [verb === 'annotate' ? 'annotations' : 'labels']: back } }).toEqual(body)
  }
  // Anything else, or a value that isn't text, is said as the patch itself.
  for (const body of [
    { metadata: { annotations: { a: '1' }, labels: { b: '2' } } },
    { metadata: { annotations: { a: 1 } } },
    { metadata: { annotations: {} } },
    { metadata: { annotations: { a: '1' } }, spec: { x: 1 } },
    { metadata: { annotations: { 'a=b': '1' } } },
  ]) {
    expect(annotatedAs(body), JSON.stringify(body)).toBeUndefined()
    expect(said(body)).toMatch(
      /^kubectl patch application\.argoproj\.io\/storefront --type merge -p /,
    )
  }
})

test('a create is said as kubectl reading the very object shown: in Kubernetes’ order, its generateName as asked', () => {
  const backup = {
    kind: 'Backup.postgresql.cnpg.io',
    apiKind: 'Backup',
    plural: 'backups',
    group: 'postgresql.cnpg.io',
    version: 'v1',
    namespaced: true,
    label: 'Backups',
  }
  const request = {
    step: 'try' as const,
    plugin: 'cloudnative-pg',
    digest: '',
    codeDigest: '',
    context: 'prod',
    action: 'create' as const,
    // (As a plugin may write it: its spec before its metadata.)
    body: {
      spec: { cluster: { name: 'orders' }, method: 'barmanObjectStore' },
      metadata: { generateName: 'orders-' },
    },
  }
  const object = createdObject(request, backup, 'data')
  expect(Object.keys(object)).toEqual(['apiVersion', 'kind', 'metadata', 'spec'])
  expect(object.metadata).toEqual({ generateName: 'orders-', namespace: 'data' })
  const command = commandOf(request, backup, 'data', undefined)
  expect(command.split('\n')[0]).toBe("kubectl create -f - -n data --context prod <<'LUMOVI_EOF'")
  expect(command.endsWith('\nLUMOVI_EOF')).toBe(true)
  // What kubectl reads from it is the object Lumovi sends, and nothing named for a file.
  const said = command.slice(command.indexOf('\n') + 1, command.lastIndexOf('\nLUMOVI_EOF'))
  expect(parseYaml(said)).toEqual(object)
  expect(said.split('\n')[0]).toBe('apiVersion: postgresql.cnpg.io/v1')
  expect(command).not.toContain('.yaml')
  // A value that reads as the end ends nothing: the end is a line no line of the object is.
  for (const value of ['EOF', 'LUMOVI_EOF', 'line\nLUMOVI_EOF\nline']) {
    const odd = {
      ...request,
      body: { ...request.body, spec: { ...request.body.spec, method: value } },
    }
    const lines = commandOf(odd, backup, 'data', undefined).split('\n')
    const end = lines.at(-1)!
    expect(lines[0]).toBe(`kubectl create -f - -n data --context prod <<'${end}'`)
    expect(lines.slice(1, -1)).not.toContain(end)
    expect(parseYaml(lines.slice(1, -1).join('\n'))).toEqual(createdObject(odd, backup, 'data'))
  }
  expect(heredocEnd('a\nLUMOVI_EOF\nLUMOVI_EOF_2')).toBe('LUMOVI_EOF_3')
  expect(heredocEnd('apiVersion: v1')).toBe('LUMOVI_EOF')
})

test('a scale is kept in the audit as Lumovi’s own is: its command and its count, and a cancel’s with neither', async () => {
  const recorded: Record<string, unknown>[] = []
  // (One of its own kinds: a plugin proposes changes to no other.)
  const rollouts = {
    kind: 'Rollout.argoproj.io',
    apiKind: 'Rollout',
    plural: 'rollouts',
    group: 'argoproj.io',
    version: 'v1alpha1',
    namespaced: true,
    label: 'Rollouts',
    subresources: ['scale'],
  }
  const web = {
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'Rollout',
    metadata: { name: 'web', namespace: 'shop', uid: 'u1', resourceVersion: '9' },
    spec: { replicas: 2 },
  }
  const change = pluginChanges({
    kube: {
      resource: async () => rollouts,
      get: async () => ({ ok: true, data: web }),
      change: async () => ({ ok: true, data: web }),
      isReadOnly: () => false,
    } as never,
    known: async () =>
      [
        {
          name: 'tinker',
          version: '1.0.0',
          origin: 'lumovi',
          file: 'tinker.yaml',
          digest: 'sha256:d',
          code: 'x',
          codeDigest: 'sha256:c',
          grant: { secrets: [] },
          changes: [{ kind: 'argoproj.io/Rollout', actions: ['scale'] }],
          label: 'Tinker',
        },
      ] as never,
    to: () => ({ host: 'desktop' }) as never,
    audit: { record: (event: Record<string, unknown>) => void recorded.push(event) } as never,
  })
  const asked = {
    plugin: 'tinker',
    digest: 'sha256:d',
    codeDigest: 'sha256:c',
    context: 'prod',
    action: 'scale',
    target: { kind: 'Rollout.argoproj.io', namespace: 'shop', name: 'web' },
    // (A count the person chose, in the plugin's field.)
    replicas: 7346,
    fields: ['count'],
  }
  // (A cancel says no count: Lumovi's dialog sends none with it.)
  const { replicas: _count, ...cancelled } = asked
  expect(await change({ ...cancelled, step: 'cancelled' })).toEqual({ ok: true })
  expect(
    await change({ ...asked, step: 'make', seen: { resourceVersion: '9', uid: 'u1' } }),
  ).toMatchObject({ ok: true })
  expect(recorded.map(({ outcome }) => outcome)).toEqual(['cancelled', 'success'])
  const [unsaid, made] = recorded as { command?: string; details: Record<string, unknown> }[]
  expect([unsaid!.command, unsaid!.details.replicas, unsaid!.details.paths]).toEqual([
    undefined,
    undefined,
    undefined,
  ])
  expect(made!.command).toBe(
    'kubectl scale rollout.argoproj.io/web --replicas=7346 -n shop --context prod',
  )
  expect(made!.details.replicas).toBe(7346)
  expect(made!.details.paths).toBeUndefined()
})

test('a change made after its object moved is judged again there: sent with the new version where it does the same, refused where it doesn’t', async () => {
  const applications = {
    kind: 'Application.argoproj.io',
    apiKind: 'Application',
    plural: 'applications',
    group: 'argoproj.io',
    version: 'v1alpha1',
    namespaced: true,
    label: 'Applications',
  }
  /** The Application as the cluster has it now: what a test moves between the try and the make. */
  let now = {
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'Application',
    metadata: { name: 'storefront', namespace: 'argocd', uid: 'u1', resourceVersion: '10' },
    spec: { syncPolicy: { automated: { prune: false, selfHeal: true } } },
    status: { reconciledAt: '2026-10-14T08:00:00Z' },
  }
  /** A merge patch, as the cluster applies one: a null takes a field away. */
  const merged = (into: unknown, patch: unknown): unknown => {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return patch
    const out: Record<string, unknown> = { ...((into ?? {}) as Record<string, unknown>) }
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete out[key]
      else out[key] = merged(out[key], value)
    }
    return out
  }
  const sent: { dryRun: boolean; version: unknown }[] = []
  const change = pluginChanges({
    kube: {
      resource: async () => applications,
      get: async () => ({ ok: true, data: now }),
      change: async (request: {
        dryRun?: boolean
        change: { patch: { metadata?: { resourceVersion?: string } } }
      }) => {
        // (The try's question of whose fields it would take: nobody's.)
        if (!('patch' in request.change)) return { ok: true, data: now }
        const version = request.change.patch.metadata?.resourceVersion
        sent.push({ dryRun: request.dryRun === true, version })
        // (A stale version, the cluster refuses, as it does.)
        if (version !== undefined && version !== now.metadata.resourceVersion) {
          return { ok: false, error: { code: 'conflict', message: 'the object has been modified' } }
        }
        const { resourceVersion: _, ...patch } = request.change.patch.metadata ?? {}
        return { ok: true, data: merged(now, { ...request.change.patch, metadata: patch }) }
      },
      isReadOnly: () => false,
    } as never,
    known: async () =>
      [
        {
          name: 'argo-cd',
          version: '1.3.0',
          origin: 'lumovi',
          file: 'argo-cd.yaml',
          digest: 'sha256:d',
          code: 'x',
          codeDigest: 'sha256:c',
          grant: { secrets: [] },
          changes: [{ kind: 'argoproj.io/Application', actions: ['patch'] }],
          label: 'Argo CD',
        },
      ] as never,
    to: () => ({ host: 'desktop' }) as never,
    audit: { record: () => {} } as never,
  })
  const asked = {
    plugin: 'argo-cd',
    digest: 'sha256:d',
    codeDigest: 'sha256:c',
    context: 'prod',
    action: 'patch',
    target: { kind: 'Application.argoproj.io', namespace: 'argocd', name: 'storefront' },
    // (Turn auto-sync off: built from what the page read, auto-sync on.)
    body: { spec: { syncPolicy: { automated: null } } },
  }
  const tried = async () => {
    const answer = (await change({ ...asked, step: 'try' })) as {
      seen: { resourceVersion: string; effect: string }
    }
    expect(answer.seen).toMatchObject({
      resourceVersion: now.metadata.resourceVersion,
      uid: now.metadata.uid,
    })
    expect(answer.seen.effect).toMatch(/^[0-9a-f]{64}$/)
    return answer.seen
  }
  const moved = (to: typeof now) => {
    now = to
  }

  // Its tool rewrote its status meanwhile: the same change there, so sent, with the version now.
  let seen = await tried()
  moved({
    ...now,
    metadata: { ...now.metadata, resourceVersion: '11' },
    status: { reconciledAt: '2026-10-14T08:00:05Z' },
  })
  sent.length = 0
  expect(await change({ ...asked, step: 'make', seen })).toMatchObject({ ok: true })
  expect(sent).toEqual([
    { dryRun: true, version: '11' },
    { dryRun: false, version: '11' },
  ])

  // Someone turned auto-sync off meanwhile: the change would do nothing it was shown to. Refused,
  // and nothing is sent onto it.
  now = {
    ...now,
    metadata: { ...now.metadata, resourceVersion: '12' },
    spec: { syncPolicy: { automated: { prune: false, selfHeal: true } } },
  }
  seen = await tried()
  moved({
    ...now,
    metadata: { ...now.metadata, resourceVersion: '13' },
    spec: { syncPolicy: {} } as never,
  })
  sent.length = 0
  expect(await change({ ...asked, step: 'make', seen })).toEqual({ ok: false, refused: 'conflict' })
  expect(sent.filter(({ dryRun }) => !dryRun)).toEqual([])

  // Another object by the name, made since: refused before anything is tried.
  now = {
    ...now,
    metadata: { ...now.metadata, resourceVersion: '14' },
    spec: { syncPolicy: { automated: { prune: false, selfHeal: true } } },
  }
  seen = await tried()
  moved({ ...now, metadata: { ...now.metadata, uid: 'u2', resourceVersion: '15' } })
  sent.length = 0
  expect(await change({ ...asked, step: 'make', seen })).toEqual({ ok: false, refused: 'conflict' })
  expect(sent).toEqual([])

  // Nothing moved: made with the version the try saw, tried no more.
  seen = await tried()
  sent.length = 0
  expect(await change({ ...asked, step: 'make', seen })).toMatchObject({ ok: true })
  expect(sent).toEqual([{ dryRun: false, version: '15' }])
})

test('a change that writes an object’s status is judged with its status; and a page’s change writes none, as the backend refuses it before it’s tried', async () => {
  const before = {
    metadata: { name: 'a', resourceVersion: '1' },
    spec: { size: 1 },
    status: { phase: 'Running' },
  }
  const after = {
    metadata: { name: 'a', resourceVersion: '2' },
    spec: { size: 2 },
    status: { phase: 'Running' },
  }
  const churned = { ...after, status: { phase: 'Terminating' } }
  // Not written: its status is the cluster's, and left out of what the change does.
  expect(effectOf(before, churned)).toBe(effectOf(before, after))
  // Written: its status is what the change does, and judged like any field.
  expect(effectOf(before, churned, true)).not.toBe(effectOf(before, after, true))
  // What writes status: a merge patch's, or a JSON patch's op at or under /status, by its path
  // or where a move or a copy takes it from.
  expect(writesStatus({ status: { phase: 'Done' } })).toBe(true)
  expect(writesStatus({ spec: { status: 'a field of spec' } })).toBe(false)
  expect(writesStatus([{ op: 'replace', path: '/status/phase', value: 'Done' }])).toBe(true)
  expect(writesStatus([{ op: 'remove', path: '/status' }])).toBe(true)
  expect(writesStatus([{ op: 'move', from: '/status/x', path: '/spec/x' }])).toBe(true)
  expect(writesStatus([{ op: 'replace', path: '/statusLine', value: 1 }])).toBe(false)
  expect(writesStatus([{ op: 'replace', path: '/spec/status', value: 1 }])).toBe(false)
  // And the backend refuses a page's change that writes status, before the cluster is asked: if
  // that's ever let through, the judge above is what holds.
  const asked: unknown[] = []
  const change = pluginChanges({
    kube: {
      resource: async () => ({
        kind: 'Widget.example.com',
        apiKind: 'Widget',
        plural: 'widgets',
        group: 'example.com',
        version: 'v1',
        namespaced: true,
        label: 'Widgets',
      }),
      get: async (q: unknown) => (asked.push(q), { ok: true, data: before }),
      change: async (q: unknown) => (asked.push(q), { ok: true, data: after }),
      isReadOnly: () => false,
    } as never,
    known: async () =>
      [
        {
          name: 'tinker',
          version: '1.0.0',
          origin: 'lumovi',
          file: 'tinker.yaml',
          digest: 'sha256:d',
          code: 'x',
          codeDigest: 'sha256:c',
          grant: { secrets: [] },
          changes: [{ kind: 'example.com/Widget', actions: ['patch'] }],
          label: 'Tinker',
        },
      ] as never,
    to: () => ({ host: 'desktop' }) as never,
    audit: { record: () => {} } as never,
  })
  for (const step of ['try', 'make'] as const) {
    expect(
      await change({
        plugin: 'tinker',
        digest: 'sha256:d',
        codeDigest: 'sha256:c',
        context: 'prod',
        action: 'patch',
        target: { kind: 'Widget.example.com', namespace: 'shop', name: 'a' },
        body: { status: { phase: 'Terminating' } },
        step,
        ...(step === 'make' ? { seen: { resourceVersion: '1', uid: 'u1', effect: 'x' } } : {}),
      }),
    ).toMatchObject({ ok: false, refused: 'not-granted' })
  }
  expect(asked).toEqual([])
})

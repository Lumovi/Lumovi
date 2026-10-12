/**
 * A plugin's file, read in Lumovi's own built page: plugins.spec's cases for what a file is
 * refused with and what's read from it, with its values and its words, each file parsed by the
 * page's own parser (the tests' stage lends it), so what's measured of the parser is what ran in
 * a page. Eight of plugins.spec's tests, the ones that reach a file's refusals that nothing else
 * in a page does: a change held to what a plugin may change; what its code reads of Kubernetes'
 * own kinds (spec.reads); the Secrets its pages show (spec.showsSecrets); what it asks for; the
 * pages, tabs and commands a plugin of Lumovi's own adds, a folder's file refused for adding
 * them (settled as a folder's files are), how what it adds is written and its numbers, and
 * their names. plugins.spec tries all of it as plain functions.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { pluginsAndCode, readLock, takePlugins, trust } from '../../scripts/plugins-bundle.ts'
import type { asks } from '../../src/shared/plugin-asks.ts'
import type { settle } from '../../src/shared/plugin-loading.ts'
import type { changeProblem, parsePlugin, ParseOptions, Plugin } from '../../src/shared/plugins.ts'
import { expect, test, type ServeOptions, type Served } from './fixtures.ts'

/** What the stage lends the tests of a plugin's file. */
interface FileChecks {
  parsePlugin: typeof parsePlugin
  changeProblem: typeof changeProblem
  asks: typeof asks
  settle: typeof settle
}
/** The page's window, as the stage lends it. */
type Lent = { __lumoviDoor: { doorChecks: FileChecks } }

/** Lumovi's page, built for the tests, with its parser there. */
async function opened(page: Page, serve: (options?: ServeOptions) => Promise<Served>) {
  const { url } = await serve()
  await page.goto(url)
  await page.waitForFunction(() => '__lumoviDoor' in window)
  return page
}

interface Parsing {
  text: string
  source: string
  options?: ParseOptions
  /** Whether what the Plugins page says it asks for is wanted too. */
  asked?: boolean
}

/**
 * Each text parsed in Lumovi's page, in turn: what it's refused with, and of the plugin, what
 * it reads, the Secrets its pages show, what it adds and its place; and, where asked, what the
 * Plugins page says it reads and shows.
 */
const parsedIn = (page: Page, parsings: Parsing[]) =>
  page.evaluate((parsings) => {
    const { parsePlugin, asks } = (window as unknown as Lent).__lumoviDoor.doorChecks
    return parsings.map(({ text, source, options, asked }) => {
      const { plugin, problems } = parsePlugin(text, source, options)
      const said = plugin && asked ? asks(plugin) : undefined
      return {
        problems,
        plugin: plugin && {
          reads: plugin.reads,
          showsSecrets: plugin.showsSecrets,
          added: plugin.added,
          place: plugin.place,
        },
        asks: said && { reads: said.reads, secrets: said.secrets },
      }
    })
  }, parsings)

// The second wall. The file's check refuses every way that's known of writing a change to what
// isn't a plugin's; so nothing a file can say reaches this one, and it's shown what a file
// couldn't: a change already filled in, as it would be sent.
test('a change is held, as it’s sent, to what a plugin may change', async ({ page, serve }) => {
  await opened(page, serve)
  const changes: Parameters<typeof changeProblem>[0][] = [
    { action: 'patch', patch: { spec: { suspend: true }, metadata: { annotations: { a: 'b' } } } },
    { action: 'patch', patch: [{ op: 'replace', path: '/spec/size', value: 3 }] },
    { action: 'patch', patch: { metadata: { finalizers: [] } } },
    { action: 'patch', patch: { metadata: { namespace: 'elsewhere' } } },
    { action: 'patch', patch: [{ op: 'remove', path: '/metadata/finalizers' }] },
    {
      action: 'patch',
      patch: [{ op: 'move', from: '/metadata/ownerReferences/0', path: '/spec/x' }],
    },
    { action: 'patch', patch: [{ op: 'replace', path: '/metadata', value: {} }] },
    { action: 'patch', patch: [{ op: 'replace', path: '', value: {} }] },
    { action: 'patch', patch: ['{{ .spec.op }}'] },
    { action: 'patch', patch: { metadata: '{{ .spec.metadata }}' } },
    {
      action: 'create',
      object: {
        apiVersion: 'example.com/v1',
        kind: 'Gadget',
        metadata: { name: 'gadget-abcde', namespace: 'shop', labels: { a: 'b' } },
      },
    },
    {
      action: 'create',
      object: {
        apiVersion: 'example.com/v1',
        kind: 'Gadget',
        metadata: { name: 'gadget-abcde', ownerReferences: [] },
      },
    },
    { action: 'delete' },
  ]
  const said = await page.evaluate((changes) => {
    const { changeProblem } = (window as unknown as Lent).__lumoviDoor.doorChecks
    return changes.map((change) => changeProblem(change))
  }, changes)
  expect(said[0]).toBeUndefined()
  expect(said[1]).toBeUndefined()
  expect(said[2]).toBe('changes metadata.finalizers, which a plugin can’t change')
  expect(said[3]).toContain('metadata.namespace')
  // What one placeholder for a whole operation would have come to.
  expect(said[4]).toContain('metadata.finalizers')
  expect(said[5]).toContain('metadata.ownerReferences')
  expect(said[6]).toContain('all of an object’s metadata')
  expect(said[7]).toContain('the object whole')
  expect(said[8]).toContain('fills in an operation whole')
  expect(said[9]).toContain('metadata whole')
  // A new object has its name and may have its namespace: its owners aren't a plugin's to say.
  expect(said[10]).toBeUndefined()
  expect(said[11]).toContain('metadata.ownerReferences')
  // And nothing but a patch or a new object is a plugin's action's.
  expect(said[12]).toContain('isn’t a patch or a new object')
})

// ——— What a plugin asks for ———

test('a plugin’s code says what it reads of Kubernetes’ own kinds, by the door’s list, and nothing else', async ({
  page,
  serve,
}) => {
  await opened(page, serve)
  /** A plugin of Karpenter's kinds whose code reads `reads`; one that came inside Lumovi unless said. */
  const plugin = (reads: string | undefined, carriesCode = true, asked = false): Parsing => ({
    text: [
      'apiVersion: lumovi.dev/v1beta1',
      'kind: Plugin',
      'metadata: { name: probe }',
      'spec:',
      '  version: 1.0.0',
      '  needs: { lumovi: 1.0.0 }',
      '  groups: [karpenter.sh]',
      '  views:',
      '    - kinds: [{ group: karpenter.sh, kind: NodePool }]',
      ...(reads === undefined ? [] : [`  reads: ${reads}`]),
    ].join('\n'),
    source: 'probe.yaml',
    options: { lumovisOwn: [], carriesCode },
    asked,
  })
  const keys = (path: string) => path.split('.').map((key) => ({ key }))

  // The example: a Node's fields, one annotation of its own group's, and its status, events and
  // usage; a Pod's fields. Each path as written, and its steps.
  const [example, none, folders] = await parsedIn(page, [
    plugin(
      `
    - group: ''
      kind: Node
      fields:
        - metadata.name
        - metadata.labels
        - metadata.creationTimestamp
        - metadata.annotations["karpenter.sh/do-not-disrupt"]
        - spec.taints
        - status.capacity
        - status.allocatable
      status: true
      events: true
      usage: true
    - group: ''
      kind: Pod
      fields: [metadata.name, metadata.namespace, spec.nodeName, status.phase]`,
      true,
      true,
    ),
    plugin(undefined),
    plugin("[{ group: '', kind: Pod, fields: [metadata.name] }]", false),
  ])
  expect(example!.problems).toEqual([])
  expect(example!.plugin!.reads).toEqual({
    '/Node': {
      fields: [
        { path: 'metadata.name', steps: keys('metadata.name') },
        { path: 'metadata.labels', steps: keys('metadata.labels') },
        { path: 'metadata.creationTimestamp', steps: keys('metadata.creationTimestamp') },
        {
          path: 'metadata.annotations["karpenter.sh/do-not-disrupt"]',
          steps: [
            { key: 'metadata' },
            { key: 'annotations' },
            { key: 'karpenter.sh/do-not-disrupt' },
          ],
        },
        { path: 'spec.taints', steps: keys('spec.taints') },
        { path: 'status.capacity', steps: keys('status.capacity') },
        { path: 'status.allocatable', steps: keys('status.allocatable') },
      ],
      status: true,
      events: true,
      usage: true,
    },
    '/Pod': {
      fields: ['metadata.name', 'metadata.namespace', 'spec.nodeName', 'status.phase'].map(
        (path) => ({ path, steps: keys(path) }),
      ),
      status: false,
      events: false,
      usage: false,
    },
  })
  // What the Plugins page says it reads: the paths as the file writes them.
  expect(example!.asks!.reads).toEqual([
    {
      kind: 'Node',
      fields: [
        'metadata.name',
        'metadata.labels',
        'metadata.creationTimestamp',
        'metadata.annotations["karpenter.sh/do-not-disrupt"]',
        'spec.taints',
        'status.capacity',
        'status.allocatable',
      ],
      status: true,
      events: true,
      usage: true,
    },
    {
      kind: 'Pod',
      fields: ['metadata.name', 'metadata.namespace', 'spec.nodeName', 'status.phase'],
      status: false,
      events: false,
      usage: false,
    },
  ])
  // A file that says none reads nothing.
  expect(none!.plugin!.reads).toEqual({})

  // A folder's file carries no code, so it says nothing of what code reads.
  expect(folders!.problems).toEqual([
    'probe.yaml: spec.reads: only a plugin that comes with Lumovi has code yet, so only its file can say what that code reads',
  ])

  const POD = "group: '', kind: Pod"
  const cases: (readonly [string, string])[] = [
    ['{}', 'probe.yaml: spec.reads: should be a list, not an object'],
    ['[]', 'probe.yaml: spec.reads: should not be empty'],
    ['[Pod]', 'probe.yaml: spec.reads[0]: should be a map of fields, not a string'],
    [
      `[{ ${POD}, fields: [metadata.name], logs: true }]`,
      'probe.yaml: spec.reads[0].logs: isn’t something a read has',
    ],
    ['[{ kind: Pod, fields: [metadata.name] }]', 'probe.yaml: spec.reads[0].group: is required'],
    [
      "[{ group: '', kind: 3, fields: [metadata.name] }]",
      'probe.yaml: spec.reads[0].kind: should be text, not a number',
    ],
    [`[{ ${POD} }]`, 'probe.yaml: spec.reads[0].fields: is required'],
    [`[{ ${POD}, status: true }]`, 'probe.yaml: spec.reads[0].fields: is required'],
    [`[{ ${POD}, fields: [] }]`, 'probe.yaml: spec.reads[0].fields: should not be empty'],
    [
      `[{ ${POD}, fields: [metadata.name], events: false }]`,
      'probe.yaml: spec.reads[0]: events should be true, or left out',
    ],
    [
      `[{ ${POD}, fields: [metadata.name], usage: yes }]`,
      'probe.yaml: spec.reads[0].usage: should be true or false, not a string',
    ],
    [
      "[{ group: karpenter.sh, kind: '*', fields: [metadata.name] }]",
      'probe.yaml: spec.reads[0]: a read is of one kind, named: never every kind of a group',
    ],
    [
      "[{ group: '', kind: __proto__, fields: [metadata.name] }]",
      'probe.yaml: spec.reads[0]: "__proto__" should be a kind’s own name, like Certificate: its group goes under group',
    ],
    [
      '[{ group: __proto__, kind: Pod, fields: [metadata.name] }]',
      'probe.yaml: spec.reads[0]: "__proto__" should be an API group’s name, like cert-manager.io',
    ],
    // Its own kinds are read whole; another tool's are its plugin's.
    [
      '[{ group: karpenter.sh, kind: NodePool, fields: [spec.limits] }]',
      'probe.yaml: spec.reads[0]: NodePool.karpenter.sh is one of this plugin’s own kinds, which its code reads whole: leave it out',
    ],
    [
      '[{ group: cert-manager.io, kind: Certificate, fields: [metadata.name] }]',
      'probe.yaml: spec.reads[0]: Certificate.cert-manager.io is neither this plugin’s own kind nor one of Kubernetes’: its code reads only those',
    ],
    // Never a Secret, however it's spelt: what's spelt otherwise is no kind of Kubernetes'.
    [
      "[{ group: '', kind: Secret, fields: [metadata.name] }]",
      'probe.yaml: spec.reads[0]: a Secret is never read by a plugin’s code',
    ],
    [
      '[{ group: core, kind: Secret, fields: [metadata.name] }]',
      'probe.yaml: spec.reads[0]: Secret.core is neither this plugin’s own kind nor one of Kubernetes’: its code reads only those',
    ],
    // A kind with no list isn't read at all: a ConfigMap's data with it.
    [
      "[{ group: '', kind: ConfigMap, fields: [data] }]",
      'probe.yaml: spec.reads[0]: ConfigMap isn’t on Lumovi’s list of what a plugin may read yet',
    ],
    [
      '[{ group: apps, kind: Deployment, fields: [metadata.name] }]',
      'probe.yaml: spec.reads[0]: Deployment isn’t on Lumovi’s list of what a plugin may read yet',
    ],
    [
      `[{ ${POD}, fields: [metadata.name] }, { ${POD}, fields: [spec.nodeName] }]`,
      'probe.yaml: spec.reads[1]: Pod is said already, in spec.reads[0]: one item a kind',
    ],
    // A path: a line of the list, exactly, as field names.
    [
      `[{ ${POD}, fields: [spec.containers.env] }]`,
      'probe.yaml: spec.reads[0].fields[0]: "spec.containers.env" isn’t on Lumovi’s list of what a plugin may read of Pod yet',
    ],
    [
      `[{ ${POD}, fields: [spec] }]`,
      'probe.yaml: spec.reads[0].fields[0]: "spec" isn’t on Lumovi’s list of what a plugin may read of Pod yet',
    ],
    [
      `[{ ${POD}, fields: ['metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"]'] }]`,
      'probe.yaml: spec.reads[0].fields[0]: "metadata.annotations[\\"kubectl.kubernete…" isn’t on Lumovi’s list of what a plugin may read of Pod yet',
    ],
    [
      `[{ ${POD}, fields: ['metadata.annotations["example.com/owner"]'] }]`,
      'probe.yaml: spec.reads[0].fields[0]: "metadata.annotations[\\"example.com/owner…" isn’t on Lumovi’s list of what a plugin may read of Pod yet',
    ],
    [
      `[{ ${POD}, fields: [metadata.__proto__] }]`,
      'probe.yaml: spec.reads[0].fields[0]: "metadata.__proto__" should be field names, like metadata.name',
    ],
    [
      `[{ ${POD}, fields: [.metadata.name] }]`,
      'probe.yaml: spec.reads[0].fields[0]: ".metadata.name" should be field names, like metadata.name',
    ],
    [
      `[{ ${POD}, fields: [$.metadata.name] }]`,
      'probe.yaml: spec.reads[0].fields[0]: "$.metadata.name" should be field names, like metadata.name',
    ],
    [
      `[{ ${POD}, fields: [''] }]`,
      'probe.yaml: spec.reads[0].fields[0]: "" should be field names, like metadata.name',
    ],
    [
      `[{ ${POD}, fields: ['metadata..name'] }]`,
      'probe.yaml: spec.reads[0].fields[0]: "metadata..name" should be field names, like metadata.name',
    ],
    [
      `[{ ${POD}, fields: ['spec.containers[*].image'] }]`,
      'probe.yaml: spec.reads[0].fields[0]: "spec.containers[*].image" should name one field: no wildcard, index or filter',
    ],
    [
      `[{ ${POD}, fields: ['spec.containers[0].image'] }]`,
      'probe.yaml: spec.reads[0].fields[0]: "spec.containers[0].image" should name one field: no wildcard, index or filter',
    ],
    [
      `[{ ${POD}, fields: [metadata.name, metadata.name] }]`,
      'probe.yaml: spec.reads[0].fields[1]: "metadata.name" is said twice',
    ],
  ]
  // As much as it may say, and no more.
  const item = (i: number) => `{ group: '', kind: Pod${i}, fields: [metadata.name] }`
  const long = `metadata.annotations["karpenter.sh/${'x'.repeat(254 - 'metadata.annotations["karpenter.sh/"]'.length)}"]`
  expect(long.length).toBe(254)
  const more = [
    // The same field, however it's spelt, is said once; and a key is a key's characters.
    `[{ ${POD}, fields: [metadata.name, 'metadata["name"]'] }]`,
    `[{ ${POD}, fields: ['metadata.annotations["karpenter.sh/аbc"]'] }]`,
    `[{ ${POD}, fields: ['metadata.annotations["karpenter.sh/a\u202eb"]'] }]`,
    `[${Array.from({ length: 21 }, (_, i) => item(i)).join(', ')}]`,
    `[{ ${POD}, fields: [${Array(31).fill('metadata.name').join(', ')}] }]`,
    `[{ ${POD}, fields: ['${long}'] }]`,
    // Its own group's annotation, by its key, is a Pod's to read too.
    `[{ ${POD}, fields: ['metadata.annotations["karpenter.sh/do-not-disrupt"]'] }]`,
  ]
  const said = (
    await parsedIn(
      page,
      [...cases.map(([reads]) => reads), ...more].map((reads) => plugin(reads)),
    )
  ).map(({ problems }) => problems.join('\n'))
  for (const [i, [reads, problem]] of cases.entries()) expect(said[i], reads).toBe(problem)
  const [twice, notALetter, unseen, kinds, paths, tooLong, ownGroup] = said.slice(cases.length)
  expect(twice).toBe('probe.yaml: spec.reads[0].fields[1]: "metadata[\\"name\\"]" is said twice')
  expect(notALetter).toBe(
    'probe.yaml: spec.reads[0].fields[0]: "metadata.annotations[\\"karpenter.sh/аbc\\"]" should be field names, like metadata.name',
  )
  expect(unseen).toContain('holds a character that can’t be seen (U+202E)')
  expect(kinds).toContain(
    'probe.yaml: spec.reads: holds 21, and a plugin’s code reads 20 kinds at most',
  )
  expect(paths).toBe(
    'probe.yaml: spec.reads[0].fields: holds 31, and an item names 30 paths at most',
  )
  expect(tooLong).toBe('probe.yaml: spec.reads[0].fields[0]: is longer than 253 characters')
  expect(ownGroup).toBe('')
})

test('a plugin’s pages show a Secret an object of its own kind names, by a path and keys its file declares', async ({
  page,
  serve,
}) => {
  await opened(page, serve)
  /** A plugin of cert-manager's Certificates whose pages show `shows`; one that came inside Lumovi unless said. */
  const plugin = (shows: string | undefined, carriesCode = true, asked = false): Parsing => ({
    text: [
      'apiVersion: lumovi.dev/v1beta1',
      'kind: Plugin',
      'metadata: { name: probe }',
      'spec:',
      '  version: 1.0.0',
      '  needs: { lumovi: 1.0.0 }',
      '  groups: [cert-manager.io, acme.cert-manager.io]',
      '  views:',
      '    - kinds: [{ group: cert-manager.io, kind: Certificate }]',
      ...(shows === undefined ? [] : [`  showsSecrets: ${shows}`]),
    ].join('\n'),
    source: 'probe.yaml',
    options: { lumovisOwn: [], carriesCode },
    asked,
  })
  const keys = (path: string) => path.split('.').map((key) => ({ key }))

  // docs' example, and a path that steps into a list (each item's name).
  const [example, none, folders] = await parsedIn(page, [
    plugin(
      `
    - group: cert-manager.io
      kind: Certificate
      path: spec.secretName
      keys: [tls.crt, ca.crt]
    - group: cert-manager.io
      kind: Certificate
      path: spec.keystores.passwordSecretRefs.name
      keys: [password]`,
      true,
      true,
    ),
    plugin(undefined),
    plugin(
      '[{ group: cert-manager.io, kind: Certificate, path: spec.secretName, keys: [tls.crt] }]',
      false,
    ),
  ])
  expect(example!.problems).toEqual([])
  expect(example!.plugin!.showsSecrets).toEqual([
    {
      kind: 'cert-manager.io/Certificate',
      path: 'spec.secretName',
      steps: keys('spec.secretName'),
      keys: ['tls.crt', 'ca.crt'],
    },
    {
      kind: 'cert-manager.io/Certificate',
      path: 'spec.keystores.passwordSecretRefs.name',
      steps: keys('spec.keystores.passwordSecretRefs.name'),
      keys: ['password'],
    },
  ])
  // What the Plugins page says its pages show: each path and its keys as the file writes them.
  expect(example!.asks!.secrets).toEqual([
    { kind: 'Certificate.cert-manager.io', path: 'spec.secretName', keys: ['tls.crt', 'ca.crt'] },
    {
      kind: 'Certificate.cert-manager.io',
      path: 'spec.keystores.passwordSecretRefs.name',
      keys: ['password'],
    },
  ])
  // A file that says none shows none.
  expect(none!.plugin!.showsSecrets).toEqual([])
  // A folder's file has no pages of its own, so it says nothing of what they show.
  expect(folders!.problems).toEqual([
    'probe.yaml: spec.showsSecrets: only a plugin that comes with Lumovi has pages of its own yet, so only its file can say what they show',
  ])

  const CERT = 'group: cert-manager.io, kind: Certificate'
  const at = 'probe.yaml: spec.showsSecrets[0]'
  const cases: (readonly [string, string])[] = [
    ['{}', 'probe.yaml: spec.showsSecrets: should be a list, not an object'],
    ['[]', 'probe.yaml: spec.showsSecrets: should not be empty'],
    [`[{ ${CERT}, keys: [tls.crt] }]`, `${at}.path: is required`],
    [`[{ ${CERT}, path: spec.secretName }]`, `${at}.keys: is required`],
    [`[{ ${CERT}, path: spec.secretName, keys: [] }]`, `${at}.keys: should not be empty`],
    [
      "[{ group: cert-manager.io, kind: '*', path: spec.secretName, keys: [tls.crt] }]",
      `${at}: a Secret is named by an object of one kind, named: never every kind of a group`,
    ],
    // Never a kind of Kubernetes', nor one it doesn't claim (of its own group or another).
    [
      "[{ group: '', kind: Pod, path: spec.secretName, keys: [tls.crt] }]",
      `${at}: Pod isn’t one of this plugin’s own kinds: only an object of its own kinds names a Secret its pages show`,
    ],
    [
      '[{ group: acme.cert-manager.io, kind: Order, path: spec.secretName, keys: [tls.crt] }]',
      `${at}: Order.acme.cert-manager.io isn’t one of this plugin’s own kinds: only an object of its own kinds names a Secret its pages show`,
    ],
    [
      '[{ group: cert-manager.io, kind: Issuer, path: spec.secretName, keys: [tls.crt] }]',
      `${at}: Issuer.cert-manager.io isn’t one of this plugin’s own kinds: only an object of its own kinds names a Secret its pages show`,
    ],
    // A label or an annotation is too easily written by something else to name a Secret.
    [
      `[{ ${CERT}, path: 'metadata.annotations["cert-manager.io/secret"]', keys: [tls.crt] }]`,
      `${at}.path: "metadata.annotations[\\"cert-manager.io/s…" is under metadata: a Secret is named in an object’s spec or its status`,
    ],
    [
      `[{ ${CERT}, path: metadata.name, keys: [tls.crt] }]`,
      `${at}.path: "metadata.name" is under metadata: a Secret is named in an object’s spec or its status`,
    ],
    // Field names only: no index, wildcard or filter, nothing that isn't a field's name.
    ...[
      'spec.secrets[0].name',
      'spec.*',
      '.spec.secretName',
      ' spec.secretName',
      'spec.__proto__',
    ].map(
      (path) =>
        [
          `[{ ${CERT}, path: ${JSON.stringify(path)}, keys: [tls.crt] }]`,
          `${at}.path: ${JSON.stringify(path)} should be field names, like spec.secretName`,
        ] as const,
    ),
    [
      `[{ ${CERT}, path: spec.${'x'.repeat(250)}, keys: [tls.crt] }]`,
      `${at}.path: is longer than 253 characters`,
    ],
    // Secrets' keys, each once, twenty at most.
    [
      `[{ ${CERT}, path: spec.secretName, keys: [tls/crt] }]`,
      `${at}.keys[0]: "tls/crt" should be a Secret’s key, like tls.crt`,
    ],
    ...['.', '..', '..data', 'a b', "''"].map(
      (key) =>
        [
          `[{ ${CERT}, path: spec.secretName, keys: [${key}] }]`,
          `${at}.keys[0]: ${JSON.stringify(key === "''" ? '' : key)} should be a Secret’s key, like tls.crt`,
        ] as const,
    ),
    [
      `[{ ${CERT}, path: spec.secretName, keys: [tls.crt, tls.crt] }]`,
      `${at}.keys[1]: "tls.crt" is said twice`,
    ],
    [
      `[{ ${CERT}, path: spec.secretName, keys: [${Array.from({ length: 21 }, (_, i) => `k${i}`).join(', ')}] }]`,
      `${at}.keys: holds 21, and an item names 20 keys at most`,
    ],
  ]
  // Ten items a file at most.
  const eleven = Array.from(
    { length: 11 },
    (_, i) => `{ ${CERT}, path: spec.s${i}, keys: [tls.crt] }`,
  ).join(', ')
  const more = [
    // The same kind and path twice, however it's spelt.
    `[{ ${CERT}, path: spec.secretName, keys: [tls.crt] }, { ${CERT}, path: 'spec["secretName"]', keys: [ca.crt] }]`,
    `[${eleven}]`,
  ]
  const said = (
    await parsedIn(
      page,
      [...cases.map(([shows]) => shows), ...more].map((shows) => plugin(shows)),
    )
  ).map(({ problems }) => problems.join('\n'))
  for (const [i, [shows, problem]] of cases.entries()) expect(said[i], shows).toBe(problem)
  const [twice, tooMany] = said.slice(cases.length)
  expect(twice).toBe(
    'probe.yaml: spec.showsSecrets[1]: Certificate.cert-manager.io’s "spec[\\"secretName\\"]" is said already, in spec.showsSecrets[0]',
  )
  expect(tooMany).toBe('probe.yaml: spec.showsSecrets: holds 11, and a file says 10 at most')
})

/** Lumovi's own plugins, among the files read: the release its lock pins, as the build takes it. */
const PLUGINS = 'plugins'
/** Lumovi's own views, for Kubernetes' kinds that have no page: written as a plugin's are. */
const OWN = 'src/renderer/src/views'

test('what a plugin asks for is read from its file: its kinds, what it reads, each action and what it sends', async ({
  page,
  serve,
}) => {
  await opened(page, serve)
  // Lumovi's own views and plugins, read as plugins.spec reads them: the views' files here and
  // the plugins its release holds, each parsed in the page in turn, with the views read before it
  // as Lumovi's own.
  const shipped = pluginsAndCode(await takePlugins(readLock(), trust())).plugins
  const files = [
    ...readdirSync(OWN)
      .filter((f) => f.endsWith('.yaml'))
      .map((file) => ({ folder: OWN, file, text: readFileSync(join(OWN, file), 'utf8') })),
    ...Object.entries(shipped).map(([file, text]) => ({ folder: PLUGINS, file, text })),
  ]
  const nullsText = [
    'apiVersion: lumovi.dev/v1beta1',
    'kind: Plugin',
    'metadata: { name: nulls }',
    'spec:',
    '  version: 1.0.0',
    '  needs: { lumovi: 1.0.0 }',
    '  groups: [example.com]',
    '  views:',
    '    - kinds: [{ group: example.com, kind: Widget }]',
    '      actions:',
    '        - name: Harmless',
    '          runs: at-once',
    '          patch: { metadata: { labels: { seen: yes, when: "(now)", then: "{{ now }}", mix: "(removed) {{ .spec.x }}", near: "( Now )" } } }',
    '          undo: { spec: { replicas: 0, image: other, note: null } }',
    '        - name: Set',
    '          confirm: Sure?',
    '          type: json',
    '          patch: [{ op: add, path: /spec/note, value: null }]',
    '        - name: Make',
    '          create: { apiVersion: example.com/v1, kind: Widget, metadata: { generateName: w- }, spec: { note: null } }',
  ].join('\n')
  const said = await page.evaluate(
    ([files, own, plugins_, nullsText]) => {
      const { parsePlugin, asks } = (window as unknown as Lent).__lumoviDoor.doorChecks
      const views: Plugin['views'] = []
      const plugins: Plugin[] = []
      for (const { folder, file, text } of files) {
        const parsed = parsePlugin(text, file, {
          ownViews: folder === own,
          carriesCode: folder === plugins_,
          lumovisOwn: views.flatMap((view) => view.kinds),
        })
        if (parsed.plugin) {
          views.push(...parsed.plugin.views)
          if (folder === plugins_) plugins.push(parsed.plugin)
        }
      }
      const of = (name: string) => asks(plugins.find((plugin) => plugin.name === name)!)
      const flux = of('flux')
      const rollouts = of('argo-rollouts')
      const tekton = of('tekton')
      const cnpg = of('cloudnative-pg')
      const certs = of('cert-manager')
      const [made] = parsePlugin(nullsText, 'nulls.yaml').plugin!.views.map((view) => view)
      const nulls = asks({
        ...plugins[0]!,
        views: [made!],
        place: undefined,
        groups: ['example.com'],
        shows: [],
      })
      // And for every one of Lumovi's: what each action is, and sends.
      const every = plugins.flatMap((plugin) =>
        asks(plugin).actions.map((action) => ({
          of: `${plugin.name}: ${action.name}`,
          runs: action.runs,
          sends: action.patch ?? action.creates,
          written: `${action.patch}${action.creates}`,
        })),
      )
      return { flux, rollouts, tekton, cnpg, certs, nulls, every }
    },
    [files, OWN, PLUGINS, nullsText] as const,
  )
  const { flux, rollouts, tekton, cnpg, certs, nulls, every } = said
  expect(flux.kinds).toHaveLength(7)
  expect(flux.kinds).toContain('Kustomization.kustomize.toolkit.fluxcd.io')
  expect(flux.groups).toEqual([
    'kustomize.toolkit.fluxcd.io',
    'helm.toolkit.fluxcd.io',
    'source.toolkit.fluxcd.io',
  ])
  expect(flux.creates).toEqual([])
  // The same action on each of its views is one action, on all their kinds.
  expect(flux.actions.map(({ name }) => name)).toEqual(['Reconcile', 'Suspend', 'Resume'])
  expect(flux.actions.every(({ kinds }) => kinds.length === 7)).toBe(true)
  expect(flux.shows).toEqual([])
  // Every one of its actions says which it is, and what it sends as it's written: what's filled
  // in later is said as what it is, and what a merge patch removes as removed.
  const reconcile = flux.actions.find(({ name }) => name === 'Reconcile')!
  expect(reconcile.runs).toBe('at-once')
  expect(reconcile.patch).toBe(
    'metadata:\n  annotations:\n    reconcile.fluxcd.io/requestedAt: (now)',
  )
  const resume = flux.actions.find(({ name }) => name === 'Resume')!
  expect(resume.patch).toContain('suspend: (removed)')
  // What takes an action back is sent too, later, and is shown with it; and a patch of an
  // object's status says that it is one.
  const suspend = flux.actions.find(({ name }) => name === 'Suspend')!
  expect(suspend.patch).toBe('spec:\n  suspend: true')
  expect(suspend.undo).toBe('spec:\n  suspend: (removed)')
  expect(rollouts.actions.filter(({ status }) => status).map(({ name }) => name)).toEqual([
    'Promote',
    'Abort',
  ])
  expect(flux.actions.every(({ status }) => status === undefined)).toBe(true)
  // One that asks, creates, and takes a choice.
  expect(tekton.creates).toEqual(['PipelineRun.tekton.dev'])
  const run = tekton.actions.find(({ creates }) => creates !== undefined)!
  expect(run.runs).toBe('asks')
  expect(run.creates).toContain('kind: PipelineRun')
  expect(run.creates).toContain('(from the object)')
  // What it lists beside an object, and links to: the kinds its file names.
  expect(cnpg.related.kinds).toContain('Pod')
  expect(certs.links.kinds).toContain('Secret')
  expect(certs.links.templated).toBe(true)
  // A null takes a field away in a merge patch, and is a null anywhere else.
  // A text of the file's own that reads as what Lumovi says of something filled in is quoted:
  // only the real one stands bare.
  expect(nulls.actions[0]!.patch).toContain('when: "(now)"')
  expect(nulls.actions[0]!.patch).toContain('then: (now)')
  expect(nulls.actions[0]!.patch).toContain('mix: "(removed) (from the object)"')
  // (Any parenthesis of the file's own, so a near miss can't pass for one either.)
  expect(nulls.actions[0]!.patch).toContain('near: "( Now )"')
  expect(nulls.actions[0]!.undo).toBe('spec:\n  replicas: 0\n  image: other\n  note: (removed)')
  expect(nulls.actions[1]!.patch).toContain('value: null')
  expect(nulls.actions[1]!.json).toBe(true)
  expect(nulls.actions[0]!.json).toBeUndefined()
  expect(nulls.actions[2]!.creates).toContain('note: null')
  // And for every one of Lumovi's: an action is one or the other, and sends something.
  for (const action of every) {
    expect(['at-once', 'asks'], action.of).toContain(action.runs)
    expect(action.sends, action.of).toBeTruthy()
    expect(action.written, action.of).not.toContain('{{')
  }
})

/** A plugin of Lumovi's own with pages, tabs and commands: `spec` lines go after its kinds. */
const adding = (more: string, place = '  label: Rollouts\n') =>
  `apiVersion: lumovi.dev/v1beta1\nkind: Plugin\nmetadata: { name: rollouts }\nspec:\n  version: 1.0.0\n  needs: { lumovi: 1.0.0 }\n  groups: [example.com]\n${place}  kinds: [{ group: example.com, kind: Rollout }, { group: example.com, kind: Experiment }]\n${more}`

const PAGES =
  '  pages:\n    - { id: overview, title: Overview }\n    - { id: history, title: History }\n'
const TABS =
  '  tabs:\n    - { id: rollout, title: Steps, kinds: [{ group: example.com, kind: Rollout }] }\n'
const COMMANDS = '  commands:\n    - { name: Open the rollouts’ history, page: history }\n'

/** The lines each file is refused with, as `file: where: why`, read in Lumovi's page. */
const refusedWith = async (
  page: Page,
  texts: string[],
  options: ParseOptions = { carriesCode: true },
) =>
  (
    await parsedIn(
      page,
      texts.map((text) => ({ text, source: 'rollouts.yaml', options })),
    )
  ).map(({ problems }) => problems)

test('a plugin of Lumovi’s own adds pages, a tab on its own kinds and commands that open them', async ({
  page,
  serve,
}) => {
  await opened(page, serve)
  const [all, pagesOnly, nothing] = await parsedIn(page, [
    {
      text: adding(PAGES + TABS + COMMANDS),
      source: 'rollouts.yaml',
      options: { carriesCode: true },
    },
    // A plugin of pages alone has its place in the sidebar with no kinds.
    {
      text: `apiVersion: lumovi.dev/v1beta1\nkind: Plugin\nmetadata: { name: board }\nspec:\n  version: 1.0.0\n  needs: { lumovi: 1.0.0 }\n  groups: [example.com]\n  label: Board\n${PAGES}`,
      source: 'board.yaml',
      options: { carriesCode: true },
    },
    // And one that adds nothing says so in what it is.
    { text: adding(''), source: 'rollouts.yaml' },
  ])
  expect(all!.problems).toEqual([])
  expect(all!.plugin!.added).toEqual({
    pages: [
      { id: 'overview', title: 'Overview' },
      { id: 'history', title: 'History' },
    ],
    tabs: [{ id: 'rollout', title: 'Steps', kinds: ['Rollout.example.com'] }],
    commands: [{ name: 'Open the rollouts’ history', page: 'history' }],
  })
  expect(pagesOnly!.problems).toEqual([])
  expect(pagesOnly!.plugin!.place).toEqual({ label: 'Board', kinds: [] })
  expect(nothing!.plugin!.added).toEqual({
    pages: [],
    tabs: [],
    commands: [],
  })
})

test('only a plugin that comes with Lumovi adds to Lumovi’s pages: a folder’s file is refused, whatever it says', async ({
  page,
  serve,
}) => {
  await opened(page, serve)
  // Unsaid, a file may not: whoever reads it must say it may.
  const [refused] = await refusedWith(page, [adding(PAGES + TABS + COMMANDS)], {
    carriesCode: false,
  })
  expect(refused).toEqual([
    'rollouts.yaml: spec.pages: adds pages, tabs or commands, and only the plugins that come with Lumovi can do that yet',
    'rollouts.yaml: spec.tabs: adds pages, tabs or commands, and only the plugins that come with Lumovi can do that yet',
    'rollouts.yaml: spec.commands: adds pages, tabs or commands, and only the plugins that come with Lumovi can do that yet',
  ])
  const [unsaid] = await parsedIn(page, [{ text: adding(PAGES), source: 'rollouts.yaml' }])
  expect(unsaid!.plugin).toBeUndefined()
  // Where it holds: a folder's file, however it's read and whatever its caller passes.
  const settled = await page.evaluate((text) => {
    const { settle } = (window as unknown as Lent).__lumoviDoor.doorChecks
    return (['yours', 'server'] as const).map((origin) => {
      const { files } = settle([], [{ name: 'rollouts.yaml', text }], origin, {
        carriesCode: true,
      })
      return { origin, state: files[0]!.state, problems: files[0]!.problems }
    })
  }, adding(PAGES))
  expect(settled.map(({ origin }) => origin)).toEqual(['yours', 'server'])
  for (const { origin, state, problems } of settled) {
    expect(state, origin).toBe('not-in-use')
    expect(problems, origin).toEqual([
      'rollouts.yaml: spec.pages: adds pages, tabs or commands, and only the plugins that come with Lumovi can do that yet',
    ])
  }
})

test('a plugin’s file as it’s less often written: a tab alone, a version that isn’t text', async ({
  page,
  serve,
}) => {
  await opened(page, serve)
  const version = (written: string) => adding('').replace('version: 1.0.0', `version: ${written}`)
  const [tabAlone, number, listed, otherKind, longKey] = await parsedIn(page, [
    // A tab on its own kind, and no page.
    { text: adding(TABS), source: 'rollouts.yaml', options: { carriesCode: true } },
    // A version YAML reads as a number is quoted as it was written; one that's a list, as data.
    { text: version('1.0'), source: 'rollouts.yaml' },
    { text: version('[1, 0]'), source: 'rollouts.yaml' },
    // A document of another kind.
    {
      text: 'apiVersion: lumovi.dev/v1beta1\nkind: Dashboard\nmetadata: { name: x }\n',
      source: 'x.yaml',
    },
    // A name the file says, past a line's length: cut there.
    { text: `${adding('')}  ${'a'.repeat(450)}: 1\n`, source: 'rollouts.yaml' },
  ])
  expect(tabAlone!.problems).toEqual([])
  expect(tabAlone!.plugin!.added.pages).toEqual([])
  expect(number!.problems).toContain(
    'rollouts.yaml: spec.version: "1.0" should be three numbers, like 1.0.0',
  )
  expect(listed!.problems).toContain(
    'rollouts.yaml: spec.version: [1,0] should be three numbers, like 1.0.0',
  )
  expect(otherKind!.problems).toEqual([
    'x.yaml: should start with apiVersion: lumovi.dev/v1beta1 and kind: Plugin',
  ])
  // (No line about a file is a page long: 400 characters, and then it's cut.)
  const at = 'rollouts.yaml: spec.'
  expect(longKey!.problems).toEqual([`${at}${'a'.repeat(400 - at.length)}…`])
  // A folder's files are settled by their names, in whatever order they came: the first of one
  // plugin's is the same every time.
  const [settled, twice] = await page.evaluate((text) => {
    const { settle } = (window as unknown as Lent).__lumoviDoor.doorChecks
    const named = (name: string) => ({ name, text })
    const files = (names: string[]) =>
      settle([], names.map(named), 'yours').files.map(({ file, state }) => [file, state])
    // (And a name twice, as a folder can't hold but a list could say: still one in use.)
    return [files(['b.yaml', 'a.yaml', 'c.yaml']), files(['a.yaml', 'a.yaml'])]
  }, adding(''))
  expect(settled.map(([file]) => file)).toEqual(['a.yaml', 'b.yaml', 'c.yaml'])
  expect(settled.slice(1).map(([, state]) => state)).toEqual(['not-in-use', 'not-in-use'])
  expect(twice.map(([, state]) => state)).toContain('not-in-use')
})

test('what a plugin adds is written as the format has it, and held to its numbers', async ({
  page,
  serve,
}) => {
  await opened(page, serve)
  const refusals: [string, string][] = [
    // Its place: a label, and Lumovi's own sections are Lumovi's.
    [adding(PAGES, ''), 'rollouts.yaml: spec: pages need a place in the sidebar: give it a label'],
    [
      adding(PAGES, '  label: Rollouts\n  category: network\n'),
      'rollouts.yaml: spec: a plugin with pages of its own stands under Plugins in the sidebar: leave out its category',
    ],
    // The items' shapes.
    [adding('  pages: overview\n'), 'rollouts.yaml: spec.pages: should be a list, not a string'],
    [adding('  pages: []\n'), 'rollouts.yaml: spec.pages: should not be empty'],
    [
      adding('  pages:\n    - { id: overview }\n'),
      'rollouts.yaml: spec.pages[0].title: is required',
    ],
    [
      adding('  pages:\n    - { id: overview, title: Overview, path: /x }\n'),
      'rollouts.yaml: spec.pages[0].path: isn’t something a plugin’s page has',
    ],
    [
      adding(`${PAGES}  tabs:\n    - { id: steps, title: Steps }\n`),
      'rollouts.yaml: spec.tabs[0].kinds: is required',
    ],
    [
      adding(`${PAGES}  commands:\n    - { name: Open it }\n`),
      'rollouts.yaml: spec.commands[0].page: is required',
    ],
    // Ids: a name's rule, once among pages and tabs.
    [
      adding('  pages:\n    - { id: Overview, title: Overview }\n'),
      'rollouts.yaml: spec.pages[0].id: "Overview" should be lowercase letters, digits and hyphens, starting with a letter and ending with a letter or a digit',
    ],
    [
      adding(
        `${PAGES}  tabs:\n    - { id: history, title: Steps, kinds: [{ group: example.com, kind: Rollout }] }\n`,
      ),
      'rollouts.yaml: spec.tabs[0].id: history is already the id of spec.pages[1]',
    ],
    // A tab's kinds: the plugin's own, one tab a kind.
    [
      adding(`${PAGES}  tabs:\n    - { id: pods, title: Steps, kinds: [{ kind: Pod }] }\n`),
      'rollouts.yaml: spec.tabs[0].kinds[0]: a tab is only on the plugin’s own kinds, and Pod is Kubernetes’',
    ],
    [
      adding(
        `${PAGES}  tabs:\n    - { id: theirs, title: Steps, kinds: [{ group: other.example.com, kind: Thing }] }\n`,
      ),
      'rollouts.yaml: spec.tabs[0].kinds[0]: a tab is only on the plugin’s own kinds, and Thing.other.example.com isn’t one it claims',
    ],
    [
      adding(
        `${PAGES}  tabs:\n    - { id: one, title: Steps, kinds: [{ group: example.com, kind: Rollout }] }\n    - { id: two, title: Analysis, kinds: [{ group: example.com, kind: Rollout }] }\n`,
      ),
      'rollouts.yaml: spec.tabs[1].kinds[0]: Rollout.example.com already has a tab of this plugin’s, spec.tabs[0]',
    ],
    // Nor one it only shows: a plugin with views of Endpoints and LimitRanges (Kubernetes' own,
    // which it may show) can't put a tab on them, whatever the door would let its code read.
    [
      adding(
        `${PAGES}  shows: [{ kind: Endpoints }, { kind: LimitRange }]\n  tabs:\n    - { id: ends, title: Steps, kinds: [{ kind: Endpoints }] }\n  views:\n    - kinds: [{ kind: Endpoints }]\n    - kinds: [{ kind: LimitRange }]\n`,
      ),
      'rollouts.yaml: spec.tabs[0].kinds[0]: a tab is only on the plugin’s own kinds, and Endpoints is Kubernetes’',
    ],
    // An object's tabs are found by its kind: a tab names each of its kinds.
    [
      adding(
        `${PAGES}  tabs:\n    - { id: every, title: Steps, kinds: [{ group: example.com, kind: '*' }] }\n`,
      ),
      'rollouts.yaml: spec.tabs[0].kinds[0]: a tab is on kinds named one by one; it can’t be on every kind of a group',
    ],
    // Kubernetes' own names are no plugin's group, so no kind of one is a tab's.
    [
      adding(
        `${PAGES}  tabs:\n    - { id: nodes, title: Steps, kinds: [{ group: x.kubernetes.io, kind: Thing }] }\n`,
      ).replace('groups: [example.com]', 'groups: [example.com, x.kubernetes.io]'),
      'rollouts.yaml: spec.groups[1]: x.kubernetes.io is Kubernetes’ own, so a plugin can’t have it',
    ],
    // A command opens one of its pages, and needs some.
    [
      adding(`${PAGES}  commands:\n    - { name: Open backups, page: backups }\n`),
      'rollouts.yaml: spec.commands[0].page: "backups" isn’t the id of one of the plugin’s pages',
    ],
    [
      adding('  commands:\n    - { name: Open backups, page: backups }\n'),
      'rollouts.yaml: spec.commands: a command opens one of the plugin’s pages, and it has none',
    ],
  ]
  // A view of every kind of a group claims each of them, a tab's too.
  const everyKind = `apiVersion: lumovi.dev/v1beta1\nkind: Plugin\nmetadata: { name: rollouts }\nspec:\n  version: 1.0.0\n  needs: { lumovi: 1.0.0 }\n  groups: [example.com]\n  label: Rollouts\n${PAGES}  tabs:\n    - { id: steps, title: Steps, kinds: [{ group: example.com, kind: Rollout }] }\n  views:\n    - kinds: [{ group: example.com, kind: '*' }]\n`

  // Its numbers: 8 pages, 4 tabs, 12 commands.
  const pages = (n: number) =>
    `  pages:\n${Array.from({ length: n }, (_, i) => `    - { id: p${i}, title: Page ${i} }\n`).join('')}`
  const kinds = Array.from({ length: 5 }, (_, i) => `{ group: example.com, kind: K${i} }`)
  const fiveKinds = adding(
    `${PAGES}  tabs:\n${kinds.map((kind, i) => `    - { id: t${i}, title: Tab ${i}, kinds: [${kind}] }\n`).join('')}`,
    `  label: Rollouts\n  kinds: [${kinds.join(', ')}]\n`,
  ).replace(
    / {2}kinds: \[\{ group: example\.com, kind: Rollout \}, \{ group: example\.com, kind: Experiment \}\]\n/,
    '',
  )
  const commands = (n: number) =>
    `${PAGES}  commands:\n${Array.from({ length: n }, (_, i) => `    - { name: Open page ${i}, page: overview }\n`).join('')}`

  const said = await refusedWith(page, [
    ...refusals.map(([text]) => text),
    everyKind,
    adding(pages(8)),
    adding(pages(9)),
    fiveKinds,
    adding(commands(12)),
    adding(commands(13)),
  ])
  for (const [i, [, line]] of refusals.entries()) expect(said[i], line).toContain(line)
  const [every, eight, nine, five, twelve, thirteen] = said.slice(refusals.length)
  expect(every).toEqual([])
  expect(eight).toEqual([])
  expect(nine).toEqual(['rollouts.yaml: spec.pages: holds 9, and a plugin may add 8 at most'])
  expect(five).toEqual(['rollouts.yaml: spec.tabs: holds 5, and a plugin may add 4 at most'])
  expect(twelve).toEqual([])
  expect(thirteen).toEqual([
    'rollouts.yaml: spec.commands: holds 13, and a plugin may add 12 at most',
  ])
})

test('a plugin’s names for its pages, tabs and commands are plain, its own, and never Lumovi’s', async ({
  page,
  serve,
}) => {
  await opened(page, serve)
  const titled = (title: string) =>
    adding(`  pages:\n    - { id: overview, title: ${JSON.stringify(title)} }\n`)
  const tab = (title: string) =>
    adding(
      `${PAGES}  tabs:\n    - { id: steps, title: ${JSON.stringify(title)}, kinds: [{ group: example.com, kind: Rollout }] }\n`,
    )
  const command = (name: string) =>
    adding(`${PAGES}  commands:\n    - { name: ${JSON.stringify(name)}, page: overview }\n`)
  const cases: [string, string][] = [
    // At most 40 characters; plain; nothing unseen; nothing round it.
    [titled('A'.repeat(40)), ''],
    [titled('A'.repeat(41)), 'spec.pages[0].title: is longer than 40 characters'],
    [titled('Over‮view'), 'spec.pages[0].title: holds a character that can’t be seen (U+202E)'],
    [titled('Over\nview'), 'spec.pages[0].title: holds a character that isn’t text (U+000A)'],
    [titled(' Overview'), 'spec.pages[0].title: should be a name, with nothing round it'],
    // Compared as they read: letters that look alike, and the punctuation at a name's ends.
    [
      tab('ＹＡＭＬ'),
      'spec.tabs[0].title: "ＹＡＭＬ" is a name Lumovi itself uses there, so a person pressing it would expect Lumovi’s',
    ],
    [
      tab('Logs.'),
      'spec.tabs[0].title: "Logs." is a name Lumovi itself uses there, so a person pressing it would expect Lumovi’s',
    ],
    // Nor letters of another alphabet that look like Latin ones, among them.
    [
      tab('YАML'),
      'spec.tabs[0].title: "YАML" mixes letters of two alphabets in one word, so it can look like a word it isn’t',
    ],
    [
      titled('Lumоvi board'),
      'spec.pages[0].title: "Lumоvi board" mixes letters of two alphabets in one word, so it can look like a word it isn’t',
    ],
    // Any of the alphabets drawn alike, Cherokee's as much as Cyrillic's…
    [
      tab('ᎪᏢᏞY'),
      'spec.tabs[0].title: "ᎪᏢᏞY" mixes letters of two alphabets in one word, so it can look like a word it isn’t',
    ],
    // …but not those with nothing drawn alike: Latin beside Han, kanji beside kana.
    [titled('API网关'), ''],
    [titled('概要を見る'), ''],
    // A word wholly in one alphabet is the plugin's to give, beside words in another…
    [titled('Обзор'), ''],
    [titled('Обзор of the toys'), ''],
    // …but one that reads as Lumovi's own name for it is Lumovi's: "Мар", in Cyrillic, is "Map".
    [
      tab('Мар'),
      'spec.tabs[0].title: "Мар" is a name Lumovi itself uses there, so a person pressing it would expect Lumovi’s',
    ],
    [
      titled('ＬＵＭＯＶＩ board'),
      'spec.pages[0].title: "ＬＵＭＯＶＩ board" starts with Lumovi’s own name',
    ],
    // A verb that changes something, in any of its forms, whatever stands after it.
    [
      command('Restarts'),
      'spec.commands[0].name: "Restarts": a command only opens a page: name it after the page',
    ],
    [
      command('Delete‑all'),
      'spec.commands[0].name: "Delete‑all": a command only opens a page: name it after the page',
    ],
    [
      command('Rolling back'),
      'spec.commands[0].name: "Rolling back": a command only opens a page: name it after the page',
    ],
    [command('Rollouts by team'), ''],
    [
      command('Applies config'),
      'spec.commands[0].name: "Applies config": a command only opens a page: name it after the page',
    ],
    // What's done describes a page: "Stopped pods" is a list, not an action.
    [command('Stopped pods'), ''],
    // Never read as an address, and never Lumovi's own name.
    [
      titled('Rollouts/history'),
      'spec.pages[0].title: "Rollouts/history" holds a / or a :, which read as an address',
    ],
    [
      titled('Note: history'),
      'spec.pages[0].title: "Note: history" holds a / or a :, which read as an address',
    ],
    [
      titled('Lumovi history'),
      'spec.pages[0].title: "Lumovi history" starts with Lumovi’s own name',
    ],
    // Not a name Lumovi has in that place, without case or spaces: a page not one of the
    // entry's own tabs, a tab not one Lumovi gives an object, a command not the palette's own.
    [
      titled('all'),
      'spec.pages[0].title: "all" is a name Lumovi itself uses there, so a person pressing it would expect Lumovi’s',
    ],
    [
      titled('Rollouts'),
      'spec.pages[0].title: "Rollouts" is a name Lumovi itself uses there, so a person pressing it would expect Lumovi’s',
    ],
    [
      tab('Y A M L'),
      'spec.tabs[0].title: "Y A M L" is a name Lumovi itself uses there, so a person pressing it would expect Lumovi’s',
    ],
    [
      tab('events'),
      'spec.tabs[0].title: "events" is a name Lumovi itself uses there, so a person pressing it would expect Lumovi’s',
    ],
    [
      command('deployments'),
      'spec.commands[0].name: "deployments" is a name Lumovi itself uses there, so a person pressing it would expect Lumovi’s',
    ],
    [
      command('All plugins'),
      'spec.commands[0].name: "All plugins" is a name Lumovi itself uses there, so a person pressing it would expect Lumovi’s',
    ],
    // A command only opens a page, and its name doesn't say it changes something.
    [
      command('Restart the rollout'),
      'spec.commands[0].name: "Restart the rollout": a command only opens a page: name it after the page',
    ],
    [
      command('Sync'),
      'spec.commands[0].name: "Sync": a command only opens a page: name it after the page',
    ],
    [command('Open the sync history'), ''],
    // A tab may say what Lumovi's tab says elsewhere in it: "Overview" is a page's name here.
    [titled('Overview'), ''],
  ]
  const more = [
    // What can't be seen is said once, where every text of the file is checked.
    titled('Over\u200Dview'),
    // No two of its pages, its tabs or its commands with one name.
    adding('  pages:\n    - { id: a, title: History }\n    - { id: b, title: history }\n'),
    // And names an object answers to are names like any other: an id, a group, a page.
    adding(
      `  pages:\n    - { id: __proto__, title: History }\n  commands:\n    - { name: Open it, page: constructor }\n`,
    ),
    adding(
      `${PAGES}  tabs:\n    - { id: steps, title: Steps, kinds: [{ group: __proto__, kind: Rollout }] }\n`,
    ),
  ]
  const said = await refusedWith(page, [...cases.map(([text]) => text), ...more])
  for (const [i, [text, line]] of cases.entries()) {
    if (line === '') expect(said[i], text).toEqual([])
    else expect(said[i], text).toContain(`rollouts.yaml: ${line}`)
  }
  const [unseen, twice, objects, group] = said.slice(cases.length)
  expect(unseen).toEqual([
    'rollouts.yaml: spec.pages[0].title: holds a character that can’t be seen (U+200D)',
  ])
  expect(twice).toEqual([
    'rollouts.yaml: spec.pages[1].title: "history" is already the name of spec.pages[0]',
  ])
  expect(objects).toEqual([
    'rollouts.yaml: spec.pages[0].id: "__proto__" should be lowercase letters, digits and hyphens, starting with a letter and ending with a letter or a digit',
    'rollouts.yaml: spec.commands[0].page: "constructor" isn’t the id of one of the plugin’s pages',
  ])
  expect(group!.length).toBeGreaterThan(0)
})

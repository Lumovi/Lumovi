/**
 * Fields a view withholds (src/shared/withheld.ts): what a file may withhold and how it's said,
 * how an object goes out without them (failing closed: of each item of a list, a value of
 * another shape taken out whole, nothing changed where there's nothing), what a patch may not
 * touch, and that every file's views together say what's withheld of a kind, each only adding.
 * Plain data and plain functions: nothing is built.
 */
import { expect, test } from '../temp-folders.ts'
import { parsePlugin, WITHHOLDS_MOST } from '../../src/shared/plugins.ts'
import {
  groupsNamed,
  patchTouches,
  shownPath,
  unreadSaid,
  withhold,
  withheldKinds,
  withheldSaid,
} from '../../src/shared/withheld.ts'

const SECRET = 'AKIA-NEVER-SHOWN'
const REPORT = 'ExposedSecretReport.aquasecurity.github.io'
const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration'

/** A plugin file of one view of Trivy's reports, with `view` added to it. */
const scanner = (
  view: string,
  {
    name = 'scanner',
    kinds = '[{ group: aquasecurity.github.io, kind: ExposedSecretReport }]',
    top = '',
  } = {},
) =>
  [
    'apiVersion: lumovi.dev/v1beta1',
    'kind: Plugin',
    `metadata: { name: ${name} }`,
    'spec:',
    '  version: 1.0.0',
    '  needs: { lumovi: 1.0.0 }',
    '  groups: [aquasecurity.github.io]',
    top,
    '  views:',
    `    - kinds: ${kinds}`,
    view,
  ]
    .filter(Boolean)
    .join('\n')

const read = (text: string, file = 'scanner.yaml') => parsePlugin(text, file, { carriesCode: true })

/** One finding of a report, as Trivy writes it. */
const finding = (i: number) => ({
  ruleID: `rule-${i}`,
  severity: 'HIGH',
  title: 'AWS Access Key ID',
  target: '/app/config.env',
  match: `KEY=${SECRET}-${i}`,
})

const report = (secrets: unknown) => ({
  apiVersion: 'aquasecurity.github.io/v1alpha1',
  kind: 'ExposedSecretReport',
  metadata: { name: 'r', namespace: 'shop', labels: { app: 'shop' } },
  report: { summary: { highCount: 1 }, secrets },
})

const MATCH = [{ keys: ['report', 'secrets', 'match'] }]

test('a view withholds fields of its own kinds, each a path of field names with what it says of it', () => {
  const { plugin, problems } = read(
    scanner(
      '      withholds:\n        - { path: report.secrets.match, why: The line around a secret Trivy found. }\n        - path: report.artifact',
    ),
  )
  expect(problems).toEqual([])
  expect(plugin!.views[0]!.withholds).toEqual([
    {
      path: 'report.secrets.match',
      keys: ['report', 'secrets', 'match'],
      why: 'The line around a secret Trivy found.',
    },
    { path: 'report.artifact', keys: ['report', 'artifact'] },
  ])
  // A key with dots is one field, written as `reads` writes one.
  expect(
    read(
      scanner('      withholds: [{ path: "spec[\'a.b\'].c" }, { path: spec.x\\.y }]'),
    ).plugin!.views[0]!.withholds!.map(({ keys }) => keys),
  ).toEqual([
    ['spec', 'a.b', 'c'],
    ['spec', 'x.y'],
  ])
  // A why with nothing in it is no why.
  expect(
    read(scanner("      withholds: [{ path: report.artifact, why: '  ' }]")).plugin!.views[0]!
      .withholds,
  ).toEqual([{ path: 'report.artifact', keys: ['report', 'artifact'] }])
})

test('a path that isn’t field names, or names what Lumovi tells of every object, refuses the whole file', () => {
  const refused = (paths: string[]) =>
    read(
      scanner(
        `      withholds: [${paths.map((path) => `{ path: ${JSON.stringify(path)} }`).join(', ')}]`,
      ),
    )
  const cases: [string, string][] = [
    // Not field names: a typo can't withhold nothing, unsaid.
    ['report.secrets[0].match', 'should be field names, like report.secrets.match'],
    ['report.secrets[*].match', 'should be field names, like report.secrets.match'],
    ['report.secrets[?(@.severity=="HIGH")]', 'should be field names, like report.secrets.match'],
    ['report..match', 'should be field names, like report.secrets.match'],
    ['.report.secrets', 'should be field names, like report.secrets.match'],
    [' report.secrets', 'should be field names, like report.secrets.match'],
    ['report.*', 'should be field names, like report.secrets.match'],
    ['', 'should be field names, like report.secrets.match'],
    // A step that's a number: a patch would read it as an item of a list, and reach it unseen.
    ['report.0.match', 'a step of a withheld path is a field’s name, not a number'],
    ['report.secrets.12', 'a step of a withheld path is a field’s name, not a number'],
    ['x'.repeat(254), 'should be field names, like report.secrets.match'],
    // What every object says of itself, and how it is.
    ['metadata.annotations', 'is what every object says of itself, which Lumovi always shows'],
    ['metadata', 'is what every object says of itself, which Lumovi always shows'],
    ['kind', 'is what every object says of itself, which Lumovi always shows'],
    ['apiVersion', 'is what every object says of itself, which Lumovi always shows'],
    // Its status, all of it: what Lumovi says of an object is read from there.
    ...[
      'status',
      'status.conditions',
      'status.conditions.message',
      'status.health.status',
      'status.phase',
    ].map((path): [string, string] => [
      path,
      'is under status, which says how the object is: Lumovi always shows it',
    ]),
  ]
  for (const [path, why] of cases) {
    const { plugin, problems } = refused([path])
    expect(plugin, path).toBeUndefined()
    expect(problems.join('\n'), path).toContain(`spec.views[0].withholds[0].path:`)
    expect(problems.join('\n'), path).toContain(why)
  }
  // A field named status elsewhere is no object's status.
  expect(refused(['report.status']).problems).toEqual([])
  // Said twice, however it's spelt.
  expect(refused(['report.secrets', "report['secrets']"]).problems).toEqual([
    'scanner.yaml: spec.views[0].withholds[1].path: "report[\'secrets\']" is said already, in withholds[0]',
  ])
  // At most so many, and at least one.
  const many = Array.from({ length: WITHHOLDS_MOST + 1 }, (_, i) => `report.f${i}`)
  expect(refused(many).problems.join('\n')).toContain(`holds ${WITHHOLDS_MOST + 1}`)
  expect(refused(many.slice(1)).problems).toEqual([])
  expect(read(scanner('      withholds: []')).problems.join('\n')).toContain('withholds')
  // Nothing else is said of a field withheld; and what it says of it is a sentence's length.
  expect(
    read(scanner('      withholds: [{ path: report.artifact, shown: false }]')).problems.join('\n'),
  ).toContain('withholds[0].shown: isn’t something a view has')
  expect(
    read(
      scanner(`      withholds: [{ path: report.artifact, why: ${'w'.repeat(501)} }]`),
    ).problems.join('\n'),
  ).toContain('withholds[0].why: is longer than 500 characters')
  expect(
    read(scanner('      withholds: [{ path: report.artifact, why: "a\\u202eb" }]')).problems.join(
      '\n',
    ),
  ).toContain('can’t be seen')
})

test('a view withholds fields of its plugin’s own kinds alone, each named: never Kubernetes’', () => {
  const problems = (kinds: string, top = '') =>
    read(scanner('      withholds: [{ path: spec.x }]', { kinds, top })).problems
  expect(problems('[{ group: aquasecurity.github.io, kind: "*" }]')).toEqual([
    'scanner.yaml: spec.views[0].withholds: a view withholds fields of kinds named one by one, never every kind of a group',
  ])
  // One of Kubernetes' own that it only shows.
  expect(
    problems(
      '[{ group: storage.k8s.io, kind: CSIDriver }]',
      '  shows: [{ group: storage.k8s.io, kind: CSIDriver }]',
    ),
  ).toEqual([
    'scanner.yaml: spec.views[0].withholds: a view withholds fields of its plugin’s own kinds alone, and CSIDriver.storage.k8s.io is Kubernetes’',
  ])
  // And never in Lumovi's own views of Kubernetes' kinds, which are no plugin's.
  const own = parsePlugin(
    [
      'apiVersion: lumovi.dev/v1beta1',
      'kind: Plugin',
      'metadata: { name: kinds-of-kubernetes }',
      'spec:',
      '  version: 1.0.0',
      '  needs: { lumovi: 1.0.0 }',
      '  views:',
      '    - kinds: [{ group: storage.k8s.io, kind: CSIDriver }]',
      '      withholds: [{ path: spec.x }]',
    ].join('\n'),
    'kubernetes.yaml',
    { ownViews: true },
  )
  expect(own.problems.join('\n')).toContain('and CSIDriver.storage.k8s.io is Kubernetes’')
})

test('what’s withheld goes, at any depth, of each item of a list, and nothing else does', () => {
  const object = report([finding(1), finding(2)])
  const before = JSON.stringify(object)
  const out = withhold(object, MATCH)
  expect(JSON.stringify(out)).not.toContain(SECRET)
  expect(out.report.secrets).toEqual([
    { ruleID: 'rule-1', severity: 'HIGH', title: 'AWS Access Key ID', target: '/app/config.env' },
    { ruleID: 'rule-2', severity: 'HIGH', title: 'AWS Access Key ID', target: '/app/config.env' },
  ])
  expect(out.report.summary).toEqual({ highCount: 1 })
  expect(out.metadata).toEqual(object.metadata)
  // The object read is never changed: a cache of it keeps what it had.
  expect(JSON.stringify(object)).toBe(before)
  // A list of a thousand.
  const thousand = withhold(report(Array.from({ length: 1000 }, (_, i) => finding(i))), MATCH)
  expect(thousand.report.secrets as unknown[]).toHaveLength(1000)
  expect(JSON.stringify(thousand)).not.toContain(SECRET)
  // Lists in lists, each item of each.
  expect(
    JSON.stringify(withhold(report([[finding(1)], [finding(2), [finding(3)]]]), MATCH)),
  ).not.toContain(SECRET)
  // Deeper, through maps.
  const deep = { spec: { a: { b: { c: { d: SECRET, e: 1 } } } } }
  expect(withhold(deep, [{ keys: ['spec', 'a', 'b', 'c', 'd'] }])).toEqual({
    spec: { a: { b: { c: { e: 1 } } } },
  })
  // A whole map.
  expect(withhold(deep, [{ keys: ['spec', 'a'] }])).toEqual({ spec: {} })
  // Several fields.
  expect(
    withhold({ spec: { a: 1, b: 2, c: 3 } }, [{ keys: ['spec', 'a'] }, { keys: ['spec', 'c'] }]),
  ).toEqual({ spec: { b: 2 } })
})

test('where a step finds another shape, the value there goes whole: in a list, the item alone', () => {
  // A string where a map was looked for: what holds it goes, at the deepest step reached.
  expect(withhold(report(`KEY=${SECRET}`), MATCH)).toEqual({
    ...report(undefined),
    report: { summary: { highCount: 1 } },
  })
  expect(withhold({ report: SECRET }, MATCH)).toEqual({})
  expect(withhold({ report: 7 }, MATCH)).toEqual({})
  expect(withhold({ report: true }, MATCH)).toEqual({})
  // In a list, each odd item alone: null in its place, the others kept as they are.
  const mixed = withhold(report([finding(1), `KEY=${SECRET}`, 42, finding(2), null]), MATCH)
  expect(JSON.stringify(mixed)).not.toContain(SECRET)
  expect(mixed.report.secrets).toEqual([
    { ruleID: 'rule-1', severity: 'HIGH', title: 'AWS Access Key ID', target: '/app/config.env' },
    null,
    null,
    { ruleID: 'rule-2', severity: 'HIGH', title: 'AWS Access Key ID', target: '/app/config.env' },
    null,
  ])
  // The field itself, whatever it holds, goes whole.
  for (const match of [{ line: SECRET }, [SECRET], SECRET, 1, null]) {
    expect(JSON.stringify(withhold(report([{ ...finding(1), match }]), MATCH))).not.toContain(
      'match',
    )
  }
})

test('where there’s nothing to withhold, the object goes out as it is: the very object', () => {
  for (const object of [
    report([]),
    report([{ ruleID: 'x' }]),
    report(null),
    { report: null },
    { report: {} },
    { spec: {} },
    { metadata: { name: 'x' } },
  ]) {
    expect(withhold(object, MATCH)).toBe(object)
  }
  const object = report([finding(1)])
  expect(withhold(object, [])).toBe(object)
})

test('the annotation kubectl keeps an object in goes too, the rest of the metadata stays', () => {
  const applied = {
    ...report([finding(1)]),
    metadata: {
      name: 'r',
      annotations: { [LAST_APPLIED]: JSON.stringify(report([finding(1)])), note: 'kept' },
    },
  }
  const out = withhold(applied, MATCH)
  expect(JSON.stringify(out)).not.toContain(SECRET)
  expect(out.metadata).toEqual({ name: 'r', annotations: { note: 'kept' } })
  // (Even where nothing else was there to withhold: it can hold any field.)
  const only = { metadata: { name: 'r', annotations: { [LAST_APPLIED]: SECRET } } }
  expect(withhold(only, MATCH)).toEqual({ metadata: { name: 'r', annotations: {} } })
})

test('a patch that writes, blanks or reads a withheld field is refused; one of other fields isn’t', () => {
  const touches = (type: string, patch: unknown) => patchTouches(type, patch, MATCH)
  // Labels, annotations and other fields: as before.
  expect(touches('merge', { metadata: { labels: { team: 'a' } } })).toBe(false)
  expect(touches('strategic', { metadata: { annotations: { note: 'x' } } })).toBe(false)
  expect(touches('merge', { report: { summary: { highCount: 2 } } })).toBe(false)
  expect(touches('json', [{ op: 'add', path: '/metadata/labels/team', value: 'a' }])).toBe(false)
  expect(touches('json', [{ op: 'replace', path: '/report/secrets/0/ruleID', value: 'b' }])).toBe(
    false,
  )
  // Written, or blanked by writing what holds it.
  expect(touches('merge', { report: { secrets: [{ match: '' }] } })).toBe(true)
  expect(touches('merge', { report: { secrets: null } })).toBe(true)
  expect(touches('merge', { report: null })).toBe(true)
  expect(touches('merge', { report: 'x' })).toBe(true)
  expect(touches('strategic', { report: { $patch: 'replace' } })).toBe(true)
  expect(touches('strategic', { $retainKeys: ['metadata'] })).toBe(true)
  expect(touches('json', [{ op: 'replace', path: '/report/secrets/0/match', value: 'x' }])).toBe(
    true,
  )
  expect(touches('json', [{ op: 'remove', path: '/report/secrets' }])).toBe(true)
  expect(touches('json', [{ op: 'replace', path: '', value: {} }])).toBe(true)
  expect(touches('json', [{ op: 'add', path: '/report/secrets/-', value: { match: 'x' } }])).toBe(
    true,
  )
  // Read: copied or moved where it shows, or tested a guess at a time.
  expect(
    touches('json', [
      { op: 'copy', from: '/report/secrets/0/match', path: '/metadata/annotations/x' },
    ]),
  ).toBe(true)
  expect(touches('json', [{ op: 'move', from: '/report', path: '/metadata/annotations/x' }])).toBe(
    true,
  )
  expect(touches('json', [{ op: 'test', path: '/report/secrets/0/match', value: 'KEY' }])).toBe(
    true,
  )
  // A copy, a move and a test read wherever they are: each is refused, whatever its paths. But
  // the test of the object's version that Lumovi sends with a change, alone.
  const LAST = '/metadata/annotations/kubectl.kubernetes.io~1last-applied-configuration'
  for (const op of [
    { op: 'copy', from: LAST, path: '/metadata/labels/x' },
    { op: 'copy', from: '/metadata/annotations', path: '/spec/note' },
    { op: 'move', from: '/metadata', path: '/spec/note' },
    { op: 'copy', from: '/metadata/labels/a', path: '/metadata/labels/b' },
    { op: 'test', path: LAST, value: '{' },
    { op: 'test', path: '/metadata/labels/a', value: 'b' },
    { op: 'test', path: '/metadata/resourceVersion', from: '/report', value: '1' },
    { op: 'bend', path: '/metadata/labels/a' },
    { path: '/metadata/labels/a', value: 'b' },
    { op: 'add', from: '/report', path: '/metadata/labels/a' },
  ]) {
    expect(touches('json', [op]), JSON.stringify(op)).toBe(true)
  }
  expect(
    touches('json', [
      { op: 'test', path: '/metadata/resourceVersion', value: '7534' },
      { op: 'add', path: '/metadata/labels/team', value: 'a' },
      { op: 'remove', path: '/metadata/labels/old' },
    ]),
  ).toBe(false)
  // kubectl's annotation holds every field: written, blanked, or what holds it written, refused;
  // and the same by a merge patch. Other annotations, as before.
  for (const path of [LAST, '/metadata/annotations', '/metadata', '']) {
    expect(touches('json', [{ op: 'replace', path, value: {} }]), path).toBe(true)
    expect(touches('json', [{ op: 'remove', path }]), path).toBe(true)
  }
  expect(touches('json', [{ op: 'add', path: '/metadata/annotations/note', value: 'x' }])).toBe(
    false,
  )
  for (const patch of [
    { metadata: { annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{}' } } },
    { metadata: { annotations: null } },
    { metadata: null },
    { metadata: { $patch: 'replace', labels: {} } },
  ]) {
    expect(touches('merge', patch), JSON.stringify(patch)).toBe(true)
  }
  // An escaped key is the same key.
  expect(touches('json', [{ op: 'remove', path: '/re~1port' }])).toBe(false)
  expect(patchTouches('json', [{ op: 'remove', path: '/a~1b' }], [{ keys: ['a/b'] }])).toBe(true)
  // What can't be read as a patch is refused.
  expect(touches('json', { op: 'remove' })).toBe(true)
  expect(touches('json', ['x'])).toBe(true)
  expect(touches('json', [{ op: 'remove', path: 7 }])).toBe(true)
  // Nothing withheld: nothing refused.
  expect(patchTouches('merge', { report: null }, [])).toBe(false)
})

test('a file that doesn’t read whole may withhold fields of the groups it names: of any, where it names none', () => {
  // Refused for a key this Lumovi doesn't know: its groups, and every kind's.
  expect(
    groupsNamed(
      scanner('      withholds: [{ path: report.secrets.match }]\n      colour: blue', {
        top: '  links: [{ group: example.com, kind: Thing }]',
      }),
    ),
  ).toEqual(['aquasecurity.github.io', 'example.com'])
  // Only kinds' groups, the groups misspelt.
  expect(
    groupsNamed('spec:\n  groups: oops\n  views: [{ kinds: [{ group: a.example, kind: A }] }]'),
  ).toEqual(['a.example', 'oops'])
  // Not YAML, or naming no group (or only the core one): any.
  for (const text of [
    'spec: [',
    'a: *nowhere',
    '',
    'spec:\n  views: [{ kinds: [{ kind: Pod }] }]',
    "spec:\n  groups: ['']",
  ]) {
    expect(groupsNamed(text), JSON.stringify(text)).toBeUndefined()
  }
  expect(unreadSaid('my‮reports.yaml')).toBe(
    'This can’t be shown: myU+202Ereports.yaml doesn’t read, and it may withhold fields of it.',
  )
})

test('a withheld field is said as Lumovi reads it: [] where the object has a list', () => {
  const keys = ['report', 'secrets', 'match']
  expect(shownPath(keys, withhold(report([finding(1)]), MATCH))).toBe('report.secrets[].match')
  expect(shownPath(keys)).toBe('report.secrets.match')
  expect(shownPath(keys, report('x'))).toBe('report.secrets.match')
  expect(shownPath(['spec', 'a.b', 'c'], { spec: { 'a.b': [{ c: 1 }] } })).toBe('spec["a.b"][].c')
  expect(withheldSaid('report.secrets[].match', 'trivy-operator')).toBe(
    'Lumovi doesn’t show report.secrets[].match here: trivy-operator’s file withholds it.',
  )
})

test('what’s withheld of a kind is what every file’s views say of it: a view can only add', () => {
  const first = read(
    scanner('      withholds: [{ path: report.secrets.match, why: The line around it. }]'),
  ).plugin!
  // Another file, shown after it, of the same kind: nothing withheld.
  const later = read(
    scanner('      columns: [{ name: Target, path: .report.artifact }]', { name: 'later' }),
    'later.yaml',
  ).plugin!
  // A third, adding a field of its own (and saying the first's again).
  const more = read(
    scanner('      withholds: [{ path: report.artifact }, { path: report.secrets.match }]', {
      name: 'more',
    }),
    'more.yaml',
  ).plugin!
  expect(withheldKinds([first, later]).get(REPORT)).toEqual([
    { keys: ['report', 'secrets', 'match'], plugin: 'scanner', why: 'The line around it.' },
  ])
  expect(withheldKinds([later, first]).get(REPORT)).toEqual(
    withheldKinds([first, later]).get(REPORT),
  )
  expect(withheldKinds([later]).get(REPORT)).toBeUndefined()
  expect(withheldKinds([first, later, more]).get(REPORT)).toEqual([
    { keys: ['report', 'secrets', 'match'], plugin: 'scanner', why: 'The line around it.' },
    { keys: ['report', 'artifact'], plugin: 'more' },
    { keys: ['report', 'secrets', 'match'], plugin: 'more' },
  ])
  // The same file twice says it once.
  expect(withheldKinds([first, first]).get(REPORT)).toHaveLength(1)
})

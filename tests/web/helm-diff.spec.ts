/**
 * What a Helm rollback's dialog shows of what it changes (src/renderer/src/lib/helm-diff.ts): a
 * Secret's values masked line for line, the values by key alone, and what Helm did after a failure.
 */
import { expect, test } from '../temp-folders.ts'
import { MASK, maskedManifest, undoneBy, valueKeys } from '../../src/renderer/src/lib/helm-diff.ts'

const MANIFEST = `---
# Source: api/templates/secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: api-db
  annotations:
    kubectl.kubernetes.io/last-applied-configuration: '{"data":{"password":"c2VjcmV0"}}'
type: Opaque
data:
  password: c2VjcmV0
  "user.name": YWRtaW4=
stringData:
  config.yaml: |
    token: hunter2
    url: https://db
  empty:
---
# Source: api/templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  template:
    spec:
      containers:
        - name: api
          image: ghcr.io/acme/api:2.4.2
          env:
            - name: data
              value: shown
`

test('a Secret’s data, stringData and last-applied annotation are masked, line for line; nothing else is', () => {
  const masked = maskedManifest(MANIFEST)
  const lines = masked.split('\n')
  // Line for line: a diff of the real text can be shown through it.
  expect(lines).toHaveLength(MANIFEST.split('\n').length)
  expect(masked).not.toContain('c2VjcmV0')
  expect(masked).not.toContain('YWRtaW4=')
  expect(masked).not.toContain('hunter2')
  expect(masked).not.toContain('https://db')
  expect(lines).toContain(`  password: ${MASK}`)
  expect(lines).toContain(`  "user.name": ${MASK}`)
  expect(lines).toContain(`    kubectl.kubernetes.io/last-applied-configuration: ${MASK}`)
  // A block scalar's key stays, its lines are masked; an empty one stays as it is.
  expect(lines).toContain('  config.yaml: |')
  expect(lines).toContain(`    ${MASK}`)
  expect(lines).toContain('  empty:')
  // The Secret's own fields, and a Deployment's (its `data` env var too), are as they were.
  expect(lines).toContain('  name: api-db')
  expect(lines).toContain('type: Opaque')
  expect(masked).toContain('image: ghcr.io/acme/api:2.4.2')
  expect(masked).toContain('            - name: data')
  expect(masked).toContain('              value: shown')
})

/**
 * No value's text anywhere in what's shown, and the same lines, each where it was. (Said yes or
 * no, by which: a failure prints no value.)
 */
function hidden(manifest: string, values: string[]) {
  const masked = maskedManifest(manifest)
  expect(masked.split('\n')).toHaveLength(manifest.split('\n').length)
  values.forEach((value, i) => expect(masked.includes(value), `value ${i + 1} shown`).toBe(false))
  return masked
}

test('a Secret written in any style is masked: where its lines can’t be masked one by one, the whole document is, but for what names it', () => {
  // Flow style, as `data: {{ .Values.secrets | toJson }}` renders it.
  const flow = hidden(
    `---
# Source: api/templates/secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: api-db
  namespace: shop
data: {password: c2VjcmV0, "user": YWRtaW4=}
`,
    ['c2VjcmV0', 'YWRtaW4='],
  )
  // What names it is kept.
  expect(flow).toContain('# Source: api/templates/secret.yaml')
  expect(flow).toContain('kind: Secret')
  expect(flow).toContain('  name: api-db')
  expect(flow).toContain('  namespace: shop')
  // A JSON document, as a template can render one, on one line.
  hidden(
    `---
{"apiVersion":"v1","kind":"Secret","metadata":{"name":"api-db"},"data":{"password":"c2VjcmV0"}}
`,
    ['c2VjcmV0'],
  )
  // A Secret among a List's items: its kind line indented.
  hidden(
    `---
apiVersion: v1
kind: List
items:
  - apiVersion: v1
    kind: Secret
    metadata:
      name: api-db
    data:
      password: c2VjcmV0
`,
    ['c2VjcmV0'],
  )
  // Its kind's key quoted.
  hidden(
    `---
apiVersion: v1
"kind": Secret
metadata:
  name: api-db
data:
  password: c2VjcmV0
`,
    ['c2VjcmV0'],
  )
  // Its data tagged.
  hidden(
    `---
apiVersion: v1
kind: Secret
metadata:
  name: api-db
data: !!map
  password: c2VjcmV0
`,
    ['c2VjcmV0'],
  )
  // A block scalar under stringData: masked line by line, its key kept.
  const block = hidden(
    `---
apiVersion: v1
kind: Secret
metadata:
  name: api-config
stringData:
  config.yaml: |
    token: hunter2
    url: https://db.internal
`,
    ['hunter2', 'https://db.internal'],
  )
  expect(block).toContain('  config.yaml: |')
})

test('a value aliased into a Secret from elsewhere in its document masks the document whole, but for what names it', () => {
  // Merged into its data from a map beside it.
  const merged = hidden(
    `---
apiVersion: v1
kind: Secret
metadata:
  name: a
base: &b
  k: SECRETVALUE
data:
  <<: *b
`,
    ['SECRETVALUE'],
  )
  expect(merged).toContain('kind: Secret')
  expect(merged).toContain('  name: a')
  // Anchored in a label, named in its data.
  hidden(
    `---
apiVersion: v1
kind: Secret
metadata:
  name: a
  labels:
    x: &v SECRETVALUE
data:
  k: *v
`,
    ['SECRETVALUE'],
  )
  // A document with no Secret keeps its aliases, as it was.
  const plain = `---
apiVersion: v1
kind: ConfigMap
metadata:
  name: c
  labels:
    x: &v shown
data:
  k: *v
`
  expect(maskedManifest(plain)).toBe(plain)
})

test('a document that can’t be read is masked whole, but for what names it', () => {
  const masked = hidden(
    `---
apiVersion: v1
kind: Secret
metadata:
  name: api-db
data:
  password: c2VjcmV0
  broken: [unclosed
`,
    ['c2VjcmV0', 'unclosed'],
  )
  expect(masked).toContain('kind: Secret')
  expect(masked).toContain('  name: api-db')
})

test('a manifest without a Secret is as it was', () => {
  const plain = MANIFEST.split('---\n# Source: api/templates/deployment.yaml')[1]!
  expect(maskedManifest(plain)).toBe(plain)
})

test('the values a rollback changes, by key alone: changed, added and removed, as --set writes them', () => {
  const running = {
    image: { tag: '2.4.2' },
    replicaCount: 3,
    resources: { limits: { memory: '512Mi' } },
    database: { password: 'old' },
    metrics: { enabled: true },
    ingress: { hosts: [{ host: 'a.example' }] },
  }
  const back = {
    image: { tag: '2.4.0' },
    replicaCount: 3,
    resources: { limits: { memory: '384Mi' } },
    database: { password: 'older' },
    ingress: { hosts: [{ host: 'b.example' }, { host: 'c.example' }] },
    debug: false,
  }
  const keys = valueKeys(running, back)
  expect(keys).toEqual({
    changed: ['image.tag', 'resources.limits.memory', 'database.password', 'ingress.hosts[0].host'],
    added: ['ingress.hosts[1].host', 'debug'],
    removed: ['metrics.enabled'],
  })
  // Never a value.
  expect(JSON.stringify(keys)).not.toMatch(/old|2\.4|Mi|example/)
  expect(valueKeys(running, running)).toEqual({ changed: [], added: [], removed: [] })
})

test('what Helm did after a failure, where its message says so', () => {
  expect(
    undoneBy(
      'UPGRADE FAILED: release payments-api failed, and has been rolled back due to rollback-on-failure being set: context deadline exceeded',
    ),
  ).toBe('rolled-back')
  expect(
    undoneBy(
      'INSTALLATION FAILED: release orders failed, and has been uninstalled due to rollback-on-failure being set: context deadline exceeded',
    ),
  ).toBe('uninstalled')
  expect(undoneBy('UPGRADE FAILED: another operation is in progress')).toBeUndefined()
})

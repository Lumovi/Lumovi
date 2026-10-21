/**
 * Names and namespaces of one object, as every call that takes one is asked them, on the desktop
 * and on a server (object-names.spec.ts in each): what Kubernetes wouldn't accept is refused in
 * Lumovi's words before the cluster is asked anything, and the longest and oddest it does accept
 * are read, changed and deleted as any other.
 */
import type { Page } from '@playwright/test'
import type { KubeObject } from '../mock-cluster/types.ts'

/**
 * Names no kind of object can have: a path that's the list or what's above it, more than one
 * segment of one, none at all, longer than any kind takes, with a line break, or with what can't
 * be seen.
 */
export const NOT_NAMES = [
  '.',
  '..',
  'a/b',
  'a%2Fb',
  '',
  'n'.repeat(254),
  'line\nbreak',
  'line\u2028break',
  'zero\u200bwidth',
]

/** Namespaces Kubernetes wouldn't accept: as names aren't, and capitals, an edge's dash, 64 long. */
export const NOT_NAMESPACES = ['.', '..', 'a/b', '', 'Batch', '-batch', 'n'.repeat(64)]

/** A name no object has: what a call asked with a namespace that isn't one would ask the cluster. */
export const NOBODY = 'nobody-here'

/** Where a call asked with a name that isn't one would ask the cluster: a namespace nothing reads. */
export const WHERE = 'batch'

/** Each call that takes one object's name, or a namespace: what it's called here. */
export type Call =
  | 'get'
  | 'certificates'
  | 'history'
  | 'patch'
  | 'delete'
  | 'logs'
  | 'shell'
  | 'attach'
  | 'download'
  | 'metrics source'
  | 'forward'
  | 'node shell'
  | 'local shell'
  | 'list'
  | 'watch'

/** The calls a server has: a port on this computer, and a shell on it, are the desktop's. */
export const SERVER_CALLS: Call[] = [
  'get',
  'certificates',
  'history',
  'patch',
  'delete',
  'logs',
  'shell',
  'attach',
  'download',
  'metrics source',
  'node shell',
  'list',
  'watch',
]
export const DESKTOP_CALLS: Call[] = [...SERVER_CALLS, 'forward', 'local shell']

/** Which calls take a name (a pod's, a node's, a Service's…), and which a namespace. */
export const TAKES_NAME: Call[] = DESKTOP_CALLS.filter(
  (call) => !['local shell', 'list', 'watch'].includes(call),
)
export const TAKES_NAMESPACE: Call[] = DESKTOP_CALLS.filter((call) => call !== 'node shell')

/** What a call says, as "ok" or its code and words: made in the page, as the page would. */
export const asked = (page: Page, call: Call, name: string, namespace: string) =>
  page.evaluate(
    async ({ call, name, namespace }) => {
      // (Said in full here: what runs in the page takes nothing of this file with it.)
      const api = (
        window as unknown as {
          lumovi: Record<string, Record<string, (...args: unknown[]) => unknown>>
        }
      ).lumovi
      const id = `names-${Math.random().toString(36).slice(2, 12)}`
      const context = 'demo'
      const answer = (await (() => {
        switch (call) {
          case 'get':
            return api.kube!.get!({ context, kind: 'Secret', namespace, name })
          case 'certificates':
            return api.kube!.certificates!({ context, namespace, name })
          case 'history':
            return api.kube!.history!({ context, kind: 'Deployment', namespace, name })
          case 'patch':
            return api.kube!.change!({
              context,
              kind: 'ConfigMap',
              namespace,
              name,
              change: {
                action: 'patch',
                patchType: 'merge',
                patch: { metadata: { labels: { a: 'b' } } },
              },
            })
          case 'delete':
            return api.kube!.change!({
              context,
              kind: 'Secret',
              namespace,
              name,
              change: { action: 'delete' },
            })
          case 'logs':
            return api.logs!.start!(id, { context, namespace, pod: name, container: 'app' })
          case 'shell':
            return api.terminal!.open!(id, {
              target: 'container',
              context,
              namespace,
              pod: name,
              container: 'app',
            })
          case 'attach':
            return api.terminal!.open!(id, {
              target: 'attach',
              context,
              namespace,
              pod: name,
              container: 'app',
            })
          case 'download':
            return api.files!.download!(id, {
              context,
              namespace,
              pod: name,
              container: 'app',
              path: '/etc/hostname',
            })
          case 'metrics source':
            return api.usage!.test!(context, {
              namespace,
              service: name,
              port: '9090',
              path: '',
            })
          case 'forward':
            return api.forwards!.start!({ context, namespace, kind: 'Pod', name, port: 8080 })
          case 'node shell':
            return api.terminal!.open!(id, { target: 'node', context, node: name, mode: 'pod' })
          case 'local shell':
            return api.terminal!.open!(id, { target: 'local', context, namespace })
          case 'list':
            return api.kube!.list!({ context, kind: 'Secret', namespace })
          case 'watch':
            return api.watches!.start!(id, { context, kind: 'Secret', namespace })
        }
      })()) as { ok: boolean; error?: { code: string; message: string } } | undefined
      // (A stream that started is stopped again: only its answer was wanted.)
      for (const [group, stop] of [
        ['logs', 'stop'],
        ['terminal', 'close'],
        ['files', 'cancel'],
        ['watches', 'stop'],
      ] as const) {
        api[group]?.[stop]?.(id)
      }
      return answer?.ok ? 'ok' : `${answer?.error?.code}: ${answer?.error?.message}`
    },
    { call, name, namespace },
  )

/** What a call that's refused for a name says, in Lumovi's words. */
export const NAME_REFUSED: Partial<Record<Call, string>> = {
  logs: 'invalid: That isn’t a pod’s name Kubernetes allows.',
  shell: 'invalid: That isn’t a pod’s name Kubernetes allows.',
  attach: 'invalid: That isn’t a pod’s name Kubernetes allows.',
  download: 'invalid: That isn’t a pod’s name Kubernetes allows.',
  'node shell': 'invalid: That isn’t a node’s name Kubernetes allows.',
  'metrics source': 'invalid: That isn’t a Service’s name Kubernetes allows.',
}
/**
 * Names some kinds may have, never a pod, a node or a Service, which are DNS subdomains: with
 * what an address reads as something else (a backslash is a slash, and its dots step out of the
 * namespace; a `?` or a `#` cuts the path), or a space, a capital or a colon.
 */
export const NOT_DNS_NAMES = [
  'x\\..\\..\\..\\prod\\pods\\db',
  'x\\pods\\db',
  'v?container=x',
  'v#x',
  'with space',
  'Upper',
  'role:name',
]
/** The names a call refuses: none a kind can't have, and for a pod, a node or a Service, more. */
export const notNamesFor = (call: Call) =>
  call in NAME_REFUSED ? [...NOT_NAMES, ...NOT_DNS_NAMES] : NOT_NAMES
export const refusedFor = (call: Call) =>
  NAME_REFUSED[call] ?? 'invalid: That isn’t a name Kubernetes allows.'
export const NAMESPACE_REFUSED = 'invalid: That isn’t a namespace Kubernetes allows.'

/**
 * Whether the cluster was asked anything by a refused call: a request that names the namespace
 * it would have been in, or the name no object has, or that's a list's path where one object
 * was meant, or anything but a read.
 */
export const askedOfTheCluster = (requests: { method: string; path: string }[]) =>
  requests
    .filter(
      ({ method, path }) =>
        method !== 'GET' ||
        path.includes(`/namespaces/${WHERE}`) ||
        path.includes(NOBODY) ||
        path.endsWith('/'),
    )
    .map(({ method, path }) => `${method} ${path}`)

/** The longest names Kubernetes takes, and the oddest: each kind's own rule at its edge. */
const LONGEST = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`
export const LONGEST_NAMESPACE = `n${'0'.repeat(61)}n`

/** Real objects with those names: a ConfigMap and a Secret, a ClusterRole and a RoleBinding. */
export const ODDLY_NAMED: { kind: string; namespace?: string; name: string; object: KubeObject }[] =
  [
    { kind: 'ConfigMap', namespace: LONGEST_NAMESPACE, name: LONGEST },
    { kind: 'Secret', namespace: LONGEST_NAMESPACE, name: 'kube-root-ca.crt.1' },
    { kind: 'ClusterRole', name: 'system:controller:attachdetach-controller' },
    { kind: 'RoleBinding', namespace: 'default', name: 'oidc:alice@example.com' },
  ].map(({ kind, namespace, name }) => ({
    kind,
    ...(namespace ? { namespace } : {}),
    name,
    object: {
      apiVersion:
        kind.startsWith('Role') || kind.startsWith('Cluster')
          ? 'rbac.authorization.k8s.io/v1'
          : 'v1',
      kind,
      metadata: {
        name,
        ...(namespace ? { namespace } : {}),
        uid: `odd-${kind}`,
        creationTimestamp: new Date().toISOString(),
      },
      ...(kind === 'RoleBinding'
        ? { roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'view' } }
        : {}),
    } as unknown as KubeObject,
  }))

/** One call with a real object's name: read, a label set, deleted. */
export const oddlyAsked = (
  page: Page,
  action: 'get' | 'patch' | 'delete',
  { kind, namespace, name }: { kind: string; namespace?: string; name: string },
) =>
  page.evaluate(
    async ({ action, kind, namespace, name }) => {
      const kube = (
        window as unknown as { lumovi: { kube: Record<string, (...args: unknown[]) => unknown> } }
      ).lumovi.kube
      const where = { context: 'demo', kind, ...(namespace ? { namespace } : {}), name }
      const answer = (await (action === 'get'
        ? kube.get!(where)
        : kube.change!({
            ...where,
            change:
              action === 'delete'
                ? { action: 'delete' }
                : {
                    action: 'patch',
                    patchType: 'merge',
                    patch: { metadata: { labels: { odd: 'yes' } } },
                  },
          }))) as {
        ok: boolean
        data?: { metadata?: { name?: string; labels?: Record<string, string> } }
        error?: { code: string; message: string }
      }
      if (!answer.ok) return `${answer.error?.code}: ${answer.error?.message}`
      if (action === 'delete') return 'deleted'
      return `${answer.data?.metadata?.name === name ? 'named so' : 'another'}${
        answer.data?.metadata?.labels?.odd === 'yes' ? ', labelled' : ''
      }`
    },
    { action, kind, namespace, name },
  )

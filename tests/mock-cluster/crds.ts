/**
 * Everything the mock API server serves beyond the app's built-in kinds:
 * a few more of Kubernetes' own kinds, and custom resources for every CRD in
 * the store, served like the real API server does: in discovery (aggregated
 * and per group), as Tables with the CRD's printer columns, in OpenAPI v3
 * documents, and with the status and scale subresources.
 */
import { createHash } from 'node:crypto'
import { jsonPath } from '../../src/shared/jsonpath.ts'
import {
  kindFor,
  pluralLabel,
  RESOURCES,
  type ResourceDefinition,
} from '../../src/shared/resources.ts'
import type { Json, KubeObject } from './types.ts'

export interface PrinterColumn {
  name: string
  type: string
  jsonPath: string
  description?: string
  priority?: number
  format?: string
}

/** A kind the mock serves, with what it needs to list, print, describe and scale it. */
export interface Served extends ResourceDefinition {
  verbs: string[]
  /** A CRD's printer columns (custom resources only). */
  columns?: PrinterColumn[]
  /** A CRD version's schema (custom resources only). */
  schema?: Json
  /** Where a custom resource keeps its replicas, when it has the scale subresource. */
  scale?: { specReplicasPath: string; statusReplicasPath: string; labelSelectorPath?: string }
  /** Whether it is defined by a CRD. */
  custom?: boolean
}

const ALL_VERBS = [
  'create',
  'delete',
  'deletecollection',
  'get',
  'list',
  'patch',
  'update',
  'watch',
]

/** Kinds the app doesn't have pages for, that it finds through discovery like custom ones. */
const MORE_KINDS: Served[] = [
  {
    kind: 'ControllerRevision.apps',
    apiKind: 'ControllerRevision',
    plural: 'controllerrevisions',
    group: 'apps',
    version: 'v1',
    namespaced: true,
    label: 'ControllerRevisions',
    verbs: ALL_VERBS,
  },
  {
    kind: 'ServiceAccount',
    apiKind: 'ServiceAccount',
    plural: 'serviceaccounts',
    group: '',
    version: 'v1',
    namespaced: true,
    label: 'ServiceAccounts',
    shortNames: ['sa'],
    verbs: ALL_VERBS,
  },
  {
    kind: 'ClusterRole.rbac.authorization.k8s.io',
    apiKind: 'ClusterRole',
    plural: 'clusterroles',
    group: 'rbac.authorization.k8s.io',
    version: 'v1',
    namespaced: false,
    label: 'ClusterRoles',
    verbs: ALL_VERBS,
  },
  {
    kind: 'CustomResourceDefinition.apiextensions.k8s.io',
    apiKind: 'CustomResourceDefinition',
    plural: 'customresourcedefinitions',
    group: 'apiextensions.k8s.io',
    version: 'v1',
    namespaced: false,
    label: 'CustomResourceDefinitions',
    shortNames: ['crd', 'crds'],
    subresources: ['status'],
    verbs: ALL_VERBS,
  },
]

const BUILTIN: Served[] = RESOURCES.map((r) => ({
  ...r,
  verbs:
    r.kind === 'Event'
      ? ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch']
      : ALL_VERBS,
  ...(r.kind === 'Pod'
    ? { subresources: ['log', 'exec', 'portforward', 'eviction', 'ephemeralcontainers', 'status'] }
    : {}),
  ...(['Deployment', 'StatefulSet', 'ReplicaSet'].includes(r.kind)
    ? { subresources: ['scale', 'status'] }
    : {}),
}))

/** Every kind the cluster serves now: built-in, more of Kubernetes', and its CRDs'. */
export function servedKinds(objects: Iterable<KubeObject>): Served[] {
  const custom: Served[] = []
  for (const object of objects) {
    if (object.kind !== 'CustomResourceDefinition' || object.metadata.deletionTimestamp) continue
    const { group, names, scope, versions } = object.spec
    for (const version of versions as Json[]) {
      if (!version.served) continue
      custom.push({
        kind: kindFor(`${group}/${version.name}`, names.kind),
        apiKind: names.kind,
        plural: names.plural,
        group,
        version: version.name,
        namespaced: scope === 'Namespaced',
        label: pluralLabel(names.kind, names.plural),
        ...(names.shortNames ? { shortNames: names.shortNames } : {}),
        subresources: Object.keys(version.subresources ?? {}),
        verbs: ALL_VERBS,
        columns: version.additionalPrinterColumns ?? [],
        schema: version.schema?.openAPIV3Schema,
        ...(version.subresources?.scale ? { scale: version.subresources.scale } : {}),
        custom: true,
      })
    }
  }
  return [...BUILTIN, ...MORE_KINDS, ...custom]
}

const groupVersion = (s: Served) => (s.group ? `${s.group}/${s.version}` : s.version)

/** Served kinds by API group, then version, in the order discovery lists them. */
function byGroup(served: Served[]): Map<string, Map<string, Served[]>> {
  const groups = new Map<string, Map<string, Served[]>>()
  for (const s of served) {
    const versions = groups.get(s.group) ?? new Map<string, Served[]>()
    versions.set(s.version, [...(versions.get(s.version) ?? []), s])
    groups.set(s.group, versions)
  }
  return groups
}

// ——— Discovery ———

const METRICS_GROUP = 'metrics.k8s.io'

/**
 * Aggregated discovery (apidiscovery.k8s.io/v2) for /api or /apis. The
 * metrics API's version goes stale, without resources, while metrics-server
 * is down, as a real aggregated API does.
 */
export function aggregatedDiscovery(
  path: '/api' | '/apis',
  served: Served[],
  metrics: 'up' | 'down' | 'none',
): Json {
  const groups = byGroup(served)
  const items: Json[] = []
  for (const [group, versions] of groups) {
    if ((path === '/api') !== (group === '')) continue
    items.push({
      metadata: group ? { name: group, creationTimestamp: null } : { creationTimestamp: null },
      versions: [...versions].map(([version, kinds]) => ({
        version,
        resources: kinds.map(aggregatedResource),
        freshness: 'Current',
      })),
    })
  }
  if (path === '/apis' && metrics !== 'none') {
    items.push({
      metadata: { name: METRICS_GROUP, creationTimestamp: null },
      versions: [
        metrics === 'up'
          ? {
              version: 'v1beta1',
              resources: [
                metricsResource('nodes', 'NodeMetrics', 'Cluster'),
                metricsResource('pods', 'PodMetrics', 'Namespaced'),
              ],
              freshness: 'Current',
            }
          : { version: 'v1beta1', freshness: 'Stale' },
      ],
    })
  }
  return {
    kind: 'APIGroupDiscoveryList',
    apiVersion: 'apidiscovery.k8s.io/v2',
    metadata: {},
    items,
  }
}

function aggregatedResource(s: Served): Json {
  const responseKind = { group: s.group, version: s.version, kind: s.apiKind }
  return {
    resource: s.plural,
    responseKind,
    scope: s.namespaced ? 'Namespaced' : 'Cluster',
    singularResource: s.apiKind.toLowerCase(),
    verbs: s.verbs,
    ...(s.shortNames ? { shortNames: s.shortNames } : {}),
    ...(s.subresources?.length
      ? {
          subresources: s.subresources.map((subresource) => ({
            subresource,
            responseKind:
              subresource === 'scale'
                ? { group: 'autoscaling', version: 'v1', kind: 'Scale' }
                : responseKind,
            verbs: ['get', 'patch', 'update'],
          })),
        }
      : {}),
  }
}

function metricsResource(plural: string, kind: string, scope: string): Json {
  return {
    resource: plural,
    responseKind: { group: METRICS_GROUP, version: 'v1beta1', kind },
    scope,
    singularResource: '',
    verbs: ['get', 'list'],
  }
}

/** The per-group discovery documents, as clusters without aggregated discovery serve them. */
export function legacyDiscovery(
  path: string,
  served: Served[],
  metricsUp: boolean,
): Json | undefined {
  const groups = byGroup(served)
  if (path === '/api') {
    return {
      kind: 'APIVersions',
      versions: ['v1'],
      serverAddressByClientCIDRs: [{ clientCIDR: '0.0.0.0/0', serverAddress: '127.0.0.1:6443' }],
    }
  }
  if (path === '/apis') {
    const listed = [...groups]
      .filter(([group]) => group !== '')
      .map(([name, versions]) => {
        const all = [...versions.keys()].map((version) => ({
          groupVersion: `${name}/${version}`,
          version,
        }))
        return { name, versions: all, preferredVersion: all[0] }
      })
    if (metricsUp) {
      const version = { groupVersion: `${METRICS_GROUP}/v1beta1`, version: 'v1beta1' }
      listed.push({ name: METRICS_GROUP, versions: [version], preferredVersion: version })
    }
    return { kind: 'APIGroupList', apiVersion: 'v1', groups: listed }
  }
  const match = path.match(/^\/api\/(v1)$|^\/apis\/([^/]+)\/([^/]+)$/)
  if (!match) return undefined
  const group = match[2] ?? ''
  const version = match[1] ?? match[3]!
  if (group === METRICS_GROUP && metricsUp && version === 'v1beta1') {
    return {
      kind: 'APIResourceList',
      apiVersion: 'v1',
      groupVersion: `${METRICS_GROUP}/v1beta1`,
      resources: [
        {
          name: 'nodes',
          singularName: '',
          namespaced: false,
          kind: 'NodeMetrics',
          verbs: ['get', 'list'],
        },
        {
          name: 'pods',
          singularName: '',
          namespaced: true,
          kind: 'PodMetrics',
          verbs: ['get', 'list'],
        },
      ],
    }
  }
  const kinds = groups.get(group)?.get(version)
  if (!kinds) return undefined
  return {
    kind: 'APIResourceList',
    apiVersion: 'v1',
    groupVersion: group ? `${group}/${version}` : version,
    resources: kinds.flatMap((s) => [
      {
        name: s.plural,
        singularName: s.apiKind.toLowerCase(),
        namespaced: s.namespaced,
        kind: s.apiKind,
        verbs: s.verbs,
        ...(s.shortNames ? { shortNames: s.shortNames } : {}),
      },
      ...(s.subresources ?? []).map((subresource) => ({
        name: `${s.plural}/${subresource}`,
        singularName: '',
        namespaced: s.namespaced,
        kind: subresource === 'scale' ? 'Scale' : s.apiKind,
        verbs: ['get', 'patch', 'update'],
      })),
    ]),
  }
}

// ——— Tables ———

const NAME_COLUMN = {
  name: 'Name',
  type: 'string',
  format: 'name',
  description:
    'Name must be unique within a namespace. Is required when creating resources, although some resources may allow a client to request the generation of an appropriate name automatically.',
  priority: 0,
}

/**
 * A list as a Table (`Accept: application/json;as=Table;g=meta.k8s.io;v=v1`):
 * a custom resource's printer columns, computed like the API server does, or
 * a name and an age for everything else.
 */
export function asTable(
  served: Served,
  list: Json,
  includeObject: string | null,
  now: number,
): Json {
  const columns: PrinterColumn[] = served.custom
    ? served.columns!.length
      ? served.columns!
      : [
          {
            name: 'Created At',
            type: 'date',
            jsonPath: '.metadata.creationTimestamp',
            description:
              'CreationTimestamp is a timestamp representing the server time when this object was created.',
          },
        ]
    : [
        {
          name: 'Age',
          type: 'string',
          jsonPath: '.metadata.creationTimestamp',
          description:
            'CreationTimestamp is a timestamp representing the server time when this object was created.',
        },
      ]
  return {
    kind: 'Table',
    apiVersion: 'meta.k8s.io/v1',
    metadata: list.metadata,
    columnDefinitions: [
      NAME_COLUMN,
      ...columns.map((c) => ({
        name: c.name,
        type: c.type,
        format: c.format ?? '',
        description: c.description ?? '',
        priority: c.priority ?? 0,
      })),
    ],
    rows: (list.items as Json[]).map((item) => {
      const object = { apiVersion: groupVersion(served), kind: served.apiKind, ...item }
      return {
        cells: [item.metadata.name, ...columns.map((c) => cell(c, object, now, !served.custom))],
        object:
          includeObject === 'Object'
            ? object
            : {
                apiVersion: 'meta.k8s.io/v1',
                kind: 'PartialObjectMetadata',
                metadata: item.metadata,
              },
      }
    }),
  }
}

/** A printer column's cell: the first value its path finds, typed like the API server does. */
function cell(column: PrinterColumn, object: Json, now: number, age: boolean): Json {
  const [value] = jsonPath(object, column.jsonPath)
  if (value === undefined || value === null) return null
  if (age || column.type === 'date') {
    return humanDuration(now - Date.parse(String(value)))
  }
  switch (column.type) {
    case 'integer':
      return typeof value === 'number' ? Math.trunc(value) : null
    case 'number':
      return typeof value === 'number' ? value : null
    case 'boolean':
      return typeof value === 'boolean' ? value : null
    default:
      return typeof value === 'object' ? JSON.stringify(value) : String(value)
  }
}

/** Kubernetes' duration.HumanDuration: "45s", "3m20s", "5h", "12d", "2y30d". */
export function humanDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < -1) return '<invalid>'
  if (seconds < 0) return '0s'
  if (seconds < 120) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 10) return seconds % 60 ? `${minutes}m${seconds % 60}s` : `${minutes}m`
  if (minutes < 180) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 8) return minutes % 60 ? `${hours}h${minutes % 60}m` : `${hours}h`
  if (hours < 48) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (hours < 24 * 8) return hours % 24 ? `${days}d${hours % 24}h` : `${days}d`
  if (hours < 24 * 365 * 2) return `${days}d`
  const years = Math.floor(days / 365)
  if (hours < 24 * 365 * 8) return days % 365 ? `${years}y${days % 365}d` : `${years}y`
  return `${years}y`
}

// ——— Scale ———

/** The Scale a custom resource's scale subresource returns. */
export function scaleOf(served: Served, object: KubeObject): Json {
  const { specReplicasPath, statusReplicasPath, labelSelectorPath } = served.scale!
  const [replicas] = jsonPath(object, specReplicasPath)
  const [current] = jsonPath(object, statusReplicasPath)
  const [selector] = labelSelectorPath ? jsonPath(object, labelSelectorPath) : []
  return {
    kind: 'Scale',
    apiVersion: 'autoscaling/v1',
    metadata: {
      name: object.metadata.name,
      namespace: object.metadata.namespace,
      uid: object.metadata.uid,
      resourceVersion: object.metadata.resourceVersion,
      creationTimestamp: object.metadata.creationTimestamp,
    },
    spec: { replicas: replicas ?? 0 },
    status: { replicas: current ?? 0, ...(selector ? { selector } : {}) },
  }
}

/** Sets the field a simple path like .spec.replicas names, creating objects on the way. */
export function setPath(object: Json, path: string, value: Json): Json {
  const copy = structuredClone(object)
  const keys = path.replace(/^\./, '').split('.')
  let node = copy
  for (const key of keys.slice(0, -1)) node = node[key] ??= {}
  node[keys.at(-1)!] = value
  return copy
}

// ——— Validation ———

/**
 * Checks a custom resource against its CRD's schema, the parts fixtures use:
 * types, required fields, minimums and enums. Returns the first problem.
 */
export function schemaProblem(schema: Json, value: Json, path = ''): string | undefined {
  if (!schema || value === undefined || value === null) return undefined
  const field = path || '<root>'
  const types: Record<string, (v: Json) => boolean> = {
    object: (v) => typeof v === 'object' && !Array.isArray(v),
    array: Array.isArray,
    string: (v) => typeof v === 'string',
    integer: Number.isInteger,
    number: (v) => typeof v === 'number',
    boolean: (v) => typeof v === 'boolean',
  }
  if (schema.type && !schema['x-kubernetes-int-or-string'] && !types[schema.type]?.(value)) {
    return `${field}: Invalid value: "${typeof value}": ${field} in body must be of type ${schema.type}: "${typeof value}"`
  }
  if (typeof schema.minimum === 'number' && typeof value === 'number' && value < schema.minimum) {
    return `${field}: Invalid value: ${value}: ${field} in body should be greater than or equal to ${schema.minimum}`
  }
  if (schema.enum && !schema.enum.includes(value)) {
    return `${field}: Unsupported value: ${JSON.stringify(value)}: supported values: ${schema.enum.map((v: Json) => JSON.stringify(v)).join(', ')}`
  }
  if (schema.type === 'object') {
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) return `${path ? `${path}.` : ''}${key}: Required value`
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      const problem = schemaProblem(child, value[key], path ? `${path}.${key}` : key)
      if (problem) return problem
    }
  }
  if (schema.type === 'array' && schema.items) {
    for (const [i, item] of (value as Json[]).entries()) {
      const problem = schemaProblem(schema.items, item, `${field}[${i}]`)
      if (problem) return problem
    }
  }
  return undefined
}

// ——— OpenAPI v3 ———

const OBJECT_META = 'io.k8s.apimachinery.pkg.apis.meta.v1.ObjectMeta'
const JSON_SCHEMA_PROPS = 'io.k8s.apiextensions-apiserver.pkg.apis.apiextensions.v1.JSONSchemaProps'

/** Shared definitions: object metadata, and the recursive schema of schemas CRDs use. */
const SHARED_SCHEMAS: Record<string, Json> = {
  [OBJECT_META]: {
    type: 'object',
    description:
      'ObjectMeta is metadata that all persisted resources must have, which includes all objects users must create.',
    properties: {
      name: { type: 'string', description: 'Name must be unique within a namespace.' },
      namespace: {
        type: 'string',
        description: 'Namespace defines the space within which each name must be unique.',
      },
      labels: {
        type: 'object',
        description:
          'Map of string keys and values that can be used to organize and categorize objects.',
        additionalProperties: { type: 'string', default: '' },
      },
    },
  },
  [JSON_SCHEMA_PROPS]: {
    type: 'object',
    description: 'JSONSchemaProps is a JSON-Schema following Specification Draft 4.',
    properties: {
      type: { type: 'string' },
      description: { type: 'string' },
      properties: {
        type: 'object',
        additionalProperties: {
          allOf: [{ $ref: `#/components/schemas/${JSON_SCHEMA_PROPS}` }],
          default: {},
        },
      },
      items: { $ref: `#/components/schemas/${JSON_SCHEMA_PROPS}` },
    },
  },
}

/** Schemas of the kinds that aren't custom, by group/version (only those the tests open). */
const BUILTIN_SCHEMAS: Record<string, Record<string, Json>> = {
  'api/v1': {
    'io.k8s.api.core.v1.ServiceAccount': {
      type: 'object',
      description:
        'ServiceAccount binds together: * a name, understood by users, and perhaps by peripheral systems, for an identity * a principal that can be authenticated and authorized * a set of secrets',
      properties: {
        apiVersion: {
          type: 'string',
          description:
            'APIVersion defines the versioned schema of this representation of an object.',
        },
        kind: {
          type: 'string',
          description:
            'Kind is a string value representing the REST resource this object represents.',
        },
        metadata: {
          allOf: [{ $ref: `#/components/schemas/${OBJECT_META}` }],
          default: {},
          description: "Standard object's metadata.",
        },
        automountServiceAccountToken: {
          type: 'boolean',
          description:
            'AutomountServiceAccountToken indicates whether pods running as this service account should have an API token automatically mounted.',
        },
      },
      'x-kubernetes-group-version-kind': [{ group: '', kind: 'ServiceAccount', version: 'v1' }],
    },
  },
  // Roles, but no ClusterRoles: a document that doesn't describe every kind in its group.
  'apis/rbac.authorization.k8s.io/v1': {
    'io.k8s.api.rbac.v1.Role': {
      type: 'object',
      description: 'Role is a namespaced, logical grouping of PolicyRules.',
      'x-kubernetes-group-version-kind': [
        { group: 'rbac.authorization.k8s.io', kind: 'Role', version: 'v1' },
      ],
    },
  },
  'apis/apiextensions.k8s.io/v1': {
    'io.k8s.apiextensions-apiserver.pkg.apis.apiextensions.v1.CustomResourceDefinition': {
      type: 'object',
      description:
        'CustomResourceDefinition represents a resource that should be exposed on the API server.',
      properties: {
        metadata: { allOf: [{ $ref: `#/components/schemas/${OBJECT_META}` }], default: {} },
        spec: {
          type: 'object',
          description: 'spec describes how the user wants the resources to appear',
          properties: {
            group: {
              type: 'string',
              description: 'group is the API group of the defined custom resource.',
            },
            versions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  schema: {
                    type: 'object',
                    properties: {
                      openAPIV3Schema: { $ref: `#/components/schemas/${JSON_SCHEMA_PROPS}` },
                    },
                  },
                },
              },
            },
          },
        },
      },
      'x-kubernetes-group-version-kind': [
        { group: 'apiextensions.k8s.io', kind: 'CustomResourceDefinition', version: 'v1' },
      ],
    },
  },
}

/** What a custom resource's schema looks like in the OpenAPI document. */
function publishedSchema(served: Served): Json {
  const schema = structuredClone(
    served.schema ?? { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
  )
  schema.properties = {
    apiVersion: {
      type: 'string',
      description: 'APIVersion defines the versioned schema of this representation of an object.',
    },
    kind: {
      type: 'string',
      description: 'Kind is a string value representing the REST resource this object represents.',
    },
    ...schema.properties,
    metadata: {
      allOf: [{ $ref: `#/components/schemas/${OBJECT_META}` }],
      description: "Standard object's metadata.",
    },
  }
  schema['x-kubernetes-group-version-kind'] = [
    { group: served.group, version: served.version, kind: served.apiKind },
  ]
  return schema
}

const reversed = (group: string) => group.split('.').reverse().join('.')

function openApiDocument(key: string, served: Served[]): Json | undefined {
  const custom = served.filter((s) => s.custom && key === `apis/${s.group}/${s.version}`)
  const builtin = BUILTIN_SCHEMAS[key]
  if (!custom.length && !builtin) return undefined
  return {
    openapi: '3.0.0',
    info: { title: 'Kubernetes', version: 'v1.34.1' },
    paths: {},
    components: {
      schemas: {
        ...SHARED_SCHEMAS,
        ...builtin,
        ...Object.fromEntries(
          custom.map((s) => [`${reversed(s.group)}.${s.version}.${s.apiKind}`, publishedSchema(s)]),
        ),
      },
    },
  }
}

/** /openapi/v3 and the documents it links to; undefined for other paths. */
export function openApi(path: string, served: Served[]): Json | undefined {
  const keys = [
    ...new Set([
      ...Object.keys(BUILTIN_SCHEMAS),
      ...served.filter((s) => s.custom).map((s) => `apis/${s.group}/${s.version}`),
    ]),
  ]
  if (path === '/openapi/v3') {
    return {
      paths: Object.fromEntries(
        keys.map((key) => {
          const hash = createHash('sha512')
            .update(JSON.stringify(openApiDocument(key, served)))
            .digest('hex')
            .slice(0, 32)
            .toUpperCase()
          return [key, { serverRelativeURL: `/openapi/v3/${key}?hash=${hash}` }]
        }),
      ),
    }
  }
  const key = path.match(/^\/openapi\/v3\/(.+)$/)?.[1]
  return key ? openApiDocument(key, served) : undefined
}

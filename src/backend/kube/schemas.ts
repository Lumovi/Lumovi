/**
 * Kind schemas from the cluster's OpenAPI v3 documents (Kubernetes 1.27 and
 * later), for explaining fields and checking them as they're typed. Custom
 * resources publish the schema of their CRD there too.
 */
import type { FieldSchema } from '@shared/api'
import type { ResourceDefinition } from '@shared/resources'

interface OpenApiSchema {
  type?: string
  description?: string
  format?: string
  enum?: unknown[]
  default?: unknown
  properties?: Record<string, OpenApiSchema>
  items?: OpenApiSchema
  additionalProperties?: OpenApiSchema | boolean
  required?: string[]
  nullable?: boolean
  $ref?: string
  allOf?: OpenApiSchema[]
  anyOf?: OpenApiSchema[]
  oneOf?: OpenApiSchema[]
  'x-kubernetes-group-version-kind'?: { group: string; version: string; kind: string }[]
  'x-kubernetes-preserve-unknown-fields'?: boolean
  'x-kubernetes-int-or-string'?: boolean
}

/** Kubernetes' own values that are a number or text, by their schemas' names. */
const NUMBER_OR_TEXT = new Set([
  'io.k8s.apimachinery.pkg.util.intstr.IntOrString',
  'io.k8s.apimachinery.pkg.api.resource.Quantity',
])

interface OpenApiDocument {
  components: { schemas: Record<string, OpenApiSchema> }
}

type GetJson = (path: string) => Promise<unknown>

/** OpenAPI documents by URL, kept between lookups. */
export type DocumentCache = Map<string, Promise<unknown>>

/** The schema of `resource`'s objects, or null when the cluster publishes none. */
export async function schemaOf(
  resource: ResourceDefinition,
  get: GetJson,
  documents: DocumentCache,
): Promise<FieldSchema | null> {
  const index = (await get('/openapi/v3')) as {
    paths: Record<string, { serverRelativeURL: string }>
  }
  const key = resource.group
    ? `apis/${resource.group}/${resource.version}`
    : `api/${resource.version}`
  const url = index.paths[key]?.serverRelativeURL
  if (!url) return null
  // Each URL carries a hash of its content, so a cached document is never stale.
  let document = documents.get(url)
  if (!document) {
    document = get(url)
    documents.set(url, document)
    document.catch(() => documents.delete(url))
  }
  const { schemas } = ((await document) as OpenApiDocument).components
  const root = Object.values(schemas).find((schema) =>
    schema['x-kubernetes-group-version-kind']?.some(
      (gvk) =>
        gvk.group === resource.group &&
        gvk.version === resource.version &&
        gvk.kind === resource.apiKind,
    ),
  )
  return root ? simplify(root, schemas, new Set()) : null
}

/** Keeps what explains fields and checks them, with references resolved. */
function simplify(
  schema: OpenApiSchema,
  schemas: Record<string, OpenApiSchema>,
  seen: ReadonlySet<string>,
): FieldSchema {
  // References come bare, or wrapped in allOf so they can carry their own description.
  const ref = schema.$ref ?? schema.allOf?.[0]?.$ref
  let target = schema
  let visited = seen
  if (ref) {
    const name = ref.slice(ref.lastIndexOf('/') + 1)
    // Recursive schemas (like a CRD's own JSONSchemaProps) stop where they repeat.
    if (seen.has(name)) return { description: schema.description }
    const named = schemas[name]!
    target = { ...named, description: schema.description ?? named.description }
    if (NUMBER_OR_TEXT.has(name)) target['x-kubernetes-int-or-string'] = true
    visited = new Set(seen).add(name)
  }
  const field: FieldSchema = {}
  if (ref) field.named = ref.slice(ref.lastIndexOf('.') + 1)
  // (A choice of shapes isn't checked: a value of any of them is let be.)
  if (target.type && !target.anyOf && !target.oneOf) field.type = target.type
  if (target.description) field.description = target.description
  if (target.format) field.format = target.format
  if (target.enum) field.enum = target.enum
  if (target.default !== undefined) field.default = target.default
  if (target.properties) {
    field.properties = Object.fromEntries(
      Object.entries(target.properties).map(([key, value]) => [
        key,
        simplify(value, schemas, visited),
      ]),
    )
  }
  if (target.items) field.items = simplify(target.items, schemas, visited)
  if (typeof target.additionalProperties === 'object') {
    field.additionalProperties = simplify(target.additionalProperties, schemas, visited)
  }
  if (target.required?.length) field.required = target.required
  if (
    target['x-kubernetes-preserve-unknown-fields'] ||
    target.additionalProperties === true ||
    target.anyOf ||
    target.oneOf
  ) {
    field.open = true
  }
  if (target['x-kubernetes-int-or-string'] || target.format === 'int-or-string') {
    field.numberOrText = true
    delete field.type
  }
  if (target.nullable) field.nullable = true
  return field
}

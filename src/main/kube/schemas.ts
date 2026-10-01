/**
 * Kind schemas from the cluster's OpenAPI v3 documents (Kubernetes 1.27 and
 * later), for explaining fields. Custom resources publish the schema of
 * their CRD there too.
 */
import type { FieldSchema } from '@shared/api'
import type { ResourceDefinition } from '@shared/resources'

interface OpenApiSchema {
  type?: string
  description?: string
  format?: string
  enum?: unknown[]
  properties?: Record<string, OpenApiSchema>
  items?: OpenApiSchema
  additionalProperties?: OpenApiSchema | boolean
  $ref?: string
  allOf?: OpenApiSchema[]
  'x-kubernetes-group-version-kind'?: { group: string; version: string; kind: string }[]
}

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

/** Keeps what explains fields, with references resolved. */
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
    visited = new Set(seen).add(name)
  }
  const field: FieldSchema = {}
  if (target.type) field.type = target.type
  if (target.description) field.description = target.description
  if (target.format) field.format = target.format
  if (target.enum) field.enum = target.enum
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
  return field
}

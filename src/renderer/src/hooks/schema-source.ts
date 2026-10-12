/**
 * The schemas a YAML editor checks its documents by: each document's kind (its `apiVersion` and
 * `kind`) found among the kinds the cluster serves, and that kind's schema from the cluster's
 * OpenAPI, which Lumovi already reads to explain fields (no other request). A schema is asked for
 * the first time a document names its kind, and the editor hears when it comes.
 */
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import type { FieldSchema } from '@shared/api'
import { isBuiltinKind, type ResourceDefinition } from '@shared/resources'
import { api, unwrap } from '@renderer/lib/api'
import { useCluster } from '@renderer/state/cluster'
import { countOf } from '@renderer/features/actions/BulkActions'
import { useVersion } from './queries'
import { useResources } from './resources'

/** A kind's schema as an editor knows it, and the words it's said with. */
export interface KnownSchema {
  /** Null where the cluster publishes none. */
  schema: FieldSchema | null
  /** The kind in a sentence: "deployment", "NodePool". */
  words: string
  /** The kind as Lumovi names it: "Deployment", "NodePool.karpenter.sh". */
  name: string
  /** Whose words its descriptions are: "from Kubernetes v1.34", "from the CRD …". */
  from: string
}

export interface SchemaSource {
  /**
   * The schema of the kind a document says it is: known, or undefined while it's being fetched
   * (asked for then), or for a kind the cluster doesn't serve, at that version.
   */
  get(apiVersion: string, kind: string): KnownSchema | undefined
  /** Hears when a schema asked for comes; gives back a way to stop. */
  listen(heard: () => void): () => void
}

/** The kind a document names, among those the cluster serves. */
function resourceNamed(
  resources: readonly ResourceDefinition[],
  apiVersion: string,
  kind: string,
): ResourceDefinition | undefined {
  const slash = apiVersion.lastIndexOf('/')
  const group = slash === -1 ? '' : apiVersion.slice(0, slash)
  const version = apiVersion.slice(slash + 1)
  // (Another version of a kind than the one the cluster prefers has another schema, which
  // Lumovi doesn't read: such a document is checked as YAML only.)
  return resources.find(
    (resource) =>
      resource.group === group && resource.version === version && resource.apiKind === kind,
  )
}

/**
 * The editor's schemas, for the cluster in view: one source for the editor's life (it's made
 * once), which reads what's known now each time it's asked, and tells its editor when that
 * changes (discovery, the cluster's version, a schema that's come).
 */
export function useSchemaSource(): SchemaSource {
  const { context } = useCluster()
  const client = useQueryClient()
  const resources = useResources().data
  const version = useVersion(context).data?.gitVersion
  const now = useRef({ context, client, resources, version })
  const listeners = useRef(new Set<() => void>())
  const asked = useRef(new Set<string>())
  useEffect(() => {
    now.current = { context, client, resources, version }
    for (const heard of listeners.current) heard()
  }, [context, client, resources, version])

  const [source] = useState<SchemaSource>(() => ({
    get(apiVersion, kind) {
      const { context, client, resources, version } = now.current
      const resource = resources && resourceNamed(resources, apiVersion, kind)
      if (!resource) return undefined
      const key = ['schema', context, resource.kind]
      const schema = client.getQueryData<FieldSchema | null>(key)
      if (schema === undefined) {
        const asking = `${context}/${resource.kind}`
        if (!asked.current.has(asking)) {
          asked.current.add(asking)
          void client
            .fetchQuery({
              queryKey: key,
              queryFn: () => unwrap(api.kube.schema(context, resource.kind)),
              staleTime: Infinity,
            })
            .then(
              () => listeners.current.forEach((heard) => heard()),
              // (Not read: as if none were published, and asked again another time.)
              () => asked.current.delete(asking),
            )
        }
        return undefined
      }
      return {
        schema,
        words: countOf(resource.kind, 1).replace(/^1 /, ''),
        name: resource.kind,
        from: isBuiltinKind(resource.kind)
          ? `from Kubernetes ${version?.replace(/^(v\d+\.\d+).*$/, '$1') ?? ''}`.trimEnd()
          : `from the CRD ${resource.plural}.${resource.group}`,
      }
    },
    listen(heard) {
      listeners.current.add(heard)
      return () => void listeners.current.delete(heard)
    },
  }))
  return source
}

import { parseAllDocuments } from 'yaml'
import { kindFor, type ResourceKind } from '@shared/resources'
import type { Status } from './health'

/** A release's status, in KubeStacks' health vocabulary. */
export function releaseStatus(status: string): Status {
  switch (status) {
    case 'deployed':
      return { health: 'healthy', label: 'Deployed' }
    case 'failed':
      return { health: 'critical', label: 'Failed' }
    case 'pending-install':
    case 'pending-upgrade':
    case 'pending-rollback':
      return { health: 'progressing', label: `Pending ${status.slice('pending-'.length)}` }
    case 'uninstalling':
      return { health: 'warning', label: 'Uninstalling' }
    default:
      // superseded, uninstalled (kept with --keep-history), unknown
      return { health: 'neutral', label: status.charAt(0).toUpperCase() + status.slice(1) }
  }
}

type Values = Record<string, unknown>

const isMap = (value: unknown): value is Values =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The values a release runs with: the chart's defaults with the user's on top,
 * the way Helm coalesces them (maps merge, anything else replaces, and null
 * removes a default).
 */
export function coalesce(defaults: Values, values: Values): Values {
  const merged: Values = { ...defaults }
  for (const [key, value] of Object.entries(values)) {
    if (value === null) delete merged[key]
    else merged[key] = isMap(value) && isMap(defaults[key]) ? coalesce(defaults[key], value) : value
  }
  return merged
}

/** One object a release's manifest creates. */
export interface ManifestObject {
  kind: ResourceKind
  apiKind: string
  name: string
  namespace?: string
}

/** The objects a rendered manifest describes, in its order. */
export function manifestObjects(manifest: string): ManifestObject[] {
  return parseAllDocuments(manifest).flatMap((document) => {
    const object = document.toJS() as {
      apiVersion?: string
      kind?: string
      metadata?: { name?: string; namespace?: string }
    } | null
    if (!object?.kind || !object.metadata?.name) return []
    return [
      {
        kind: kindFor(object.apiVersion, object.kind),
        apiKind: object.kind,
        name: object.metadata.name,
        namespace: object.metadata.namespace,
      },
    ]
  })
}

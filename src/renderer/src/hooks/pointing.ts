import { useMemo } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'
import type { KubeObject } from '@shared/api'
import { kindFor, kindOf, type ResourceKind } from '@shared/resources'
import { listedLinks } from '@renderer/lib/plugins'
import { pointingLists, pointsAtOne, targetsOf, type Listed } from '@renderer/lib/pointing'
import { controllerOf } from '@renderer/lib/workloads'
import { usePlugins } from './plugins'
import { useCombinedLists, useList, useObject } from './queries'
import { resourceFor, useResources } from './resources'

/** An object that points at the open one, with the link that says so. */
export interface Pointing extends Omit<Listed, 'labels'> {
  object: KubeObject
}

/** Each list's objects, or nothing where it couldn't be read. (Stable: see `useCombinedLists`.) */
const read = (results: UseQueryResult<KubeObject[]>[]) => results.map((result) => result.data)

/** Kinds whose controller is controlled in turn: a ReplicaSet's Deployment, a Job's CronJob. */
const CONTROLLED: readonly ResourceKind[] = ['ReplicaSet', 'Job']

/**
 * What points at `object` (see lib/pointing): read only where a plugin in use has a link listed
 * where it leads, of a kind the cluster serves, each list by its labels; and then what runs the
 * object and it runs, as far as that's read. Nothing (and no error) of a list that can't be read.
 */
export function usePointing(object: KubeObject): Pointing[] {
  const plugins = usePlugins().data
  const resources = useResources().data
  const listed = useMemo(
    () =>
      plugins && resources
        ? listedLinks().filter(({ kind }) => resources.some((r) => r.kind === kind))
        : [],
    [plugins, resources],
  )
  const asked = listed.length > 0
  const kind = kindOf(object)
  const { namespace } = object.metadata
  const controller = controllerOf(object)
  const above = controller && kindFor(controller.apiVersion ?? 'v1', controller.kind)
  const owner = useObject(
    above ?? 'ReplicaSet',
    controller?.name ?? '',
    namespace,
    asked && above !== undefined && CONTROLLED.includes(above),
  ).data
  const matchLabels = object.spec?.selector?.matchLabels as Record<string, string> | undefined
  const replicaSets = useList('ReplicaSet', {
    namespace: namespace ?? null,
    ...(matchLabels && Object.keys(matchLabels).length
      ? {
          labelSelector: Object.entries(matchLabels)
            .map(([key, value]) => `${key}=${value}`)
            .join(','),
        }
      : {}),
    enabled: asked && kind === 'Deployment',
  }).data
  const lists = useMemo(
    () =>
      asked
        ? pointingLists(
            listed,
            targetsOf(object, owner, replicaSets ?? []),
            namespace,
            (each) => resourceFor(each)?.namespaced,
          )
        : [],
    [asked, listed, object, owner, replicaSets, namespace],
  )
  const found = useCombinedLists(
    lists.map(({ kind: each, namespace: where, labelSelector }) => ({
      kind: each,
      namespace: where,
      labelSelector,
    })),
    read,
  )
  return useMemo(() => {
    // Each object once, where two of its view's links both point here: by the first that does.
    const seen = new Set<string>()
    return lists.flatMap(({ kind: each, view, link }, i) =>
      (found[i] ?? []).flatMap((item) => {
        const { uid, namespace: where, name } = item.metadata
        const key = `${each}/${uid ?? `${where ?? ''}/${name}`}`
        if (seen.has(key) || !pointsAtOne(item, lists[i]!)) return []
        seen.add(key)
        return [{ kind: each, view, link, object: item }]
      }),
    )
  }, [lists, found])
}

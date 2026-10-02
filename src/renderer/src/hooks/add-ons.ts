import { apiGroupOf, type ResourceDefinition, type ResourceKind } from '@shared/resources'
import { allAddOns, everyKindOf, type AddOn } from '@renderer/lib/views'
import { useResources } from './resources'
import { useViews } from './views'

/** An add-on, with those of its kinds the cluster serves, in its order. */
export interface ServedAddOn {
  addOn: AddOn
  kinds: ResourceDefinition[]
}

/**
 * The add-ons of the tools this cluster has (it serves at least one of their
 * kinds), by name.
 */
export function useAddOns(): ServedAddOn[] {
  // Subscribes to the user's add-ons, and to what the cluster serves.
  useViews()
  const resources = useResources().data ?? []
  const served = new Map(resources.map((r) => [r.kind, r]))
  // Every kind of a group: the ones the cluster serves, by name.
  const kindsOf = (kind: ResourceKind) =>
    kind === everyKindOf(kind)
      ? resources
          .filter((r) => r.group === apiGroupOf(kind))
          .sort((a, b) => a.label.localeCompare(b.label))
      : (served.get(kind) ?? [])
  return allAddOns()
    .map((addOn) => ({ addOn, kinds: addOn.kinds.flatMap(kindsOf) }))
    .filter(({ kinds }) => kinds.length > 0)
    .sort((a, b) => a.addOn.label.localeCompare(b.addOn.label, undefined, { sensitivity: 'base' }))
}

/** The add-on a kind's list belongs to, if the cluster has it. */
export function useAddOnOf(kind: ResourceKind | undefined): ServedAddOn | undefined {
  const addOns = useAddOns()
  return kind ? addOns.find(({ kinds }) => kinds.some((r) => r.kind === kind)) : undefined
}

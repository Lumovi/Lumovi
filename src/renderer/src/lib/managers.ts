/**
 * What manages an object (a workload Flux or Argo CD applied, say), as plugins say it: an object
 * of a kind whose view `manages`, whose templates, filled in for the object, come to labels and
 * annotations the object carries, exactly.
 *
 * Each manager's templates are filled in once, when its kind's list is read, with the managed
 * object's own name and the rest left as marks; an object is then found by its values (by what
 * comes before a value's first mark), and only the managers found are checked whole, with its
 * name and the rest in the marks' places.
 */
import type { KubeObject } from '@shared/api'
import { apiGroupOf, apiKindOf, builtinResource, type ResourceKind } from '@shared/resources'
import { MANAGING_MARK, renderManaging, type ManagedObject, type View } from './plugins'

/** An object that manages another. */
export interface Manager {
  kind: ResourceKind
  name: string
  namespace?: string
  /** The view that says it manages: its plugin's. */
  view: View
}

/** What manages each object. */
export interface Managers {
  of: (object: KubeObject, kind: ResourceKind) => Manager[]
}

type From = 'labels' | 'annotations'

/** A label or an annotation a manager's objects carry: its value, with marks for the object's. */
interface Said {
  from: From
  key: string
  value: string
}

interface Candidate {
  manager: Manager
  said: Said[]
}

// (A mark is a character of no script, which a plugin's `manages` can't hold, and a manager's text
// that holds it says nothing: see renderManaging.)
const mark = (letter: string) => `${MANAGING_MARK}${letter}${MANAGING_MARK}`
const MARKS: ManagedObject = {
  group: mark('g'),
  kind: mark('k'),
  namespace: mark('n'),
  name: mark('o'),
}
const MARK = new RegExp(mark('([gkno])'))
const MARKED = new RegExp(MARK.source, 'g')
const FIELDS: Record<string, keyof ManagedObject> = {
  g: 'group',
  k: 'kind',
  n: 'namespace',
  o: 'name',
}

/** A value with the object's own name and the rest where its marks are. */
const filledIn = (value: string, object: ManagedObject) =>
  value.replace(MARKED, (_, mark: string) => object[FIELDS[mark]!])

const valueOf = (object: KubeObject, from: From, key: string): string | undefined => {
  const value = object.metadata[from]?.[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * The managers in `lists` (each a kind's objects, and the view that says how they manage), found
 * by the labels and annotations of what they manage.
 */
export function indexManagers(
  lists: { kind: ResourceKind; view: View; items: readonly KubeObject[] }[],
): Managers {
  // By the first label or annotation each says it with, then by how long its value's start is
  // (what comes before a mark), then by that start.
  const index = new Map<string, Map<number, Map<string, Candidate[]>>>()
  for (const { kind, view, items } of lists) {
    for (const item of items) {
      const manager: Manager = {
        kind,
        name: item.metadata.name,
        ...(item.metadata.namespace ? { namespace: item.metadata.namespace } : {}),
        view,
      }
      for (const entry of view.manages ?? []) {
        const said: Said[] = []
        for (const from of ['labels', 'annotations'] as const) {
          for (const [key, template] of Object.entries(entry[from] ?? {})) {
            const value = renderManaging(template, item, MARKS)
            if (value !== undefined) said.push({ from, key, value })
          }
        }
        const written = Object.keys(entry.labels ?? {}).length
        const all = written + Object.keys(entry.annotations ?? {}).length
        // One that says nothing of its own anywhere (a field it hasn't) manages nothing this way.
        if (said.length < all || said.length === 0) continue
        const [first] = said as [Said]
        const at = first.value.search(MARK)
        const start = at === -1 ? first.value : first.value.slice(0, at)
        const byKey = `${first.from}:${first.key}`
        const byLength = index.get(byKey) ?? new Map<number, Map<string, Candidate[]>>()
        index.set(byKey, byLength)
        const byStart = byLength.get(start.length) ?? new Map<string, Candidate[]>()
        byLength.set(start.length, byStart)
        byStart.set(start, [...(byStart.get(start) ?? []), { manager, said }])
      }
    }
  }
  return {
    of: (object, kind) => {
      const own: ManagedObject = {
        // (Kubernetes' own kinds are named without their group: apps, for a Deployment.)
        group: builtinResource(kind)?.group ?? apiGroupOf(kind),
        kind: apiKindOf(kind),
        namespace: object.metadata.namespace ?? '',
        name: object.metadata.name,
      }
      const found = new Map<string, Manager>()
      for (const [byKey, byLength] of index) {
        const colon = byKey.indexOf(':')
        const value = valueOf(object, byKey.slice(0, colon) as From, byKey.slice(colon + 1))
        if (value === undefined) continue
        for (const [length, byStart] of byLength) {
          if (value.length < length) continue
          for (const { manager, said } of byStart.get(value.slice(0, length)) ?? []) {
            if (said.every((s) => valueOf(object, s.from, s.key) === filledIn(s.value, own))) {
              found.set(`${manager.kind}/${manager.namespace ?? ''}/${manager.name}`, manager)
            }
          }
        }
      }
      return [...found.values()]
    },
  }
}

/**
 * What an object's managers are, as said: each one; or, where several of a kind share a name
 * (Argo CD's tracking id names an Application without its namespace, where it's in Argo CD's
 * own), that name and the namespaces it's in, said once.
 */
export type ManagedBy = Manager | (Omit<Manager, 'namespace'> & { namespaces: string[] })

export function managedBy(managers: readonly Manager[]): ManagedBy[] {
  const byName = new Map<string, Manager[]>()
  for (const manager of managers) {
    const key = `${manager.kind}/${manager.name}`
    byName.set(key, [...(byName.get(key) ?? []), manager])
  }
  return [...byName.values()].map((alike) => {
    const [{ kind, name, view }] = alike as [Manager]
    if (alike.length === 1) return alike[0]!
    return { kind, name, view, namespaces: alike.map((each) => each.namespace ?? '').sort() }
  })
}

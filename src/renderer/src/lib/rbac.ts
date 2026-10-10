/**
 * What roles and bindings hold, read out of their objects: a role's rules, and a binding's
 * role and subjects. Any of them can be absent (a role that allows nothing, a binding to
 * nobody), and a subject can be of a kind this knows nothing of.
 */
import type { KubeObject } from '@shared/api'

/** One of a role's rules: what it allows, on which resources (or which URLs). */
export interface Rule {
  apiGroups?: string[]
  resources?: string[]
  resourceNames?: string[]
  verbs?: string[]
  nonResourceURLs?: string[]
}

/** Whom a binding grants its role to. */
export interface Subject {
  kind?: string
  name?: string
  namespace?: string
}

export interface RoleRef {
  kind?: string
  name?: string
}

export const rulesOf = (role: KubeObject): Rule[] => (role.rules as Rule[] | undefined | null) ?? []
export const subjectsOf = (binding: KubeObject): Subject[] =>
  (binding.subjects as Subject[] | undefined | null) ?? []
export const roleRefOf = (binding: KubeObject): RoleRef =>
  (binding.roleRef as RoleRef | undefined | null) ?? {}

/** The namespace a subject is in: a service account's own, or (unsaid) its binding's. */
export const subjectNamespace = (subject: Subject, binding: KubeObject): string | undefined =>
  subject.kind === 'ServiceAccount' ? (subject.namespace ?? binding.metadata.namespace) : undefined

/** A subject as it's said in a line: "ServiceAccount shop/checkout", "Group platform-team". */
export function subjectText(subject: Subject, binding: KubeObject): string {
  const namespace = subjectNamespace(subject, binding)
  return `${subject.kind ?? 'Subject'} ${namespace ? `${namespace}/` : ''}${subject.name ?? '(unnamed)'}`
}

/** The groups every service account in `namespace` is in, which a binding can name instead. */
export const accountGroups = (namespace: string): string[] => [
  `system:serviceaccounts:${namespace}`,
  'system:serviceaccounts',
  'system:authenticated',
]

/**
 * How a binding reaches the service account `name` in `namespace`, if it does: it names the
 * account (`as` nothing), names it as the user every account also is, or names a group the
 * account is in. Each grants it the binding's role.
 */
export function reaches(
  binding: KubeObject,
  namespace: string,
  name: string,
): { as?: string } | undefined {
  const subjects = subjectsOf(binding)
  if (
    subjects.some(
      (subject) =>
        subject.kind === 'ServiceAccount' &&
        subject.name === name &&
        subjectNamespace(subject, binding) === namespace,
    )
  ) {
    return {}
  }
  const user = `system:serviceaccount:${namespace}:${name}`
  if (subjects.some((subject) => subject.kind === 'User' && subject.name === user)) {
    return { as: `as the user ${user}` }
  }
  const group = accountGroups(namespace).find((one) =>
    subjects.some((subject) => subject.kind === 'Group' && subject.name === one),
  )
  return group ? { as: `through the group ${group}` } : undefined
}

/** A label selector as it's written: its labels, and its expressions (`tier in (a, b)`, `!x`). */
export interface LabelSelector {
  matchLabels?: Record<string, string>
  matchExpressions?: { key?: string; operator?: string; values?: string[] }[]
}

/** A selector as kubectl writes one; "every one", for a selector that asks nothing. */
export function selectorText(selector: LabelSelector | undefined | null): string {
  const terms = [
    ...Object.entries(selector?.matchLabels ?? {}).map(([key, value]) => `${key}=${value}`),
    ...(selector?.matchExpressions ?? []).map(({ key = '', operator, values = [] }) =>
      operator === 'Exists'
        ? key
        : operator === 'DoesNotExist'
          ? `!${key}`
          : `${key} ${operator === 'NotIn' ? 'notin' : 'in'} (${values.join(', ')})`,
    ),
  ]
  return terms.join(', ')
}

/** Whether a selector matches an object's labels, as the API server reads one. */
export function selects(
  selector: LabelSelector | undefined | null,
  labels: Record<string, string> | undefined,
): boolean {
  const has = labels ?? {}
  return (
    Object.entries(selector?.matchLabels ?? {}).every(([key, value]) => has[key] === value) &&
    (selector?.matchExpressions ?? []).every(({ key = '', operator, values = [] }) =>
      operator === 'Exists'
        ? key in has
        : operator === 'DoesNotExist'
          ? !(key in has)
          : operator === 'NotIn'
            ? !(key in has && values.includes(has[key]!))
            : key in has && values.includes(has[key]!),
    )
  )
}

/** The cluster roles whose rules the cluster gathers `role`'s into: those that select it. */
export const gatheredInto = (role: KubeObject, clusterRoles: KubeObject[]): KubeObject[] =>
  clusterRoles.filter(
    (other) =>
      other.metadata.name !== role.metadata.name &&
      (
        (other.aggregationRule as { clusterRoleSelectors?: LabelSelector[] } | undefined)
          ?.clusterRoleSelectors ?? []
      ).some((selector) => selects(selector, role.metadata.labels)),
  )

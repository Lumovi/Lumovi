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

/** Whether a binding names the service account `name` in `namespace`. */
export const namesAccount = (binding: KubeObject, namespace: string, name: string): boolean =>
  subjectsOf(binding).some(
    (subject) =>
      subject.kind === 'ServiceAccount' &&
      subject.name === name &&
      subjectNamespace(subject, binding) === namespace,
  )

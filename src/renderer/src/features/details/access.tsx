/**
 * Who may do what, as a detail panel reads it: a role's rules as a table, a binding's
 * subjects, and the links between them (the bindings that grant a role, and those that name
 * a service account).
 */
import type { ReactNode } from 'react'
import type { KubeObject } from '@shared/api'
import { useList } from '@renderer/hooks/queries'
import {
  gatheredInto,
  reaches,
  roleRefOf,
  rulesOf,
  subjectNamespace,
  selectorText,
  subjectsOf,
  subjectText,
  type LabelSelector,
} from '@renderer/lib/rbac'
import { cn } from '@renderer/lib/cn'
import { ObjectLink } from './ObjectLink'
import { Section, SimpleTable } from './sections'

const Quiet = ({ children }: { children: ReactNode }) => (
  <p className="text-[13px] leading-[21px] text-ink-3">{children}</p>
)

/** `*` is everything; the core API group has no name of its own. */
const all = (values: string[] | undefined, what: string, name = (value: string) => value) =>
  (values ?? []).map((value) => (value === '*' ? `All ${what}` : name(value))).join(', ')

const Verbs = ({ verbs }: { verbs: string[] | undefined }) => (
  <span className="flex flex-wrap gap-1">
    {(verbs ?? []).map((verb) => (
      <span
        key={verb}
        className="rounded-md border border-line bg-surface-2 px-1.5 py-px text-[11px] text-ink-2"
      >
        {verb === '*' ? 'All verbs' : verb}
      </span>
    ))}
  </span>
)

/** A role's rules, a row each: which API groups, which resources, which verbs. */
export function RulesSection({ object }: { object: KubeObject }) {
  const rules = rulesOf(object)
  const aggregated = (
    object.aggregationRule as { clusterRoleSelectors?: LabelSelector[] } | undefined
  )?.clusterRoleSelectors
  return (
    <>
      <Section title="Rules">
        {aggregated && (
          <div className="mb-2.5">
            <Quiet>
              Its rules are gathered by the cluster from{' '}
              {aggregated.map((selector, i) => (
                <span key={i}>
                  {i > 0 && ', and from '}
                  {selectorText(selector) ? (
                    <>
                      the cluster roles labelled{' '}
                      <span className="font-mono text-xs text-ink-2">{selectorText(selector)}</span>
                    </>
                  ) : (
                    // (A selector that asks nothing matches them all.)
                    'every cluster role'
                  )}
                </span>
              ))}
              .
            </Quiet>
          </div>
        )}
        {rules.length === 0 ? (
          <Quiet>No rules: it allows nothing.</Quiet>
        ) : (
          <SimpleTable
            fits
            label="Rules"
            headers={['API groups', 'Resources', 'Verbs']}
            rows={rules.map((rule) =>
              rule.nonResourceURLs?.length
                ? // (A cluster role can allow URLs that are no resource's: /healthz, /metrics.)
                  [
                    <span key="none" className="font-sans text-[13px] text-ink-3">
                      Not a resource
                    </span>,
                    `URLs: ${rule.nonResourceURLs.join(', ')}`,
                    <Verbs key="verbs" verbs={rule.verbs} />,
                  ]
                : [
                    all(rule.apiGroups, 'groups', (group) => group || 'core'),
                    // (Names narrow every resource of the rule, not the last one written: said
                    // on a line of their own.)
                    <span key="resources" className="flex flex-col gap-0.5">
                      <span>{all(rule.resources, 'resources')}</span>
                      {rule.resourceNames?.length ? (
                        <span className="font-sans text-ink-3">
                          only those named{' '}
                          <span className="font-mono text-ink-2">
                            {rule.resourceNames.join(', ')}
                          </span>
                        </span>
                      ) : null}
                    </span>,
                    <Verbs key="verbs" verbs={rule.verbs} />,
                  ],
            )}
          />
        )}
      </Section>
      <BoundBy role={object} />
    </>
  )
}

/** Where a binding reaches: its namespace, or everywhere. */
const reach = (binding: KubeObject) => binding.metadata.namespace ?? 'Everywhere'

const bindingLink = (binding: KubeObject) => (
  <ObjectLink
    key="binding"
    kind={binding.kind!}
    name={binding.metadata.name}
    namespace={binding.metadata.namespace}
  />
)

/** The role a binding grants, as a link; as it's written, where it's no kind of role. */
export function RoleLink({ binding }: { binding: KubeObject }) {
  const { kind, name } = roleRefOf(binding)
  if (!name) return <span className="text-ink-3">None</span>
  if (kind !== 'Role' && kind !== 'ClusterRole') {
    return (
      <span className="font-mono text-xs text-ink-2">
        {kind ?? 'Role'}/{name}
      </span>
    )
  }
  return (
    <ObjectLink
      kind={kind}
      name={name}
      namespace={kind === 'Role' ? binding.metadata.namespace : undefined}
    />
  )
}

/**
 * Both kinds of binding, wherever they are, or why they couldn't be read: someone who may not
 * list them is told so, not shown an empty list.
 */
function useBindings(namespace: string | null, everywhere = true) {
  const namespaced = useList('RoleBinding', { namespace })
  // (Not asked for where none of them could count: nothing is said of what wasn't needed.)
  const clusterWide = useList('ClusterRoleBinding', { namespace: null, enabled: everywhere })
  const failed = [namespaced, clusterWide].find((list) => list.error)
  return {
    bindings: [...(namespaced.data ?? []), ...(clusterWide.data ?? [])],
    pending: namespaced.isPending || (everywhere && clusterWide.isPending),
    failure: failed ? (failed.error as Error).message : undefined,
    /** Some were read, though not all. */
    partial: failed !== undefined && (namespaced.data ?? clusterWide.data) !== undefined,
  }
}

function BindingsTable({
  title,
  empty,
  headers,
  found,
  row,
  children,
}: {
  title: string
  empty: string
  headers: string[]
  found: ReturnType<typeof useBindings> & { matching: KubeObject[] }
  row: (binding: KubeObject) => ReactNode[]
  /** What else is to be said there, after the table. */
  children?: ReactNode
}) {
  const { matching, pending, failure } = found
  return (
    <Section title={title}>
      {matching.length > 0 ? (
        <SimpleTable
          fits
          // (A binding's kind and name are the long ones; where it reaches is a word.)
          widths={['40%', '34%', '26%']}
          label={title}
          headers={headers}
          rows={matching.map(row)}
        />
      ) : pending ? (
        <Quiet>Looking for them…</Quiet>
      ) : (
        // That there's none is said only when every list was read, wherever it reaches: a
        // list that couldn't be is said below instead, and never as nothing found.
        !failure && <Quiet>{empty}</Quiet>
      )}
      {failure && (
        <p role="alert" className="mt-2 text-[13px] leading-[21px] text-ink-2">
          {matching.length > 0 ? 'There may be more: s' : 'S'}ome bindings couldn’t be read.{' '}
          {failure}
        </p>
      )}
      {children}
    </Section>
  )
}

/**
 * The bindings that grant a role, and to whom: the way back from a role. A cluster role's
 * rules are also granted with every cluster role that gathers them (`aggregationRule`), so
 * those are named too, and nothing is said to be granted to nobody while there's one.
 */
function BoundBy({ role }: { role: KubeObject }) {
  const { name, namespace } = role.metadata
  const cluster = role.kind === 'ClusterRole'
  // A Role is granted only where it is, and only by a RoleBinding; a ClusterRole, in any
  // namespace or everywhere.
  const found = useBindings(cluster ? null : namespace!, cluster)
  const others = useList('ClusterRole', { namespace: null, enabled: cluster })
  const into = cluster ? gatheredInto(role, others.data ?? []) : []
  const unread = cluster && others.error ? (others.error as Error).message : undefined
  const matching = found.bindings.filter((binding) => {
    const ref = roleRefOf(binding)
    return ref.kind === role.kind && ref.name === name
  })
  return (
    <BindingsTable
      title="Granted by"
      empty={
        into.length > 0 || unread
          ? 'No binding grants it by its own name.'
          : 'No binding grants it to anyone.'
      }
      headers={['Binding', 'To', 'In']}
      found={{ ...found, matching, pending: found.pending || (cluster && others.isPending) }}
      row={(binding) => [
        bindingLink(binding),
        subjectsOf(binding)
          .map((subject) => subjectText(subject, binding))
          .join(', ') || 'Nobody',
        reach(binding),
      ]}
    >
      {into.length > 0 && (
        // (Under a finger, two links on two lines are a finger's height apart.)
        <p
          className={cn(
            'mt-2 text-[13px] leading-[21px] text-ink-2',
            into.length > 1 && 'touch:leading-[44px]',
          )}
        >
          Its rules are also part of{' '}
          {into.map((other, i) => (
            <span key={other.metadata.name}>
              {i > 0 && (i === into.length - 1 ? ' and ' : ', ')}
              <ObjectLink kind="ClusterRole" name={other.metadata.name} />
            </span>
          ))}
          , which {into.length === 1 ? 'gathers' : 'gather'} them: whoever{' '}
          {into.length === 1 ? 'that is' : 'those are'} granted to has them too.
        </p>
      )}
      {unread && (
        <p role="alert" className="mt-2 text-[13px] leading-[21px] text-ink-2">
          Whether another cluster role gathers its rules couldn’t be read. {unread}
        </p>
      )}
    </BindingsTable>
  )
}

/** Whom a binding grants its role to. */
export function SubjectsSection({ object }: { object: KubeObject }) {
  const subjects = subjectsOf(object)
  return (
    <Section title="Subjects">
      {subjects.length === 0 ? (
        <Quiet>No subjects: it grants its role to nobody.</Quiet>
      ) : (
        <SimpleTable
          fits
          label="Subjects"
          headers={['Kind', 'Name', 'Namespace']}
          rows={subjects.map((subject) => {
            // A service account named without a namespace is the binding's own.
            const namespace = subjectNamespace(subject, object)
            return [
              subject.kind ?? '—',
              subject.kind === 'ServiceAccount' && subject.name && namespace ? (
                <ObjectLink
                  key="account"
                  kind="ServiceAccount"
                  name={subject.name}
                  namespace={namespace}
                />
              ) : (
                (subject.name ?? '—')
              ),
              namespace ?? '—',
            ]
          })}
        />
      )}
    </Section>
  )
}

/**
 * The bindings that reach a service account, and the role each grants it: those that name it,
 * and those that name a group it's in (its namespace's accounts, every account, everyone
 * signed in), which grant it as much.
 */
export function AccountBindings({ object }: { object: KubeObject }) {
  const { name, namespace } = object.metadata
  const found = useBindings(null)
  const how = new Map(
    found.bindings.flatMap((binding) => {
      const reached = reaches(binding, namespace!, name)
      return reached ? [[binding, reached.as] as const] : []
    }),
  )
  // Those that name it first; then those that reach it another way.
  const matching = [...how.keys()].sort(
    (a, b) => Number(how.get(a) !== undefined) - Number(how.get(b) !== undefined),
  )
  return (
    <BindingsTable
      title="Bindings"
      empty="No binding names it, or a group it’s in."
      headers={['Binding', 'Grants', 'In']}
      found={{ ...found, matching }}
      row={(binding) => [
        <span key="binding" className="flex flex-col items-start gap-0.5">
          {bindingLink(binding)}
          {how.get(binding) && (
            <span className="font-sans text-xs text-ink-3">{how.get(binding)}</span>
          )}
        </span>,
        <RoleLink key="role" binding={binding} />,
        reach(binding),
      ]}
    />
  )
}

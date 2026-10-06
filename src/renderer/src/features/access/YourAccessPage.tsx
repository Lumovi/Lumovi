/**
 * Your access: what Lumovi lets the person do, cluster by cluster, and why:
 * their groups, the grants that give them more than everyone gets, and the
 * limits that hold them back. Every refusal links here.
 */
import { useEffect, useMemo } from 'react'
import { Link, Navigate } from 'react-router'
import {
  CAPABILITY_KEYS,
  CAPABILITY_TEXT,
  myDecider,
  SCOPES,
  type AccessDecision,
  type MyAccess,
} from '@shared/access'
import { buttonClass } from '@renderer/components/Button'
import { Loading } from '@renderer/components/States'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { useSession } from '@renderer/state/session'
import { useNamespaceIndex } from '../assistants/namespaces'
import {
  beyondEveryone,
  levelLabel,
  limitEffects,
  sentGroups,
  summarize,
  whereOf,
  whoOf,
  type Summary,
} from './access-model'
import { listed } from './NotAllowed'
import { Frame, Initial, Pill } from './parts'
import { useClusters, useMyAccess } from './use-access'

/** The columns: everything decided cluster by cluster (whose audit events, anywhere, below). */
const COLUMNS = CAPABILITY_KEYS.filter((key) => SCOPES[key] !== 'anywhere')

export function YourAccessPage() {
  useEffect(() => {
    document.title = 'Your access — Lumovi'
  }, [])
  const mine = useMyAccess()
  if (!api.access) return <Navigate replace to="/" />
  return (
    <Frame
      title="Your access"
      subtitle="What Lumovi lets you do, and why."
      intro={
        <p>
          Your groups, and the rules Lumovi’s admins set, decide it. What your own Kubernetes access
          (RBAC) allows still applies: Lumovi never lets you do more.
        </p>
      }
    >
      {mine ? <Yours mine={mine} /> : <Loading label="Reading your access…" className="py-24" />}
    </Frame>
  )
}

function Yours({ mine }: { mine: MyAccess }) {
  const session = useSession()
  const contexts = useClusters()
  const index = useNamespaceIndex(contexts)
  const decide = useMemo(() => myDecider(mine), [mine])
  const { policy } = mine
  const sent = sentGroups(mine.person.groups)
  const audit = decide({ cluster: { name: '' } }).audit
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start gap-5">
        <section
          aria-labelledby="you-heading"
          className="flex min-w-0 flex-[1_1_300px] flex-col gap-3.5 rounded-xl border border-line bg-surface p-4"
        >
          <h2 id="you-heading" className="text-[15px] font-semibold tracking-[-0.01em] text-ink-1">
            You
          </h2>
          <div className="flex items-center gap-2.5">
            <Initial name={mine.person.name} />
            <div className="min-w-0">
              <div className="truncate font-semibold text-ink-1">{mine.person.name}</div>
              <div className="text-xs text-ink-3">Signed in with {mine.provider}</div>
            </div>
          </div>
          <dl className="flex flex-col gap-2.5">
            <div>
              <dt className="text-xs text-ink-3">Your groups in {mine.provider}</dt>
              <dd className="mt-1 flex flex-wrap gap-1">
                {sent.map((id) => (
                  <span
                    key={id}
                    className="rounded-md bg-surface-3 px-2 py-px font-mono text-2xs text-ink-2"
                  >
                    {id}
                  </span>
                ))}
                {sent.length === 0 && (
                  <span className="text-xs text-ink-2">None arrived as you signed in</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-ink-3">So in Lumovi’s groups</dt>
              <dd className="mt-1 flex flex-wrap gap-1">
                {policy.groups.map((g) => (
                  <Pill key={g.id} tone="strong">
                    {g.name}
                  </Pill>
                ))}
                {policy.groups.length === 0 && (
                  <span className="text-xs text-ink-2">None: you get what everyone does</span>
                )}
              </dd>
            </div>
          </dl>
          {mine.admin ? (
            <div className="flex flex-wrap items-center gap-2 rounded-[10px] bg-surface-2 px-3 py-2.5 text-xs text-ink-2">
              <span className="flex-1">
                You’re one of Lumovi’s admins: you decide who may do what.
              </span>
              <Link to="/access" className={buttonClass('secondary', 'h-7 text-xs')}>
                Open Admin
              </Link>
            </div>
          ) : (
            <p className="rounded-[10px] bg-surface-2 px-3 py-2.5 text-xs text-ink-2">
              Need more? Lumovi’s admins decide it
              {mine.admins.length ? `: ${listed(mine.admins)}.` : '.'}
            </p>
          )}
        </section>

        <section
          aria-labelledby="clusters-heading"
          className="flex min-w-0 flex-[999_1_640px] flex-col gap-2.5"
        >
          <div>
            <h2
              id="clusters-heading"
              className="text-[15px] font-semibold tracking-[-0.01em] text-ink-1"
            >
              {session?.fleet ? 'Cluster by cluster' : 'In this cluster'}
            </h2>
            <p className="mt-0.5 text-xs text-ink-3">
              Where it differs from namespace to namespace, how many allow it.
            </p>
          </div>
          <div className="overflow-x-auto rounded-xl border border-line bg-surface">
            <table className="w-full min-w-[880px] border-collapse">
              <thead>
                <tr className="bg-surface-2">
                  <th
                    scope="col"
                    className="px-3.5 py-2.5 text-left text-xs font-medium text-ink-2"
                  >
                    Cluster
                  </th>
                  {COLUMNS.map((key) => (
                    <th
                      key={key}
                      scope="col"
                      className="px-3 py-2.5 text-left text-xs font-medium whitespace-nowrap text-ink-2"
                    >
                      {CAPABILITY_TEXT[key].label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {contexts.map((cluster) => {
                  const namespaces = index.namespaces.filter(
                    (ns) => ns.cluster.name === cluster.name,
                  )
                  const counting = index.counting.includes(cluster.name)
                  const failed = index.failed.some((f) => f.context === cluster.name)
                  const own = decide({ cluster: { name: cluster.name, labels: cluster.labels } })
                  // Namespace by namespace; none listed (they can't be): the cluster's own.
                  const decisions: AccessDecision[] = namespaces.length
                    ? namespaces.map((ns) =>
                        decide({
                          cluster: { name: cluster.name, labels: cluster.labels },
                          namespace: { name: ns.name, labels: ns.labels },
                        }),
                      )
                    : [own]
                  return (
                    <tr key={cluster.name}>
                      <th
                        scope="row"
                        className="border-t border-line/70 px-3.5 py-3 text-left align-top font-normal"
                      >
                        <div className="text-[13px] font-semibold text-ink-1">{cluster.name}</div>
                        {cluster.labels && Object.keys(cluster.labels).length > 0 && (
                          <div className="font-mono text-2xs text-ink-3">
                            {Object.entries(cluster.labels)
                              .map(([k, v]) => `${k}=${v}`)
                              .join(' ')}
                          </div>
                        )}
                      </th>
                      {COLUMNS.map((key) => (
                        <td key={key} className="border-t border-line/70 px-3 py-3 align-top">
                          <Cell
                            summary={summarize(key, SCOPES[key] === 'cluster' ? [own] : decisions)}
                            pending={counting && SCOPES[key] === 'namespace'}
                            note={
                              failed && SCOPES[key] === 'namespace'
                                ? 'its namespaces can’t be listed'
                                : undefined
                            }
                          />
                        </td>
                      ))}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-ink-2">
            Everywhere:{' '}
            {audit.value === 'all'
              ? 'everyone’s events in the audit log.'
              : 'your own events in the audit log.'}
          </p>
        </section>
      </div>
      <Why mine={mine} />
    </div>
  )
}

function Cell({ summary, pending, note }: { summary: Summary; pending: boolean; note?: string }) {
  if (pending) return <span className="text-xs text-ink-3">Counting…</span>
  return (
    <>
      <div
        className={cn(
          'text-[13px] font-semibold whitespace-nowrap',
          summary.sensitive ? 'text-warn-text' : summary.none ? 'text-ink-3' : 'text-ink-1',
        )}
      >
        {summary.value}
      </div>
      <div className="text-2xs text-ink-3">{note ?? summary.note}</div>
    </>
  )
}

/** The grants that give them more than everyone gets, and the limits that hold them back. */
function Why({ mine }: { mine: MyAccess }) {
  const { policy } = mine
  const rows = [
    {
      kind: 'Everyone',
      name: 'What everyone signed in gets',
      where: 'Everyone  →  all clusters  /  all namespaces',
      effects: CAPABILITY_KEYS.map(
        (key) => `${CAPABILITY_TEXT[key].label}: ${levelLabel(key, policy.everyone[key] as never)}`,
      ),
      limit: false,
    },
    ...policy.grants.map((g) => {
      // (Someone's share holds the profiles their grants give.)
      const profile = policy.profiles.find((p) => p.id === g.profile)!
      return {
        kind: 'Grant',
        name: g.name,
        where: `${whoOf(policy, g).join(', ')}  →  ${whereOf(g)}`,
        effects: [profile.name, ...beyondEveryone(policy, profile.values)],
        limit: false,
      }
    }),
    ...policy.limits.map((l) => ({
      kind: 'Limit',
      name: l.name,
      where: `${l.who.length ? whoOf(policy, l).join(', ') : 'Everyone'}  →  ${whereOf(l)}`,
      effects: limitEffects(l),
      limit: true,
    })),
  ]
  return (
    <section aria-labelledby="why-heading" className="flex flex-col gap-2.5">
      <div>
        <h2 id="why-heading" className="text-[15px] font-semibold tracking-[-0.01em] text-ink-1">
          Why
        </h2>
        <p className="mt-0.5 text-xs text-ink-3">
          What everyone gets, the grants that give you more, and the limits that hold you back.
          Where grants overlap, you get the most of them; limits win over all of them.
        </p>
      </div>
      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        {rows.map((row, i) => (
          <div
            key={`${row.kind}-${row.name}`}
            className={cn(
              'flex flex-wrap items-center gap-3.5 px-4 py-3',
              i > 0 && 'border-t border-line',
            )}
          >
            <Pill
              tone={row.kind === 'Limit' ? 'limit' : row.kind === 'Grant' ? 'strong' : 'plain'}
              className="text-2xs"
            >
              {row.kind}
            </Pill>
            <span className="flex min-w-0 flex-[1_1_320px] flex-col">
              <span className="font-semibold text-ink-1">{row.name}</span>
              <span className="truncate font-mono text-xs text-ink-3">{row.where}</span>
            </span>
            <span className="flex max-w-[560px] flex-wrap gap-1.5">
              {row.effects.map((text) => (
                <Pill key={text} tone={row.limit ? 'limit' : 'plain'}>
                  {text}
                </Pill>
              ))}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

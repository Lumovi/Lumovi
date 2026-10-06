/**
 * Check someone: what they may do anywhere, and which rule says so, as they
 * last signed in, with the changes being made (saved or not), so a change
 * can be tried before it's saved.
 */
import { Search, Server } from 'lucide-react'
import { useState } from 'react'
import {
  accessDecider,
  CAPABILITY_KEYS,
  CAPABILITY_TEXT,
  groupsOf,
  namedIn,
  rankOf,
  SCOPES,
  type SeenPerson,
} from '@shared/access'
import { age } from '@renderer/lib/format'
import { cn } from '@renderer/lib/cn'
import { Segmented } from '../assistants/PageParts'
import type { TabProps } from './AccessPage'
import {
  decideAll,
  groupTitle,
  isSensitive,
  levelLabel,
  plural,
  sentGroups,
  sourceParts,
} from './access-model'
import { Initial, Pill } from './parts'

export function CheckTab({ policy, admin, clusters: contexts, index }: TabProps) {
  const { seen, provider } = admin
  // To start: the admin, seen as their page connected (the latest), in the first cluster.
  const [who, setWho] = useState(seen[0]!.name)
  const [cluster, setCluster] = useState(contexts[0]!.name)
  const [namespace, setNamespace] = useState<string | null | undefined>(undefined)
  // The React compiler keeps these until what they're made of changes.
  const person: SeenPerson = seen.find((p) => p.name === who) ?? {
    name: who,
    groups: [],
    seen: '',
    via: provider.mode,
  }
  const here = index.namespaces.filter((ns) => ns.cluster.name === cluster)
  // The namespace looked at: the one picked, else the cluster's first.
  const picked = namespace === undefined ? (here[0]?.name ?? null) : namespace
  const target = here.find((ns) => ns.name === picked)
  const context = contexts.find((c) => c.name === cluster)
  const decision = accessDecider(
    policy,
    person,
  )({
    cluster: { name: cluster, labels: context?.labels },
    ...(target ? { namespace: { name: target.name, labels: target.labels } } : {}),
  })
  const everywhere = decideAll(policy, person, index.namespaces)
  const lumoviGroups = groupsOf(policy, person).map(
    (id) => policy.groups.find((g) => g.id === id)!.name,
  )
  const sent = sentGroups(person.groups)
  const auditor = namedIn(admin.auditors, person)
  const count = (test: (d: (typeof everywhere)[number]['decision']) => boolean) =>
    everywhere.filter(({ decision: d }) => test(d)).length
  const nodeClusters = new Set(
    everywhere
      .filter(({ decision: d }) => d.nodeShells.value === 'on')
      .map(({ ns }) => ns.cluster.name),
  ).size

  return (
    <div className="flex flex-wrap items-start gap-5">
      <section
        aria-labelledby="who-heading"
        className="flex min-w-0 flex-[1_1_320px] flex-col gap-3 rounded-xl border border-line bg-surface p-4"
      >
        <div>
          <h2 id="who-heading" className="text-[15px] font-semibold tracking-[-0.01em] text-ink-1">
            Check someone
          </h2>
          <p className="mt-0.5 text-xs text-ink-3">
            What they may do, where, and which rule says so: as they last signed in, with the
            changes made here, saved or not.
          </p>
        </div>
        <Finder
          label="Person"
          placeholder={`Search ${plural(seen.length, 'person', 'people')} who signed in`}
          items={seen.map((p) => ({
            value: p.name,
            text: p.name,
            note:
              groupsOf(policy, p)
                .map((id) => policy.groups.find((g) => g.id === id)!.name)
                .join(', ') || 'No group',
          }))}
          free
          onPick={setWho}
        />
        <div className="flex items-center gap-2.5 pt-1">
          <Initial name={person.name} />
          <div className="min-w-0">
            <div className="truncate font-semibold text-ink-1">{person.name}</div>
            <div className="text-xs text-ink-3">
              {person.seen
                ? `Signed in ${age(person.seen)} ago, ${VIA[person.via]}`
                : 'Not seen signing in lately: checked as named, with no groups'}
            </div>
          </div>
        </div>
        <dl className="flex flex-col gap-2.5">
          <div>
            <dt className="text-xs text-ink-3">Groups from {provider.name}</dt>
            <dd className="mt-1 flex flex-wrap gap-1">
              {sent.map((id) => (
                <span
                  key={id}
                  className="rounded-md bg-surface-3 px-2 py-px font-mono text-2xs text-ink-2"
                >
                  {groupTitle(policy, id)}
                </span>
              ))}
              {sent.length === 0 && <span className="text-xs text-warn-text">None arrived</span>}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-3">In Lumovi’s groups</dt>
            <dd className="mt-1 flex flex-wrap gap-1">
              {lumoviGroups.map((name) => (
                <Pill key={name} tone="strong">
                  {name}
                </Pill>
              ))}
              {lumoviGroups.length === 0 && (
                <span className="text-xs text-ink-2">None: what everyone gets</span>
              )}
            </dd>
          </div>
        </dl>
        <div className="flex flex-col gap-px overflow-hidden rounded-[10px] border border-line bg-line">
          {[
            {
              value: count((d) => d.changes.value === 'write'),
              label: 'namespaces they may change',
            },
            {
              value: count((d) => d.shells.value === 'on'),
              label: 'namespaces they may open shells in',
            },
            {
              value: count((d) => d.secrets.value === 'values'),
              label: 'namespaces whose Secret values they see',
            },
            { value: nodeClusters, label: 'clusters whose nodes they may open shells on' },
          ].map((item) => (
            <div key={item.label} className="flex items-baseline gap-2.5 bg-surface-2 px-3 py-2">
              <span className="min-w-11 font-mono text-sm font-medium text-ink-1 tabular-nums">
                {item.value.toLocaleString('en-US')}
              </span>
              <span className="text-xs text-ink-2">{item.label}</span>
            </div>
          ))}
        </div>
      </section>

      <section
        aria-labelledby="where-heading"
        className="flex min-w-0 flex-[999_1_560px] flex-col gap-3 rounded-xl border border-line bg-surface p-4"
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-[1_1_240px]">
            <h2
              id="where-heading"
              className="text-[15px] font-semibold tracking-[-0.01em] text-ink-1"
            >
              Where
            </h2>
            <p className="mt-0.5 text-xs text-ink-3">A cluster, and one of its namespaces.</p>
          </div>
          {contexts.length > 1 && (
            <Segmented
              label="Cluster"
              value={cluster}
              choices={contexts.map((c) => ({ value: c.name, label: c.name }))}
              onChange={(name) => {
                setCluster(name)
                setNamespace(undefined)
              }}
            />
          )}
        </div>
        <Finder
          key={cluster}
          label="Namespace"
          placeholder={`Search ${plural(here.length, 'namespace', 'namespaces')} in ${cluster}`}
          items={[
            { value: '', text: 'Its own objects', note: 'nodes, and what has no namespace' },
            ...here.map((ns) => ({
              value: ns.name,
              text: ns.name,
              note: Object.entries(ns.labels)
                .map(([k, v]) => `${k}=${v}`)
                .join(' '),
              mono: true,
            })),
          ]}
          onPick={(name) => setNamespace(name || null)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full bg-ink-1 px-2 py-px text-2xs text-surface">
            <Server aria-hidden className="size-3" /> {cluster}
          </span>
          <span className="font-mono text-[15px] font-medium text-ink-1">
            {target ? target.name : 'Its own objects'}
          </span>
          {target &&
            Object.entries(target.labels).map(([k, v]) => (
              <span
                key={k}
                className="rounded-full bg-surface-3 px-2 py-px font-mono text-2xs text-ink-2"
              >
                {k}={v}
              </span>
            ))}
        </div>
        <div className="overflow-x-auto rounded-[10px] border border-line">
          <table className="w-full min-w-[560px] border-collapse">
            <thead>
              <tr className="bg-surface-2">
                {['May', 'Here', 'Because'].map((h) => (
                  <th
                    key={h}
                    scope="col"
                    className="px-3 py-2 text-left text-xs font-medium text-ink-2"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {CAPABILITY_KEYS.map((key) => {
                const d = decision[key]
                // The server's own setting: everyone's audit events, whatever access says.
                const named = key === 'audit' && auditor
                const value = named ? 'all' : d.value
                const source = named
                  ? { kind: 'Server', text: 'LUMOVI_AUDITORS names them' }
                  : sourceParts(d.from)
                const capped = !named && d.from.kind === 'limit' && d.granted !== d.value
                return (
                  <tr key={key}>
                    <th
                      scope="row"
                      className="border-t border-line/70 px-3 py-2.5 text-left align-top text-[13px] font-medium whitespace-nowrap text-ink-1"
                    >
                      {CAPABILITY_TEXT[key].label}
                      <div className="text-2xs font-normal text-ink-3">
                        {SCOPES[key] === 'cluster'
                          ? `on ${cluster}’s nodes`
                          : SCOPES[key] === 'anywhere'
                            ? 'anywhere'
                            : ''}
                      </div>
                    </th>
                    <td className="border-t border-line/70 px-3 py-2.5 align-top">
                      <span
                        className={cn(
                          'text-[13px] font-semibold',
                          isSensitive(key, value)
                            ? 'text-warn-text'
                            : rankOf(key, value as never) === 0
                              ? 'text-ink-3'
                              : 'text-ink-1',
                        )}
                      >
                        {levelLabel(key, value as never)}
                      </span>
                      {capped && (
                        <div className="text-xs text-ink-3">
                          Grants would give {levelLabel(key, d.granted as never).toLowerCase()}
                        </div>
                      )}
                    </td>
                    <td className="border-t border-line/70 px-3 py-2.5 align-top">
                      <span className="inline-flex flex-wrap items-center gap-1.5 text-[13px] text-ink-1">
                        <Pill
                          tone={
                            source.kind === 'Limit'
                              ? 'limit'
                              : source.kind === 'Grant'
                                ? 'strong'
                                : 'plain'
                          }
                          className="py-px text-2xs"
                        >
                          {source.kind}
                        </Pill>
                        {source.text}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-ink-3">
          Their own access in the cluster (RBAC) still applies: Lumovi never lets anyone do what
          Kubernetes wouldn’t.
        </p>
      </section>
    </div>
  )
}

/** How someone signed in, as it's said after when. */
const VIA: Record<SeenPerson['via'], string> = {
  oidc: 'with single sign-on',
  proxy: 'through the proxy',
  token: 'with a token',
}

/** A search that finds one of many: arrows choose, Enter picks (or, `free`, takes what's typed). */
function Finder({
  label,
  placeholder,
  items,
  free,
  onPick,
}: {
  label: string
  placeholder: string
  items: { value: string; text: string; note: string; mono?: boolean }[]
  free?: boolean
  onPick: (value: string) => void
}) {
  const [typed, setTyped] = useState('')
  const [active, setActive] = useState(0)
  const q = typed.trim().toLowerCase()
  const matching = q
    ? items
        .filter((i) => i.text.toLowerCase().includes(q) || i.note.toLowerCase().includes(q))
        .slice(0, 7)
    : []
  // Anyone at all, as typed, where that's allowed: checked as named.
  const found =
    free && q && !matching.some((i) => i.value === typed.trim())
      ? [...matching, { value: typed.trim(), text: typed.trim(), note: 'as named' }]
      : matching
  const chosen = Math.min(active, Math.max(found.length - 1, 0))
  const pick = (value: string) => {
    onPick(value)
    setTyped('')
    setActive(0)
  }
  return (
    <div className="flex flex-col gap-1">
      <label className="flex h-9 items-center gap-2 rounded-lg border border-line-strong bg-surface px-2.5 focus-within:border-accent focus-within:ring-3 focus-within:ring-accent-soft">
        <Search aria-hidden className="size-3.5 text-ink-3" />
        <input
          type="search"
          role="combobox"
          aria-label={label}
          aria-expanded={found.length > 0}
          autoComplete="off"
          value={typed}
          placeholder={placeholder}
          onChange={(event) => {
            setTyped(event.target.value)
            setActive(0)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' && found.length) {
              event.preventDefault()
              setActive((chosen + 1) % found.length)
            } else if (event.key === 'ArrowUp' && found.length) {
              event.preventDefault()
              setActive((chosen - 1 + found.length) % found.length)
            } else if (event.key === 'Enter') {
              event.preventDefault()
              if (found.length) pick(found[chosen]!.value)
            } else if (event.key === 'Escape' && typed) {
              event.stopPropagation()
              setTyped('')
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-ink-1 outline-none placeholder:text-ink-3"
        />
      </label>
      {found.length > 0 && (
        <div
          role="listbox"
          aria-label={`${label}s found`}
          className="flex animate-fade-in flex-col rounded-lg border border-line-strong bg-surface p-1 shadow-pop"
        >
          {found.map((item, i) => (
            <div
              key={item.value}
              role="option"
              aria-selected={i === chosen}
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => setActive(i)}
              onClick={() => pick(item.value)}
              className={cn(
                'flex min-h-8 cursor-default items-center gap-2 rounded-md px-2',
                i === chosen && 'bg-accent-soft',
              )}
            >
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-[13px] text-ink-1',
                  item.mono && 'font-mono text-xs',
                )}
              >
                {item.text}
              </span>
              <span className="truncate text-2xs text-ink-3">{item.note}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

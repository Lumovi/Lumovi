/**
 * Grants and limits. A grant gives groups a profile, where it says; someone
 * in several gets the most any gives them. A limit wins over every grant:
 * nobody it names, wherever it matches, gets more than it says. Each says
 * how far it reaches: the people, namespaces and clusters.
 */
import { Plus } from 'lucide-react'
import { useState } from 'react'
import {
  CAPABILITIES,
  CAPABILITY_KEYS,
  CAPABILITY_TEXT,
  type AccessGrant,
  type AccessLimit,
  type AccessPolicy,
  type Capability,
} from '@shared/access'
import { parseMatcher, whereTest } from '@shared/ai-permissions'
import { Button } from '@renderer/components/Button'
import { Tooltip } from '@renderer/components/Tooltip'
import type { KubeContext } from '@shared/api'
import { Segmented } from '../assistants/PageParts'
import type { IndexedNamespace } from '../assistants/namespaces'
import type { TabProps } from './AccessPage'
import {
  beyondEveryone,
  limitEffects,
  membersOf,
  namedBy,
  newId,
  plural,
  reachedBy,
  whereOf,
  whoOf,
} from './access-model'
import {
  ChipField,
  DeleteButton,
  Expandable,
  LockedBadge,
  Note,
  Pill,
  Reach,
  SectionHead,
  TextField,
  type Suggestion,
} from './parts'

type Rule = AccessGrant | AccessLimit
const isGrant = (rule: Rule): rule is AccessGrant => 'profile' in rule

export function RulesTab({ policy, update, admin, clusters: contexts, index }: TabProps) {
  const [open, setOpen] = useState<string | null>(null)
  const addGrant = () => {
    const id = newId('grant')
    update((p) => ({
      ...p,
      grants: [
        ...p.grants,
        {
          id,
          name: 'New grant',
          who: [],
          profile: p.profiles[0]!.id,
          clusters: [],
          namespaces: [],
        },
      ],
    }))
    setOpen(id)
  }
  const addLimit = () => {
    const id = newId('limit')
    update((p) => ({
      ...p,
      limits: [
        ...p.limits,
        { id, name: 'New limit', who: [], clusters: [], namespaces: [], caps: {} },
      ],
    }))
    setOpen(id)
  }
  const change = (rule: Rule) =>
    update((p) =>
      isGrant(rule)
        ? { ...p, grants: p.grants.map((g) => (g.id === rule.id ? rule : g)) }
        : { ...p, limits: p.limits.map((l) => (l.id === rule.id ? rule : l)) },
    )
  const remove = (rule: Rule) => {
    update((p) =>
      isGrant(rule)
        ? { ...p, grants: p.grants.filter((g) => g.id !== rule.id) }
        : { ...p, limits: p.limits.filter((l) => l.id !== rule.id) },
    )
    setOpen(null)
  }
  const card = (rule: Rule) => (
    <RuleCard
      key={rule.id}
      rule={rule}
      policy={policy}
      seen={admin.seen}
      namespaces={index.namespaces}
      clusters={contexts}
      open={open === rule.id}
      onToggle={() => setOpen(open === rule.id ? null : rule.id)}
      onChange={change}
      onDelete={() => remove(rule)}
    />
  )
  const newGrant = (
    <Button variant="secondary" disabled={policy.profiles.length === 0} onClick={addGrant}>
      <Plus /> New grant
    </Button>
  )
  return (
    <div className="flex flex-col gap-7">
      <section aria-label="Grants" className="flex flex-col gap-2.5">
        <SectionHead
          title="Grants"
          count={policy.grants.length}
          action={
            policy.profiles.length ? (
              newGrant
            ) : (
              <Tooltip content="Make a profile first, in Profiles: a grant gives one">
                <span tabIndex={0}>{newGrant}</span>
              </Tooltip>
            )
          }
        >
          Who gets which profile, and where. Someone in several groups gets the most any grant gives
          them, setting by setting.
        </SectionHead>
        {policy.grants.length === 0 && (
          <Empty>No grants yet: everyone gets what the Everyone profile says, everywhere.</Empty>
        )}
        {policy.grants.map(card)}
      </section>
      <section aria-label="Limits" className="flex flex-col gap-2.5">
        <SectionHead
          title="Limits"
          count={policy.limits.length}
          action={
            <Button variant="secondary" onClick={addLimit}>
              <Plus /> New limit
            </Button>
          }
        >
          They win over every grant: nobody they name, wherever they match, gets more than they say.
          Kubernetes RBAC still applies after both.
        </SectionHead>
        {policy.limits.length === 0 && (
          <Empty>
            No limits yet. Production, or namespaces with card data, are where they help most.
          </Empty>
        )}
        {policy.limits.map(card)}
      </section>
    </div>
  )
}

const Empty = ({ children }: { children: string }) => (
  <div className="rounded-xl border border-dashed border-line-strong px-5 py-6 text-center text-[13px] text-ink-2">
    {children}
  </div>
)

function RuleCard({
  rule,
  policy,
  seen,
  namespaces,
  clusters,
  open,
  onToggle,
  onChange,
  onDelete,
}: {
  rule: Rule
  policy: AccessPolicy
  seen: TabProps['admin']['seen']
  namespaces: IndexedNamespace[]
  clusters: KubeContext[]
  open: boolean
  onToggle: () => void
  onChange: (rule: Rule) => void
  onDelete: () => void
}) {
  const grant = isGrant(rule)
  const who = whoOf(policy, rule)
  const people = namedBy(policy, rule, seen)
  const reached = reachedBy(rule, namespaces)
  const profile = grant ? policy.profiles.find((p) => p.id === rule.profile) : undefined
  const effects = grant ? [] : limitEffects(rule)
  return (
    <Expandable
      label={rule.name}
      open={open}
      onToggle={onToggle}
      muted={rule.locked}
      head={
        <>
          <span className="flex min-w-0 flex-[1_1_280px] flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-ink-1">{rule.name || 'Untitled'}</span>
              {rule.locked && <LockedBadge />}
            </span>
            <span className="flex flex-wrap items-center gap-1.5 text-xs text-ink-2">
              {(who.length ? who : [grant ? 'Nobody yet' : 'Everyone']).map((name) => (
                <span key={name} className="rounded-md bg-surface-3 px-1.5 text-ink-1">
                  {name}
                </span>
              ))}
              <span className="text-ink-3">in</span>
              <span className="truncate font-mono text-ink-3">{whereOf(rule)}</span>
            </span>
          </span>
          <span className="flex max-w-[420px] flex-wrap gap-1.5">
            {grant ? (
              <Pill tone="strong">{profile!.name}</Pill>
            ) : effects.length ? (
              effects.map((text) => (
                <Pill key={text} tone="limit">
                  {text}
                </Pill>
              ))
            ) : (
              <Pill tone="empty">Limits nothing yet</Pill>
            )}
          </span>
          <span className="min-w-[150px] text-right text-xs whitespace-nowrap text-ink-3">
            {plural(people.length, 'person', 'people')} ·{' '}
            {plural(reached.length, 'namespace', 'namespaces')}
          </span>
        </>
      }
    >
      <RuleEditor
        rule={rule}
        policy={policy}
        seen={seen}
        namespaces={namespaces}
        clusters={clusters}
        people={people.length}
        reached={reached}
        onChange={onChange}
        onDelete={onDelete}
        onDone={onToggle}
      />
    </Expandable>
  )
}

/** "label", "pattern", "not": what a matcher is, by how it's written. */
const kindOf = (text: string) =>
  text.startsWith('!') ? 'not' : text.includes('=') ? 'label' : text.includes('*') ? 'pattern' : ''

function RuleEditor({
  rule,
  policy,
  seen,
  namespaces,
  clusters,
  people,
  reached,
  onChange,
  onDelete,
  onDone,
}: {
  rule: Rule
  policy: AccessPolicy
  seen: TabProps['admin']['seen']
  namespaces: IndexedNamespace[]
  clusters: KubeContext[]
  people: number
  reached: IndexedNamespace[]
  onChange: (rule: Rule) => void
  onDelete: () => void
  onDone: () => void
}) {
  const grant = isGrant(rule)
  const locked = Boolean(rule.locked)
  const groups = policy.groups
  const reachedClusters = new Set(reached.map((ns) => ns.cluster.name)).size

  /** Matchers to add: as typed, or what it starts: a pattern, names, labels. */
  const matchers =
    (field: 'clusters' | 'namespaces') =>
    (typed: string): Suggestion[] => {
      if (!typed) return []
      const onClusters = field === 'clusters'
      const pool = onClusters
        ? clusters.map((c) => ({ name: c.name, labels: { ...c.labels } }))
        : namespaces.map((ns) => ({ name: ns.name, labels: ns.labels }))
      const candidates = new Set<string>()
      if (/[=*!]/.test(typed)) candidates.add(typed)
      else {
        candidates.add(`${typed}*`)
        // A few names, then a few labels, that start with it.
        for (const name of pool
          .map((item) => item.name)
          .filter((n) => n.startsWith(typed))
          .slice(0, 3)) {
          candidates.add(name)
        }
        const labels = pool.flatMap((item) => Object.entries(item.labels))
        for (const [k, v] of labels
          .filter(([k, v]) => k.startsWith(typed) || v.startsWith(typed))
          .slice(0, 3)) {
          candidates.add(`${k}=${v}`)
        }
      }
      return [...candidates]
        .filter((text) => !rule[field].includes(text) && typeof parseMatcher(text) !== 'string')
        .slice(0, 6)
        .map((text) => {
          const count = onClusters
            ? clusters.filter(
                (c) =>
                  whereTest([text], [])({ cluster: { name: c.name, labels: c.labels } }) === true,
              ).length
            : reachedBy({ clusters: [], namespaces: [text] }, namespaces).length
          return {
            value: text,
            text,
            kind: kindOf(text) || 'name',
            mono: true,
            note: count
              ? plural(
                  count,
                  onClusters ? 'cluster' : 'namespace',
                  onClusters ? 'clusters' : 'namespaces',
                )
              : 'none yet',
            warn: !count,
          }
        })
    }
  const matcherProblem = (typed: string) => {
    const parsed = parseMatcher(typed)
    return typeof parsed === 'string' ? parsed : undefined
  }

  return (
    <>
      {locked && (
        <Note tone="locked">
          Set in the Helm chart (
          <span className="font-mono">access.policy.{grant ? 'grants' : 'limits'}</span>
          ), so no change here outlasts the next upgrade: change it there.
        </Note>
      )}
      {!locked && (
        <TextField
          label="Name"
          value={rule.name}
          className="max-w-[420px]"
          onChange={(name) => onChange({ ...rule, name })}
        />
      )}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-4">
        <ChipField
          label={grant ? 'Who' : 'Who it holds back'}
          locked={locked}
          empty={grant ? 'Nobody' : 'Everyone'}
          chips={rule.who.map((id) => ({
            value: id,
            text: groups.find((g) => g.id === id)!.name,
          }))}
          onRemove={(id) => onChange({ ...rule, who: rule.who.filter((x) => x !== id) })}
          onAdd={(id) => onChange({ ...rule, who: [...rule.who, id] })}
          suggest={(typed) =>
            groups
              .filter(
                (g) =>
                  !rule.who.includes(g.id) &&
                  (!typed || g.name.toLowerCase().includes(typed.toLowerCase())),
              )
              .slice(0, 6)
              .map((g) => ({
                value: g.id,
                text: g.name,
                kind: 'group',
                note: plural(membersOf(g, seen).length, 'person', 'people'),
              }))
          }
          placeholder={grant ? 'Add a group' : 'Everyone: or add a group'}
          help={
            grant
              ? 'Groups whose people get this.'
              : 'Leave it empty to hold everyone back, admins included.'
          }
        />
        <ChipField
          label="Clusters"
          locked={locked}
          empty="All clusters"
          chips={rule.clusters.map((text) => ({
            value: text,
            text,
            kind: kindOf(text),
            mono: true,
          }))}
          onRemove={(text) =>
            onChange({ ...rule, clusters: rule.clusters.filter((x) => x !== text) })
          }
          onAdd={(text) => onChange({ ...rule, clusters: [...rule.clusters, text] })}
          suggest={matchers('clusters')}
          error={matcherProblem}
          placeholder="All clusters: add a name or label"
          help="A name, a pattern like prod-*, or a label like env=production."
        />
        <ChipField
          label="Namespaces"
          locked={locked}
          empty="All namespaces"
          chips={rule.namespaces.map((text) => ({
            value: text,
            text,
            kind: kindOf(text),
            mono: true,
          }))}
          onRemove={(text) =>
            onChange({ ...rule, namespaces: rule.namespaces.filter((x) => x !== text) })
          }
          onAdd={(text) => onChange({ ...rule, namespaces: [...rule.namespaces, text] })}
          suggest={matchers('namespaces')}
          error={matcherProblem}
          placeholder="All namespaces: add a name, pattern or label"
          help="Start with ! to leave some out: !kube-*. One that names namespaces leaves clusters’ own things (nodes) alone."
        />
      </div>
      {grant ? (
        <GrantProfile rule={rule} policy={policy} locked={locked} onChange={onChange} />
      ) : (
        <LimitCaps rule={rule} locked={locked} onChange={onChange} />
      )}
      <Reach
        items={[
          {
            value: people,
            label: grant ? 'people get it, as they last signed in' : 'people it holds back',
          },
          { value: reached.length, label: 'namespaces it reaches' },
          { value: reachedClusters, label: reachedClusters === 1 ? 'cluster' : 'clusters' },
        ]}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        {locked ? (
          <span />
        ) : (
          <DeleteButton onClick={onDelete}>{grant ? 'Delete grant' : 'Delete limit'}</DeleteButton>
        )}
        <Button variant="primary" onClick={onDone}>
          Done
        </Button>
      </div>
    </>
  )
}

function GrantProfile({
  rule,
  policy,
  locked,
  onChange,
}: {
  rule: AccessGrant
  policy: AccessPolicy
  locked: boolean
  onChange: (rule: Rule) => void
}) {
  const profile = policy.profiles.find((p) => p.id === rule.profile)!
  const adds = beyondEveryone(policy, profile.values)
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-ink-2">Gives them</span>
      {locked ? (
        <span className="self-start">
          <Pill tone="strong">{profile.name}</Pill>
        </span>
      ) : (
        <span className="self-start">
          <Segmented
            label="Profile"
            value={rule.profile}
            choices={policy.profiles.map((p) => ({ value: p.id, label: p.name }))}
            onChange={(id) => onChange({ ...rule, profile: id })}
          />
        </span>
      )}
      <p className="text-xs text-ink-3">
        {adds.length
          ? `Where it reaches, ${profile.name} adds to what everyone gets: ${adds.join(', ').toLowerCase()}.`
          : `${profile.name} gives nothing more than everyone gets.`}
      </p>
    </div>
  )
}

function LimitCaps({
  rule,
  locked,
  onChange,
}: {
  rule: AccessLimit
  locked: boolean
  onChange: (rule: Rule) => void
}) {
  const set = (key: Capability, level: string) => {
    const caps = { ...rule.caps } as Record<string, string>
    if (level) caps[key] = level
    else delete caps[key]
    onChange({ ...rule, caps })
  }
  return (
    <div className="flex flex-col overflow-hidden rounded-[10px] border border-line">
      <p className="bg-surface-2 px-3.5 py-2.5 text-xs font-medium text-ink-2">
        Where it matches, nobody it names gets more than
      </p>
      {CAPABILITY_KEYS.map((key) => {
        const levels = CAPABILITIES[key] as readonly string[]
        const value = (rule.caps as Record<string, string>)[key] ?? ''
        return (
          <div
            key={key}
            className="flex flex-wrap items-center gap-4 border-t border-line px-3.5 py-2"
          >
            <span className="flex-[1_1_160px] text-[13px] font-medium text-ink-1">
              {CAPABILITY_TEXT[key].label}
            </span>
            {locked ? (
              <span className="text-xs text-ink-2">
                {value ? CAPABILITY_TEXT[key].levels[value] : 'Not limited'}
              </span>
            ) : (
              <Segmented
                label={CAPABILITY_TEXT[key].label}
                value={value}
                choices={[
                  { value: '', label: 'Not limited' },
                  // The most there is limits nothing.
                  ...levels.slice(0, -1).map((level) => ({
                    value: level,
                    label: CAPABILITY_TEXT[key].levels[level]!,
                  })),
                ]}
                onChange={(level) => set(key, level)}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

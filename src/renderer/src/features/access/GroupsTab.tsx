/**
 * Lumovi's groups: who's in each (the identity provider's groups, so people
 * who join or leave there do here, and people by name), and the provider's
 * groups seen as people signed in, to add, and name where they're IDs.
 */
import { Plus, UserRound } from 'lucide-react'
import { useState } from 'react'
import { samePerson, type AccessGroup, type AccessPolicy, type SeenPerson } from '@shared/access'
import { Button } from '@renderer/components/Button'
import { age } from '@renderer/lib/format'
import { cn } from '@renderer/lib/cn'
import type { TabProps } from './AccessPage'
import {
  groupTitle,
  isGuid,
  membersOf,
  newId,
  plural,
  providerGroups,
  sentGroups,
} from './access-model'
import {
  ChipField,
  DeleteButton,
  Expandable,
  LockedBadge,
  Note,
  Pill,
  SectionHead,
  TextField,
  type Suggestion,
} from './parts'

export function GroupsTab({ policy, update, admin }: TabProps) {
  const [open, setOpen] = useState<string | null>(null)
  const { seen, provider } = admin
  const sent = providerGroups(seen)
  const add = () => {
    const id = newId('group')
    update((p) => ({
      ...p,
      groups: [...p.groups, { id, name: 'New group', provider: [], people: [] }],
    }))
    setOpen(id)
  }
  return (
    <div className="flex flex-col gap-4">
      <ProviderNotes admin={admin} policy={policy} sent={sent} />
      <div className="flex flex-wrap items-start gap-5">
        <section
          aria-labelledby="groups-heading"
          className="flex min-w-0 flex-[999_1_560px] flex-col gap-2.5"
        >
          <SectionHead
            id="groups-heading"
            title="Groups"
            count={policy.groups.length}
            action={
              <Button variant="primary" onClick={add}>
                <Plus /> New group
              </Button>
            }
          >
            Who’s in a group: groups from {provider.name} (so people who join or leave there do
            here), and people by name. Grants and limits name these groups, never anyone directly.
          </SectionHead>
          {policy.groups.length === 0 && (
            <div className="rounded-xl border border-dashed border-line-strong px-5 py-8 text-center text-[13px] text-ink-2">
              No groups yet. Make one for each team that should get more than everyone does, or
              less: then give it a profile, in Grants & limits.
            </div>
          )}
          {policy.groups.map((group) => (
            <GroupCard
              key={group.id}
              group={group}
              policy={policy}
              seen={seen}
              sent={sent}
              providerName={provider.name}
              open={open === group.id}
              onToggle={() => setOpen(open === group.id ? null : group.id)}
              onChange={(next) =>
                update((p) => ({
                  ...p,
                  groups: p.groups.map((g) => (g.id === group.id ? next : g)),
                }))
              }
              onDelete={() => {
                update((p) => deleteGroup(p, group.id))
                setOpen(null)
              }}
            />
          ))}
        </section>
        <SeenAtSignIn
          policy={policy}
          update={update}
          seen={seen}
          sent={sent}
          providerName={provider.name}
          onOpen={setOpen}
        />
      </div>
    </div>
  )
}

/**
 * A policy without a group: taken out of the grants that name it, and the limits that hold back
 * only it go too (one naming nobody would hold back everyone).
 */
function deleteGroup(policy: AccessPolicy, id: string): AccessPolicy {
  const without = <T extends { who: string[] }>(rule: T): T => ({
    ...rule,
    who: rule.who.filter((w) => w !== id),
  })
  return {
    ...policy,
    groups: policy.groups.filter((g) => g.id !== id),
    grants: policy.grants.map(without),
    limits: policy.limits.filter((l) => !(l.who.length === 1 && l.who[0] === id)).map(without),
  }
}

/** What isn't as it should be with the groups the provider sends, and how to fix it. */
function ProviderNotes({
  admin,
  policy,
  sent,
}: {
  admin: TabProps['admin']
  policy: AccessPolicy
  sent: ReturnType<typeof providerGroups>
}) {
  // (There's always someone seen: the admin, whose page connected.)
  const { provider } = admin
  const notes = []
  if (sent.length === 0 && provider.mode !== 'token') {
    notes.push(
      <Note
        key="none"
        tone="warn"
        title={`${capitalized(provider.name)} sends no groups as people sign in`}
      >
        So nobody is in a group through {provider.name}: only people named in one are. To use its
        groups,{' '}
        {provider.mode === 'oidc'
          ? `add a groups claim to Lumovi’s app in ${provider.name}: Lumovi reads the ID token’s “${provider.claim}” claim`
          : `have it send them in the ${provider.claim} header`}
        . They’ll show here as people sign in again.
      </Note>,
    )
  }
  const unnamed = sent.filter((g) => isGuid(g.id) && !policy.names[g.id]).length
  if (sent.some((g) => isGuid(g.id))) {
    notes.push(
      <Note key="ids" tone="info" title={`${capitalized(provider.name)} sends groups as IDs`}>
        {unnamed
          ? `Give each the name your team knows it by, once, and it shows everywhere: ${plural(unnamed, 'group still has', 'groups still have')} only an ID.`
          : 'Every group has a name.'}{' '}
        With Microsoft Entra ID, someone in more than 200 groups arrives with none: send the groups
        assigned to Lumovi’s app instead (Token configuration › Groups claim).
      </Note>,
    )
  }
  return notes
}

function GroupCard({
  group,
  policy,
  seen,
  sent,
  providerName,
  open,
  onToggle,
  onChange,
  onDelete,
}: {
  group: AccessGroup
  policy: AccessPolicy
  seen: SeenPerson[]
  sent: ReturnType<typeof providerGroups>
  providerName: string
  open: boolean
  onToggle: () => void
  onChange: (group: AccessGroup) => void
  onDelete: () => void
}) {
  const members = membersOf(group, seen)
  const grants = policy.grants.filter((r) => r.who.includes(group.id))
  const limits = policy.limits.filter((r) => r.who.includes(group.id))
  const profiles = [
    ...new Set(grants.map((r) => policy.profiles.find((p) => p.id === r.profile)!.name)),
  ]
  const parts = [...group.provider.map((id) => groupTitle(policy, id)), ...group.people]
  const line = [group.description, parts.length ? parts.join(', ') : 'No members yet']
    .filter(Boolean)
    .join(' · ')
  return (
    <Expandable
      label={group.name}
      open={open}
      onToggle={onToggle}
      muted={group.locked}
      head={
        <>
          <span
            aria-hidden
            className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-surface-3 font-semibold text-ink-2"
          >
            {(group.name || '?').slice(0, 1).toUpperCase()}
          </span>
          <span className="flex min-w-0 flex-[1_1_240px] flex-col">
            <span className="flex items-center gap-2 font-semibold text-ink-1">
              {group.name || 'Untitled group'}
              {group.locked && <LockedBadge />}
            </span>
            <span className="truncate text-xs text-ink-3">{line}</span>
          </span>
          <span className="flex max-w-[360px] flex-wrap gap-1.5">
            {profiles.map((name) => (
              <Pill key={name}>{name}</Pill>
            ))}
            {limits.length > 0 && <Pill tone="limit">Limited</Pill>}
            {profiles.length === 0 && limits.length === 0 && (
              <Pill tone="empty">In no rule yet</Pill>
            )}
          </span>
          <span
            className={cn(
              'min-w-[92px] text-right text-xs whitespace-nowrap',
              members.length ? 'text-ink-3' : 'text-warn-text',
            )}
          >
            {plural(members.length, 'person', 'people')}
          </span>
        </>
      }
    >
      <GroupEditor
        group={group}
        policy={policy}
        seen={seen}
        sent={sent}
        members={members}
        providerName={providerName}
        rules={grants.length + limits.length}
        onChange={onChange}
        onDelete={onDelete}
        onDone={onToggle}
      />
    </Expandable>
  )
}

function GroupEditor({
  group,
  policy,
  seen,
  sent,
  members,
  providerName,
  rules,
  onChange,
  onDelete,
  onDone,
}: {
  group: AccessGroup
  policy: AccessPolicy
  seen: SeenPerson[]
  sent: ReturnType<typeof providerGroups>
  members: SeenPerson[]
  providerName: string
  rules: number
  onChange: (group: AccessGroup) => void
  onDelete: () => void
  onDone: () => void
}) {
  const locked = Boolean(group.locked)
  const suggest = (typed: string): Suggestion[] => {
    if (!typed) return []
    const q = typed.toLowerCase()
    const out: Suggestion[] = []
    for (const g of sent) {
      if (group.provider.includes(g.id)) continue
      const title = groupTitle(policy, g.id)
      if (!title.toLowerCase().includes(q) && !g.id.toLowerCase().includes(q)) continue
      out.push({
        value: `group:${g.id}`,
        text: title,
        kind: `Group from ${providerName}`,
        note: plural(g.people.length, 'person', 'people'),
        mono: true,
      })
    }
    out.push(
      ...seen
        .filter((person) => !group.people.includes(person.name))
        .filter((person) => person.name.toLowerCase().includes(q))
        .map((person) => ({
          value: `person:${person.name}`,
          text: person.name,
          kind: 'Person',
          note: `signed in ${age(person.seen)} ago`,
        })),
    )
    out.splice(7)
    // Not seen yet, as typed: one of the provider's groups (an email is someone's), or a person.
    if (!out.some((s) => s.text === typed)) {
      if (!typed.includes('@') && !group.provider.includes(typed)) {
        out.push({
          value: `group:${typed}`,
          text: typed,
          kind: `Group from ${providerName}`,
          note: 'not seen yet',
          warn: true,
          mono: true,
        })
      }
      if (!group.people.includes(typed)) {
        out.push({
          value: `person:${typed}`,
          text: typed,
          kind: 'Person',
          note: 'not signed in yet',
          warn: true,
        })
      }
    }
    return out
  }
  const via = (person: SeenPerson) => {
    const id = group.provider.find((g) => person.groups.includes(g))
    return id ? `via ${groupTitle(policy, id)}` : 'named'
  }
  return (
    <>
      {locked && (
        <Note tone="locked">
          Set in the Helm chart (<span className="font-mono">access.policy.groups</span>): change it
          there, so no change here is undone by the next upgrade.
        </Note>
      )}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-4">
        <TextField
          label="Name"
          value={group.name}
          disabled={locked}
          onChange={(name) => onChange({ ...group, name })}
        />
        <TextField
          label="What it’s for"
          value={group.description ?? ''}
          placeholder="Optional"
          disabled={locked}
          onChange={(description) => onChange({ ...group, description })}
        />
      </div>
      <ChipField
        label="Members"
        locked={locked}
        empty="Nobody"
        chips={[
          // What nobody seen matches is marked: a typo, or someone not yet signed in.
          ...group.provider.map((id) => ({
            value: `group:${id}`,
            kind: 'group',
            text: groupTitle(policy, id),
            sub: policy.names[id] ? id : undefined,
            mono: true,
            note: sent.some((g) => g.id === id) ? undefined : 'not seen yet',
          })),
          ...group.people.map((name) => ({
            value: `person:${name}`,
            kind: 'person',
            text: name,
            note: seen.some((p) => samePerson(p.name, name)) ? undefined : 'not seen yet',
          })),
        ]}
        onRemove={(value) => {
          const [kind, id] = split(value)
          onChange(
            kind === 'group'
              ? { ...group, provider: group.provider.filter((x) => x !== id) }
              : { ...group, people: group.people.filter((x) => x !== id) },
          )
        }}
        onAdd={(value) => {
          const [kind, id] = split(value)
          onChange(
            kind === 'group'
              ? { ...group, provider: [...group.provider, id] }
              : { ...group, people: [...group.people, id] },
          )
        }}
        suggest={suggest}
        placeholder={`Add a group from ${providerName}, or a person`}
        help={`A group from ${providerName} keeps it up to date as people join and leave there. Name people for those it doesn’t cover.`}
      />
      <div className="flex flex-col rounded-[10px] border border-line bg-surface-2">
        <p className="px-3.5 py-2.5 text-xs text-ink-2">
          In it now, as they last signed in:{' '}
          <strong className="font-semibold text-ink-1">
            {plural(members.length, 'person', 'people')}
          </strong>
        </p>
        {members.length > 0 && (
          <ul className="grid max-h-60 grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-0.5 overflow-y-auto px-1.5 pb-1.5">
            {members.map((person) => (
              <li
                key={person.name}
                className="flex min-w-0 items-center gap-2 rounded-md bg-surface px-2 py-1.5"
              >
                <span
                  aria-hidden
                  className="grid size-5 shrink-0 place-items-center rounded-full bg-surface-3 text-[10px] font-semibold text-ink-2"
                >
                  {person.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink-1">
                  {person.name}
                </span>
                <span className="text-2xs whitespace-nowrap text-ink-3">{via(person)}</span>
              </li>
            ))}
          </ul>
        )}
        {members.length === 0 && (
          <p className="px-3.5 pb-3 text-xs text-warn-text">
            {group.provider.length
              ? `Nobody yet: nobody has signed in with ${group.provider.map((id) => groupTitle(policy, id)).join(' or ')} in the last 30 days.`
              : 'Nobody yet: add a group or a person.'}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {locked ? (
          <span />
        ) : (
          <DeleteButton onClick={onDelete}>
            {rules
              ? `Delete group (and take it out of ${plural(rules, 'rule', 'rules')})`
              : 'Delete group'}
          </DeleteButton>
        )}
        <Button variant="primary" onClick={onDone}>
          Done
        </Button>
      </div>
    </>
  )
}

/** "Your proxy", at the start of a sentence. */
const capitalized = (text: string) => `${text.slice(0, 1).toUpperCase()}${text.slice(1)}`

const split = (value: string) => {
  const at = value.indexOf(':')
  return [value.slice(0, at), value.slice(at + 1)] as const
}

/** The provider's groups, as they came with people signing in: to add, and to name. */
function SeenAtSignIn({
  policy,
  update,
  seen,
  sent,
  providerName,
  onOpen,
}: {
  policy: AccessPolicy
  update: TabProps['update']
  seen: SeenPerson[]
  sent: ReturnType<typeof providerGroups>
  providerName: string
  onOpen: (id: string) => void
}) {
  const [naming, setNaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const loose = seen.filter((person) => sentGroups(person.groups).length === 0)
  const saveName = (id: string) => {
    const name = draft.trim()
    update((p) => {
      const names = { ...p.names }
      if (name) names[id] = name
      else delete names[id]
      return { ...p, names }
    })
    setNaming(null)
    setDraft('')
  }
  return (
    <aside
      aria-labelledby="seen-heading"
      className="flex min-w-0 flex-[1_1_340px] flex-col gap-2.5 rounded-xl border border-line bg-surface p-4"
    >
      <div>
        <h2 id="seen-heading" className="text-[15px] font-semibold tracking-[-0.01em] text-ink-1">
          Seen at sign-in
        </h2>
        <p className="mt-0.5 text-xs text-ink-3">
          The groups {providerName} sent as people signed in, the last 30 days.
        </p>
      </div>
      {sent.length === 0 && (
        <p className="rounded-[10px] bg-surface-2 p-3.5 text-xs text-ink-2">
          None yet: nobody has signed in with a group. People named in a group are in it all the
          same.
        </p>
      )}
      <ul className="flex flex-col">
        {sent.map((g, i) => {
          const inGroups = policy.groups.filter((x) => x.provider.includes(g.id))
          const named = policy.names[g.id]
          const choices = policy.groups.filter((x) => !x.provider.includes(g.id) && !x.locked)
          return (
            <li
              key={g.id}
              className={cn('flex flex-col gap-1.5 py-2.5', i > 0 && 'border-t border-line')}
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-mono text-xs text-ink-1">{named || g.id}</span>
                  {named && <span className="truncate font-mono text-2xs text-ink-3">{g.id}</span>}
                </span>
                <span className="text-xs whitespace-nowrap text-ink-3">
                  {plural(g.people.length, 'person', 'people')}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {inGroups.length ? (
                  <span className="text-xs text-ink-2">
                    In{' '}
                    <strong className="font-semibold text-ink-1">
                      {inGroups.map((x) => x.name).join(', ')}
                    </strong>
                  </span>
                ) : (
                  <Pill tone="limit">Not in a group: they get what everyone does</Pill>
                )}
                <span className="flex-1" />
                {naming !== g.id && (isGuid(g.id) || named) && (
                  <button
                    type="button"
                    onClick={() => {
                      setNaming(g.id)
                      setDraft(named ?? '')
                    }}
                    className="h-[26px] rounded-md px-2 text-xs text-accent-strong hover:bg-surface-3"
                  >
                    {named ? 'Rename' : 'Name it'}
                  </button>
                )}
                {choices.length > 0 && (
                  <select
                    aria-label={`Add ${named || g.id} to a group`}
                    value=""
                    onChange={(event) => {
                      // (Only a group can be chosen: "Add to…" is what's chosen already.)
                      const id = event.target.value
                      update((p) => ({
                        ...p,
                        groups: p.groups.map((x) =>
                          x.id === id ? { ...x, provider: [...x.provider, g.id] } : x,
                        ),
                      }))
                      onOpen(id)
                    }}
                    className="h-[26px] max-w-40 rounded-md border border-line-strong bg-surface px-1.5 text-xs text-ink-1"
                  >
                    <option value="">Add to…</option>
                    {choices.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              {naming === g.id && (
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    autoFocus
                    aria-label={`A name for ${g.id}`}
                    value={draft}
                    placeholder="What your team calls it"
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') saveName(g.id)
                      else if (event.key === 'Escape') setNaming(null)
                    }}
                    className="h-[30px] min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-2 text-[13px] outline-none focus:border-accent focus:ring-3 focus:ring-accent-soft"
                  />
                  <Button
                    variant="primary"
                    className="h-[30px] text-xs"
                    onClick={() => saveName(g.id)}
                  >
                    Save
                  </Button>
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {loose.length > 0 && (
        <p className="flex items-start gap-2 rounded-[10px] bg-surface-2 px-3 py-2.5 text-xs text-ink-2">
          <UserRound className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            {plural(loose.length, 'person', 'people')} signed in without any groups, like{' '}
            {loose
              .slice(0, 3)
              .map((p) => p.name)
              .join(', ')}
            : they get what everyone does, unless a group names them.
          </span>
        </p>
      )}
    </aside>
  )
}

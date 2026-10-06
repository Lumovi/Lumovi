/**
 * Profiles: what someone may do, as a set. Everyone signed in gets the
 * first; grants give groups the others where they say. Side by side, so
 * what each adds is plain, and what shows Secret values or runs code on
 * nodes stands out.
 */
import { Lock, Plus, Trash2 } from 'lucide-react'
import {
  CAPABILITIES,
  CAPABILITY_KEYS,
  CAPABILITY_TEXT,
  rankOf,
  SCOPES,
  type AccessPolicy,
  type Capability,
  type Levels,
} from '@shared/access'
import { Button, IconButton } from '@renderer/components/Button'
import { Tooltip } from '@renderer/components/Tooltip'
import { cn } from '@renderer/lib/cn'
import type { TabProps } from './AccessPage'
import { isSensitive, newId, plural } from './access-model'
import { SectionHead } from './parts'

/** A column: what everyone gets, or a profile. */
interface Column {
  id: string
  name: string
  values: Levels
  locked: boolean
  everyone: boolean
  who: string
}

export function ProfilesTab({ policy, update }: TabProps) {
  const columns: Column[] = [
    {
      id: 'everyone',
      name: 'Everyone',
      values: policy.everyone,
      locked: Boolean(policy.everyoneLocked),
      everyone: true,
      who: 'Everyone signed in',
    },
    ...policy.profiles.map((p) => {
      const grants = policy.grants.filter((g) => g.profile === p.id)
      const groups = new Set(grants.flatMap((g) => g.who))
      return {
        id: p.id,
        name: p.name,
        values: p.values,
        locked: Boolean(p.locked),
        everyone: false,
        who: grants.length
          ? `${plural(groups.size, 'group', 'groups')}, in ${plural(grants.length, 'grant', 'grants')}`
          : 'In no grant yet',
      }
    }),
  ]
  const set = (column: Column, key: Capability, level: string) =>
    update((p) =>
      column.everyone
        ? { ...p, everyone: { ...p.everyone, [key]: level } }
        : {
            ...p,
            profiles: p.profiles.map((x) =>
              x.id === column.id ? { ...x, values: { ...x.values, [key]: level } } : x,
            ),
          },
    )
  const add = () =>
    update((p) => ({
      ...p,
      profiles: [
        ...p.profiles,
        {
          id: newId('profile'),
          name: 'New profile',
          values: { ...p.everyone },
        },
      ],
    }))
  return (
    <section aria-labelledby="profiles-heading" className="flex flex-col gap-3">
      <SectionHead
        id="profiles-heading"
        title="Profiles"
        count={columns.length}
        action={
          <Button variant="primary" onClick={add}>
            <Plus /> New profile
          </Button>
        }
      >
        What someone may do, as a set. Everyone signed in gets the first; grants give groups more
        where they say. Someone in several gets the most any of them gives, and limits cap it.
      </SectionHead>
      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full min-w-[960px] border-collapse">
          <thead>
            <tr>
              <th
                scope="col"
                className="w-[220px] border-b border-line px-4 py-3.5 text-left align-bottom text-xs font-medium text-ink-3"
              >
                Each may
              </th>
              {columns.map((column) => (
                <th
                  key={column.id}
                  scope="col"
                  className={cn(
                    'border-b border-line px-3 py-3.5 text-left align-bottom',
                    column.everyone && 'bg-surface-2',
                  )}
                >
                  <ColumnHead column={column} policy={policy} update={update} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CAPABILITY_KEYS.map((key) => (
              <tr key={key}>
                <th
                  scope="row"
                  className="border-t border-line/70 px-4 py-2.5 text-left align-middle font-normal"
                >
                  <div className="text-[13px] font-medium text-ink-1">
                    {CAPABILITY_TEXT[key].label}
                  </div>
                  <div className="text-xs text-ink-3">
                    {CAPABILITY_TEXT[key].hint}
                    {SCOPES[key] === 'cluster'
                      ? ' · a cluster’s'
                      : SCOPES[key] === 'anywhere'
                        ? ' · anywhere'
                        : ''}
                  </div>
                </th>
                {columns.map((column) => (
                  <Cell
                    key={column.id}
                    capability={key}
                    column={column}
                    base={policy.everyone[key]}
                    onChange={(level) => set(column, key, level)}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap gap-4 text-xs text-ink-2">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-[3px] border border-warn/40 bg-warn/10" />
          Shows Secret values, runs code on nodes, installs charts, lets assistants change things
          unasked, or reads everyone’s events
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Lock aria-hidden className="size-3 text-ink-3" />
          Set in the Helm chart: changed there, not here
        </span>
      </div>
    </section>
  )
}

/** A profile's name (changed in place), who it's given to, and deleting it. */
function ColumnHead({
  column,
  policy,
  update,
}: {
  column: Column
  policy: AccessPolicy
  update: TabProps['update']
}) {
  const used = policy.grants.filter((g) => g.profile === column.id).length
  const editable = !column.everyone && !column.locked
  return (
    <div className="flex min-w-[150px] flex-col gap-0.5">
      <span className="flex items-center gap-1.5">
        {editable ? (
          <input
            aria-label={`Name of the profile ${column.name}`}
            value={column.name}
            onChange={(event) =>
              update((p) => ({
                ...p,
                profiles: p.profiles.map((x) =>
                  x.id === column.id ? { ...x, name: event.target.value } : x,
                ),
              }))
            }
            className="-mx-1 h-6 min-w-0 flex-1 rounded px-1 text-[13px] font-semibold text-ink-1 outline-none hover:bg-surface-3 focus:bg-surface focus:ring-2 focus:ring-accent-soft"
          />
        ) : (
          <span className="text-[13px] font-semibold text-ink-1">{column.name}</span>
        )}
        {column.locked && (
          <Lock role="img" aria-label="Set in the Helm chart" className="size-3 text-ink-3" />
        )}
        {editable &&
          (used ? (
            <Tooltip
              content={`Given in ${plural(used, 'grant', 'grants')}: give them another first`}
            >
              <span tabIndex={0} className="inline-flex">
                <button
                  type="button"
                  disabled
                  aria-label={`Delete ${column.name}`}
                  className="inline-flex size-6 items-center justify-center rounded-lg text-ink-3 opacity-50"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </span>
            </Tooltip>
          ) : (
            <IconButton
              label={`Delete ${column.name}`}
              className="size-6"
              onClick={() =>
                update((p) => ({ ...p, profiles: p.profiles.filter((x) => x.id !== column.id) }))
              }
            >
              <Trash2 className="!size-3.5" />
            </IconButton>
          ))}
      </span>
      <span className="text-2xs font-normal text-ink-3">{column.who}</span>
    </div>
  )
}

function Cell({
  capability,
  column,
  base,
  onChange,
}: {
  capability: Capability
  column: Column
  /** What everyone gets: a profile's level beyond it is what the profile adds. */
  base: string
  onChange: (level: string) => void
}) {
  const level = column.values[capability] as string
  const sensitive = isSensitive(capability, level)
  const more =
    !column.everyone && rankOf(capability, level as never) > rankOf(capability, base as never)
  const label = `${CAPABILITY_TEXT[capability].label} for ${column.name}`
  return (
    <td
      className={cn(
        'border-t border-line/70 px-3 py-2 align-middle',
        sensitive ? 'bg-warn/10' : column.everyone && 'bg-surface-2',
      )}
    >
      <select
        aria-label={label}
        value={level}
        disabled={column.locked}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          'h-[30px] max-w-full rounded-lg border bg-surface px-2 text-xs disabled:opacity-80',
          sensitive ? 'border-warn/40' : 'border-line-strong hover:border-ink-3',
          more || column.everyone ? 'font-semibold text-ink-1' : 'text-ink-3',
        )}
      >
        {(CAPABILITIES[capability] as readonly string[]).map((value) => (
          <option key={value} value={value}>
            {CAPABILITY_TEXT[capability].levels[value]}
          </option>
        ))}
      </select>
    </td>
  )
}

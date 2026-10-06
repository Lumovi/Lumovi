/**
 * What narrows the audit log: words, how far back, and menus of the kinds
 * of events, outcomes, people, clusters and how they were done; each shown
 * as a chip once it's chosen, to take it off again.
 */
import { Check, ChevronDown, X } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import type { ReactNode } from 'react'
import { apiKindOf } from '@shared/resources'
import { SearchInput } from '@renderer/components/SearchInput'
import { cn } from '@renderer/lib/cn'
import { menuContent, menuItem } from '../shell/menu-styles'
import {
  CATEGORY_LABELS,
  narrowing,
  OUTCOME_STYLES,
  RANGES,
  VIA_LABELS,
  type AuditFilters,
  type Range,
} from './audit-model'

interface Option {
  value: string
  label: string
}

const trigger =
  'inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-ink-1 no-drag hover:bg-surface-3 data-[state=open]:bg-surface-3'

/** A menu of some of a few: what it's called, and how many are chosen. */
function FilterMenu({
  label,
  options,
  chosen,
  onChange,
  empty,
}: {
  label: string
  options: Option[]
  chosen: string[]
  onChange: (chosen: string[]) => void
  /** Said when there's nothing to choose from yet. */
  empty?: string
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className={trigger}>
        {label}
        {chosen.length > 0 && (
          <span className="rounded-full bg-ink-1 px-1.5 text-2xs font-semibold text-surface tabular-nums">
            {chosen.length}
          </span>
        )}
        <ChevronDown className="size-3.5 text-ink-3" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          className={cn(menuContent, 'max-h-[60vh] overflow-y-auto')}
        >
          {options.length === 0 && <p className="px-2 py-1.5 text-xs text-ink-3">{empty}</p>}
          {options.map((option) => (
            <DropdownMenu.CheckboxItem
              key={option.value}
              checked={chosen.includes(option.value)}
              // Several at a time: the menu stays open.
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) =>
                onChange(
                  checked
                    ? [...chosen, option.value]
                    : chosen.filter((value) => value !== option.value),
                )
              }
              className={menuItem}
            >
              <span className="grid size-4 place-items-center">
                <DropdownMenu.ItemIndicator>
                  <Check className="size-4 text-accent" />
                </DropdownMenu.ItemIndicator>
              </span>
              <span className="flex-1 truncate">{option.label}</span>
            </DropdownMenu.CheckboxItem>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

function RangeMenu({ range, onChange }: { range: Range; onChange: (range: Range) => void }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className={trigger} aria-label="How far back">
        {RANGES.find((r) => r.value === range)!.label}
        <ChevronDown className="size-3.5 text-ink-3" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={6} className={menuContent}>
          <DropdownMenu.RadioGroup value={range} onValueChange={(v) => onChange(v as Range)}>
            {RANGES.map((r) => (
              <DropdownMenu.RadioItem key={r.value} value={r.value} className={menuItem}>
                <span className="grid size-4 place-items-center">
                  <DropdownMenu.ItemIndicator>
                    <Check className="size-4 text-accent" />
                  </DropdownMenu.ItemIndicator>
                </span>
                {r.label}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

export function Toolbar({
  filters,
  onChange,
  people,
  clusters,
  everyone,
  onArrowDown,
}: {
  filters: AuditFilters
  onChange: (filters: AuditFilters) => void
  /** Who there is to choose from (an auditor's): those seen so far. */
  people: string[]
  clusters: string[]
  everyone: boolean
  onArrowDown: () => void
}) {
  const set = (patch: Partial<AuditFilters>) => onChange({ ...filters, ...patch })
  const options = (values: string[]) => values.map((value) => ({ value, label: value }))
  return (
    <div className="flex flex-col gap-2">
      <div role="toolbar" aria-label="Filters" className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={filters.text}
          onChange={(text) => set({ text })}
          onArrowDown={onArrowDown}
          placeholder="Search what was done, by whom, where…"
          className="w-full max-w-[360px] min-w-[220px] flex-1"
        />
        <RangeMenu range={filters.range} onChange={(range) => set({ range })} />
        <FilterMenu
          label="Kind"
          options={Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ value, label }))}
          chosen={filters.categories}
          onChange={(categories) => set({ categories: categories as AuditFilters['categories'] })}
        />
        <FilterMenu
          label="Outcome"
          options={Object.entries(OUTCOME_STYLES).map(([value, { label }]) => ({ value, label }))}
          chosen={filters.outcomes}
          onChange={(outcomes) => set({ outcomes: outcomes as AuditFilters['outcomes'] })}
        />
        {everyone && (
          <FilterMenu
            label="Who"
            options={options(people)}
            chosen={filters.users}
            onChange={(users) => set({ users })}
            empty="Nobody yet."
          />
        )}
        <FilterMenu
          label="Through"
          options={Object.entries(VIA_LABELS).map(([value, label]) => ({ value, label }))}
          chosen={filters.via}
          onChange={(via) => set({ via: via as AuditFilters['via'] })}
        />
        <FilterMenu
          label="Cluster"
          options={options(clusters)}
          chosen={filters.clusters}
          onChange={(chosen) => set({ clusters: chosen })}
          empty="None yet."
        />
      </div>
      {narrowing(filters) > 0 && (
        <div aria-label="Chosen filters" className="flex flex-wrap items-center gap-1.5">
          {filters.target && (
            <Chip onRemove={() => set({ target: undefined })} label="Object">
              {apiKindOf(filters.target.kind)} {filters.target.name}
              {filters.target.namespace && ` in ${filters.target.namespace}`}
            </Chip>
          )}
          {filters.categories.map((value) => (
            <Chip
              key={value}
              label="Kind"
              onRemove={() => set({ categories: filters.categories.filter((v) => v !== value) })}
            >
              {CATEGORY_LABELS[value]}
            </Chip>
          ))}
          {filters.outcomes.map((value) => (
            <Chip
              key={value}
              label="Outcome"
              onRemove={() => set({ outcomes: filters.outcomes.filter((v) => v !== value) })}
            >
              {OUTCOME_STYLES[value].label}
            </Chip>
          ))}
          {filters.users.map((value) => (
            <Chip
              key={value}
              label="Who"
              onRemove={() => set({ users: filters.users.filter((v) => v !== value) })}
            >
              {value}
            </Chip>
          ))}
          {filters.via.map((value) => (
            <Chip
              key={value}
              label="Through"
              onRemove={() => set({ via: filters.via.filter((v) => v !== value) })}
            >
              {VIA_LABELS[value]}
            </Chip>
          ))}
          {filters.clusters.map((value) => (
            <Chip
              key={value}
              label="Cluster"
              onRemove={() => set({ clusters: filters.clusters.filter((v) => v !== value) })}
            >
              {value}
            </Chip>
          ))}
          <button
            type="button"
            onClick={() =>
              set({
                categories: [],
                outcomes: [],
                users: [],
                clusters: [],
                via: [],
                target: undefined,
              })
            }
            className="rounded-md px-1.5 py-0.5 text-xs text-ink-3 hover:bg-surface-3 hover:text-ink-1"
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  )
}

function Chip({
  label,
  onRemove,
  children,
}: {
  label: string
  onRemove: () => void
  children: ReactNode
}) {
  return (
    <span className="inline-flex h-6 items-center gap-1 rounded-md border border-line bg-surface pr-0.5 pl-2 text-xs text-ink-1">
      <span className="text-ink-3">{label}:</span>
      <span className="max-w-[260px] truncate">{children}</span>
      <button
        type="button"
        aria-label={`Remove ${label.toLowerCase()} filter`}
        onClick={onRemove}
        className="grid size-5 place-items-center rounded text-ink-3 hover:bg-surface-3 hover:text-ink-1"
      >
        <X className="size-3" />
      </button>
    </span>
  )
}

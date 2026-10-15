/**
 * A table's bar (`@shared/kit/table`'s `filters` and `search`), Lumovi's own: a field that keeps
 * the rows whose name has what's typed; each filter a menu of the values the rows have, with how
 * many have each, the ones a plugin put under More filters in a menu of their own; what's set as
 * chips, each taken off by its ×, and Clear filters for all. On a phone, the field, and Filters,
 * which opens them as a sheet. Nothing of it is told to the plugin.
 */
import { Check, ChevronDown, SlidersHorizontal, X } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { createContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { spelled } from '@shared/kit/characters'
import type { PageDestination } from '@shared/kit/declare'
import type { Health } from '@shared/health'
import { SearchInput } from '@renderer/components/SearchInput'
import { Sheet } from '@renderer/components/Sheet'
import { cn } from '@renderer/lib/cn'
import { HEALTH_NAMES } from '@renderer/lib/health'
import type { Chosen, FilterMenu } from '@renderer/lib/table-filters'
import { TheirText } from '@renderer/plugins/TheirText'
import { HealthChips } from '../features/resources/ListToolbar'
import { listBar, listChip, listChipCount, listCount } from '../features/resources/list-look'
import { menuContent, menuItem } from '../features/shell/menu-styles'

/**
 * What a page's tables start with, where a link of its plugin's opened it so (a
 * `PageDestination`'s filters and search, as the door made them): each table takes the filters
 * it has, and nothing else.
 */
export const StartFilters = createContext<Pick<PageDestination, 'filters' | 'search'> | undefined>(
  undefined,
)

const trigger =
  'inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-ink-1 no-drag hover:bg-surface-3 data-[state=open]:bg-surface-3'

/** A value as a menu draws it: a level in Lumovi's words, else the plugin's, in pieces. */
function Value({ menu, value }: { menu: FilterMenu; value: string }) {
  return menu.filter.level ? (
    <>{HEALTH_NAMES[value as Health] ?? value}</>
  ) : (
    <TheirText text={{ their: value }} inline />
  )
}

/** A value as a screen reader says it. */
const spoken = (menu: FilterMenu, value: string) =>
  menu.filter.level ? (HEALTH_NAMES[value as Health] ?? value) : spelled(value)

export function FilterBar({
  title,
  menus,
  chosen,
  onChosen,
  searchable,
  search,
  onSearch,
  phone,
  list,
}: {
  /** What the table is of, as a screen reader says it: the field's name. */
  title: string
  menus: readonly FilterMenu[]
  chosen: Chosen
  onChosen: (chosen: Chosen) => void
  searchable: boolean
  search: string
  onSearch: (search: string) => void
  phone: boolean
  /**
   * Its table is its page's list: the bar is Lumovi's lists' own, how many there are first, its
   * filters as chips, and the field that filters them at its end.
   */
  list?: {
    count: string
    noun: string
    /** Its status's levels, as chips: how many rows are at each, and the ones pressed. */
    levels: { counts: Map<Health, number>; active: Health[]; onToggle: (level: Health) => void }
  }
}) {
  const [sheet, setSheet] = useState(false)
  const set = (key: string, values: ReadonlySet<string>) => {
    const next = new Map(chosen)
    if (values.size) next.set(key, values)
    else next.delete(key)
    onChosen(next)
  }
  const toggle = (key: string, value: string, on: boolean) => {
    const values = new Set(chosen.get(key))
    if (on) values.add(value)
    else values.delete(value)
    set(key, values)
  }
  const setCount = [...chosen.values()].reduce((sum, values) => sum + values.size, 0)
  const shown = menus.filter((menu) => !menu.filter.more)
  const more = menus.filter((menu) => menu.filter.more)
  const field = searchable && (
    <SearchInput
      value={search}
      onChange={onSearch}
      onArrowDown={() => undefined}
      placeholder="Search"
      name={`Search ${title}`}
      hint={false}
      hotkey={false}
      className={phone ? 'min-w-0 flex-1' : 'w-56'}
    />
  )
  const chips = setCount > 0 && (
    <div className="flex flex-wrap items-center gap-1.5">
      {menus.flatMap((menu) =>
        [...(chosen.get(menu.filter.key.their) ?? [])].map((value) => (
          <button
            key={`${menu.filter.key.their}\n${value}`}
            type="button"
            aria-label={`Take off ${spelled(menu.filter.name.their)}: ${spoken(menu, value)}`}
            onClick={() => toggle(menu.filter.key.their, value, false)}
            className="inline-flex h-7 max-w-full items-center gap-1 rounded-full border border-line bg-surface-3/60 pr-1.5 pl-2.5 text-xs text-ink-1 hover:bg-surface-3 phone:h-11"
          >
            <span className="truncate">
              <span className="text-ink-3">
                <TheirText text={menu.filter.name} inline />:{' '}
              </span>
              <Value menu={menu} value={value} />
            </span>
            <X className="size-3.5 shrink-0 text-ink-3" aria-hidden />
          </button>
        )),
      )}
      <button
        type="button"
        onClick={() => onChosen(new Map())}
        className="h-7 px-1.5 text-xs text-ink-2 underline-offset-2 hover:underline phone:h-11"
      >
        Clear filters
      </button>
    </div>
  )
  if (phone) {
    return (
      <div className="flex flex-col gap-2 pb-2.5">
        <div className="flex items-center gap-2">
          {field}
          {menus.length > 0 && (
            <button
              type="button"
              onClick={() => setSheet(true)}
              className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[13px] text-ink-1"
            >
              <SlidersHorizontal className="size-4 text-ink-2" aria-hidden />
              Filters
              {setCount > 0 && <Counted count={setCount} />}
            </button>
          )}
        </div>
        {chips}
        {sheet && (
          <Sheet title="Filters" onClose={() => setSheet(false)}>
            <div className="overflow-y-auto px-4 pb-4">
              {menus.map((menu) => (
                <section key={menu.filter.key.their} aria-label={spelled(menu.filter.name.their)}>
                  <h3 className="pt-3 pb-1 text-xs font-medium text-ink-3">
                    <TheirText text={menu.filter.name} inline />
                  </h3>
                  {menu.values.map(({ value, count }) => {
                    const on = chosen.get(menu.filter.key.their)?.has(value) === true
                    return (
                      <button
                        key={value}
                        type="button"
                        role="checkbox"
                        aria-checked={on}
                        onClick={() => toggle(menu.filter.key.their, value, !on)}
                        className="flex h-11 w-full items-center gap-2.5 text-left text-[13px] text-ink-1"
                      >
                        <span className="grid size-4 place-items-center">
                          {on && <Check className="size-4 text-accent" aria-hidden />}
                        </span>
                        <span className="min-w-0 flex-1 truncate">
                          <Value menu={menu} value={value} />
                        </span>
                        <span className="text-xs text-ink-3 tabular-nums">{count}</span>
                      </button>
                    )
                  })}
                </section>
              ))}
            </div>
          </Sheet>
        )}
      </div>
    )
  }
  if (list) {
    return (
      <ListFilters
        count={list.count}
        filters={
          <>
            {list.levels.counts.size > 0 && (
              <HealthChips
                counts={list.levels.counts}
                active={list.levels.active}
                onToggle={list.levels.onToggle}
                name={(level) => HEALTH_NAMES[level]}
              />
            )}
            {/* (The plugin's own filters, all in one menu, as a list's further filters are.) */}
            {menus.length > 0 && (
              <Menu
                menus={menus}
                chosen={chosen}
                onToggle={toggle}
                label="More filters"
                called="More filters"
                chip
              />
            )}
          </>
        }
        field={
          searchable &&
          ((narrow: boolean) => (
            <SearchInput
              value={search}
              onChange={onSearch}
              onArrowDown={() => undefined}
              placeholder={narrow ? 'Filter' : `Filter ${list.noun}`}
              name={`Filter ${list.noun}`}
              hint={!narrow}
              className="min-w-32 shrink basis-60"
            />
          ))
        }
        set={chips}
      />
    )
  }
  return (
    <div className="flex flex-col gap-2 px-4 pb-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {field}
        {shown.map((menu) => (
          <Menu
            key={menu.filter.key.their}
            menus={[menu]}
            chosen={chosen}
            onToggle={toggle}
            label={<TheirText text={menu.filter.name} inline />}
            called={spelled(menu.filter.name.their)}
          />
        ))}
        {more.length > 0 && (
          <Menu
            menus={more}
            chosen={chosen}
            onToggle={toggle}
            label="More filters"
            called="More filters"
          />
        )}
      </div>
      {chips}
    </div>
  )
}

/** The least the field that filters a list takes (its `min-w-32`), and the room between parts. */
const FIELD_LEAST = 128
const GAP = 8
/** A bar narrower than this has its field say "Filter" alone, without its key, as `ListBar`'s. */
const NARROW = 480

/**
 * A list's bar, as Lumovi's lists' own (`ListBar`): how many, its chips and the field at its end,
 * on one row while it holds the chips whole beside the field at its least; where it doesn't (a
 * page beside a row's panel), the chips take a row of their own under it, and wrap there. Then
 * what's set, as chips.
 *
 * (That is measured: wrapping alone would send the field under the chips, or the chips out of
 * their room and under the field.)
 */
function ListFilters({
  count,
  filters,
  field,
  set,
}: {
  count: string
  filters: ReactNode
  /** The field, drawn as the bar's width has it: `narrow` under `NARROW`. None where there's none. */
  field: false | ((narrow: boolean) => ReactNode)
  set: ReactNode
}) {
  const bar = useRef<HTMLDivElement>(null)
  const counted = useRef<HTMLSpanElement>(null)
  const chipRow = useRef<HTMLSpanElement>(null)
  const [width, setWidth] = useState(Infinity)
  const [stacked, setStacked] = useState(false)
  useLayoutEffect(() => {
    const measure = () => {
      const style = getComputedStyle(bar.current!)
      setWidth(
        bar.current!.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(bar.current!)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    const each = [...(chipRow.current?.children ?? [])].map(
      (chip) => (chip as HTMLElement).offsetWidth,
    )
    const parts = [
      counted.current!.offsetWidth + 4,
      ...(each.length > 0 ? [each.reduce((sum, w) => sum + w, 0) + GAP * (each.length - 1)] : []),
      ...(field ? [FIELD_LEAST] : []),
    ]
    setStacked(parts.reduce((sum, w) => sum + w, 0) + GAP * (parts.length - 1) > width)
  }, [width, count, filters, field])
  // (On the second row its chips are that row's own, wrapping.)
  const chips = (
    <span
      ref={chipRow}
      className={cn('flex items-center gap-2', stacked ? 'contents' : 'shrink-0')}
    >
      {filters}
    </span>
  )
  return (
    <div ref={bar} role="group" aria-label="Filters" className={listBar}>
      <div className="flex items-center gap-2">
        <span ref={counted} className={listCount}>
          {count}
        </span>
        {!stacked && chips}
        <div className="flex-1" />
        {field && field(width < NARROW)}
      </div>
      {stacked && <div className="flex flex-wrap items-center gap-2">{chips}</div>}
      {set}
    </div>
  )
}

/** How many are set, in a small filled count. */
function Counted({ count }: { count: number }) {
  return (
    <span className="rounded-full bg-ink-1 px-1.5 text-2xs font-semibold text-surface tabular-nums">
      {count}
    </span>
  )
}

/**
 * A menu of one filter's values (or More filters', each under its name), each with how many rows
 * have it; several at a time, so it stays open. Its button says how many are set.
 */
function Menu({
  menus,
  chosen,
  onToggle,
  label,
  called,
  chip = false,
}: {
  menus: readonly FilterMenu[]
  chosen: Chosen
  onToggle: (key: string, value: string, on: boolean) => void
  label: ReactNode
  called: string
  /** Drawn as a list's chip: filled while any of its values is set, with how many. */
  chip?: boolean
}) {
  const count = menus.reduce((sum, menu) => sum + (chosen.get(menu.filter.key.their)?.size ?? 0), 0)
  return (
    <DropdownMenu.Root>
      {chip ? (
        <DropdownMenu.Trigger className={listChip(count > 0)} aria-label={called}>
          <span className="max-w-40 truncate">{label}</span>
          {count > 0 && <span className={listChipCount}>{count}</span>}
          <ChevronDown className="size-3.5 opacity-60" aria-hidden />
        </DropdownMenu.Trigger>
      ) : (
        <DropdownMenu.Trigger className={trigger} aria-label={called}>
          <span className="max-w-40 truncate">{label}</span>
          {count > 0 && <Counted count={count} />}
          <ChevronDown className="size-3.5 text-ink-3" aria-hidden />
        </DropdownMenu.Trigger>
      )}
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          className={cn(menuContent, 'max-h-[60vh] max-w-80 overflow-y-auto')}
        >
          {menus.map((menu) => (
            <DropdownMenu.Group key={menu.filter.key.their}>
              {menus.length > 1 && (
                <DropdownMenu.Label className="px-2 pt-2 pb-1 text-xs font-medium text-ink-3">
                  <TheirText text={menu.filter.name} inline />
                </DropdownMenu.Label>
              )}
              {menu.values.length === 0 && (
                <p className="px-2 py-1.5 text-xs text-ink-3">None of the rows has one.</p>
              )}
              {menu.values.map(({ value, count: has }) => (
                <DropdownMenu.CheckboxItem
                  key={value}
                  checked={chosen.get(menu.filter.key.their)?.has(value) === true}
                  // Several at a time: the menu stays open.
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={(on) => onToggle(menu.filter.key.their, value, on === true)}
                  className={menuItem}
                >
                  <span className="grid size-4 place-items-center">
                    <DropdownMenu.ItemIndicator>
                      <Check className="size-4 text-accent" />
                    </DropdownMenu.ItemIndicator>
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    <Value menu={menu} value={value} />
                  </span>
                  <span className="text-xs text-ink-3 tabular-nums">{has}</span>
                </DropdownMenu.CheckboxItem>
              ))}
            </DropdownMenu.Group>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

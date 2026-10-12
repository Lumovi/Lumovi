import { Command } from 'cmdk'
import { Check, ChevronDown, Globe2, LayoutGrid, Plus, X } from 'lucide-react'
import { useId, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { Picker } from '@renderer/components/Picker'
import { MiddleTruncate } from '@renderer/components/MiddleTruncate'
import { Kbd, MOD_KEY } from '@renderer/components/Kbd'
import { barButton } from '@renderer/components/Sheet'
import { Tooltip } from '@renderer/components/Tooltip'
import { useList } from '@renderer/hooks/queries'
import { cn } from '@renderer/lib/cn'
import { useLayout } from '@renderer/lib/layout'
import { matchWords } from '@renderer/lib/match'
import { byName, isNamespaceName, MOST_NAMESPACES } from '@renderer/lib/namespaces'
import { useCluster } from '@renderer/state/cluster'
import { menuItem } from './menu-styles'

const trigger =
  'flex h-8 max-w-56 items-center gap-2 rounded-lg px-2.5 text-[13px] text-ink-2 transition-colors no-drag touch:h-11'

/**
 * A chip of the context row, under a narrow page's top bar: 32 px high, in a row whose 44 px
 * are what a finger gets (the chip's own before reaches them).
 */
export const contextChip =
  'finger flex h-8 min-w-0 items-center gap-2 rounded-lg border border-line bg-surface-2 px-2.5 text-[13px] font-medium text-ink-1'

/** How many lines the button's tooltip has at most: the picked, one a line, then "and N more". */
const TOOLTIP_LINES = 10

/** The value of the row that uses a typed name: never a namespace's, which has no space. */
const usingTyped = (name: string) => `use ${name}`

/**
 * The room the button has for its words: its 224 px, less its padding (20), its two icons (28)
 * and the gaps beside them (16).
 */
const ROOM = 224 - 20 - 28 - 16

let measuring: CanvasRenderingContext2D | null | undefined
/** How wide `text` is in the button's words (13 px, medium). */
function widthOf(text: string): number {
  measuring ??= document.createElement('canvas').getContext('2d')
  if (!measuring) return Infinity
  measuring.font = `500 13px ${getComputedStyle(document.body).fontFamily}`
  return measuring.measureText(text).width
}

/**
 * What the button says: all namespaces, one's name, two's names where both fit whole in it (a
 * name is never cut inside a list of names), or how many.
 */
function labelOf(picked: readonly string[]): string {
  const names = byName(picked)
  if (names.length === 0) return 'All namespaces'
  if (names.length === 1) return names[0]!
  const two = names.join(', ')
  return names.length === 2 && widthOf(two) <= ROOM ? two : `${names.length} namespaces`
}

export function NamespacePicker({
  clusterScoped,
  chip = false,
}: {
  clusterScoped: boolean
  /** In the context row, as a chip. */
  chip?: boolean
}) {
  const { namespaces: chosen, setNamespaces, linkNamed } = useCluster()
  const picked = chosen ?? []
  const phone = useLayout() === 'phone'
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [highlighted, setHighlighted] = useState('')
  const id = useId()
  // The picked as the menu opened, which come first: nothing moves while it's open.
  const [first, setFirst] = useState<string[]>([])
  // A link that named more than can be picked says so once, the first time the menu opens.
  const [linkSaid, setLinkSaid] = useState(false)
  const text = labelOf(picked)
  const listed = useList('Namespace', { namespace: null })
  const names = listed.data?.map((ns) => ns.metadata.name) ?? []
  const terminating = new Set(
    listed.data?.filter((ns) => ns.status?.phase === 'Terminating').map((ns) => ns.metadata.name),
  )
  // Only a name a namespace could have is offered, remembered or asked for: "shop,data" or "Bad
  // Name" isn't one, and is said so.
  const typed = isNamespaceName(search.trim()) ? search.trim() : ''
  const notAName = search.trim() && !typed ? search.trim() : undefined
  const full = picked.length >= MOST_NAMESPACES

  const opened = (now: boolean) => {
    if (now) setFirst(byName(picked))
    else {
      setSearch('')
      if (linkNamed) setLinkSaid(true)
    }
    setOpen(now)
  }
  /** Only this one (or all of them), and the menu closes: what Enter and the name do. */
  const only = (name: string | null) => {
    setNamespaces(name === null ? null : [name])
    opened(false)
  }
  /** Adds it, or takes it away; the menu stays open, and the page follows at once. */
  const toggle = (name: string) => {
    if (picked.includes(name)) setNamespaces(picked.filter((each) => each !== name))
    else if (!full) setNamespaces([...picked, name])
  }

  if (clusterScoped) {
    return (
      <Tooltip content="These resources don’t belong to a namespace">
        <span
          aria-label="Namespace"
          className={
            chip
              ? 'flex h-8 min-w-0 items-center gap-2 px-1 text-[13px] text-ink-3'
              : `${trigger} cursor-default text-ink-3`
          }
        >
          <Globe2 className="size-3.5 shrink-0" />
          Cluster-wide
        </span>
      </Tooltip>
    )
  }

  // ⌘Enter (Ctrl+Enter off a Mac) adds or takes away the row under the keyboard; Enter, cmdk's
  // own, picks only it.
  const keys = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || !(MOD_KEY === '⌘' ? event.metaKey : event.ctrlKey)) return
    event.preventDefault()
    if (typed && highlighted === usingTyped(typed)) {
      if (!picked.includes(typed) && !full) toggle(typed)
      setSearch('')
    } else if (highlighted && highlighted !== 'All namespaces') {
      toggle(highlighted)
    }
  }

  // The picked as it opened; then any picked since that the cluster doesn't list (typed); then the
  // rest, each where it was, ticked or not.
  const since = picked.filter((name) => !first.includes(name) && !names.includes(name))
  const top = [...first, ...since]
  const rest = names.filter((name) => !top.includes(name))

  const row = (name: string, index: number) => {
    const on = picked.includes(name)
    const box = (event: MouseEvent) => {
      // (The box is its own target: the name beside it picks only this one.)
      event.preventDefault()
      event.stopPropagation()
      toggle(name)
    }
    return (
      <Command.Item
        key={name}
        value={name}
        onSelect={() => only(name)}
        // (Named by its name alone: its box is a checkbox of its own, named the same.)
        aria-labelledby={`${id}-${index}`}
        className={cn(menuItem, 'gap-2', phone && 'h-11 pl-0')}
      >
        <button
          type="button"
          role="checkbox"
          aria-checked={on}
          aria-label={name}
          tabIndex={-1}
          disabled={!on && full}
          onClick={box}
          onPointerDown={(event) => event.stopPropagation()}
          className={cn(
            'grid shrink-0 place-items-center disabled:opacity-45',
            phone ? 'size-11' : '-my-1 -ml-2 size-8',
          )}
        >
          <span
            className={cn(
              'grid size-4 place-items-center rounded border',
              on ? 'border-accent bg-accent text-white' : 'border-line-strong bg-surface',
            )}
          >
            {on && <Check className="size-3" strokeWidth={3} />}
          </span>
        </button>
        <span id={`${id}-${index}`} className="min-w-0 flex-1 truncate" title={name}>
          {name}
        </span>
        {!listed.isPending && !names.includes(name) && (
          <Tooltip content="Typed, not listed by the cluster">
            <span className="text-2xs text-ink-3">typed</span>
          </Tooltip>
        )}
        {terminating.has(name) && (
          <span className="text-2xs font-medium text-warn-text">Terminating</span>
        )}
      </Command.Item>
    )
  }

  const lines = byName(picked)
  const tooltip =
    picked.length > 1 ? (
      <div className="max-w-[280px]">
        {(lines.length > TOOLTIP_LINES ? lines.slice(0, TOOLTIP_LINES - 1) : lines).map((name) => (
          <div key={name} className="truncate">
            {name}
          </div>
        ))}
        {lines.length > TOOLTIP_LINES && <div>and {lines.length - (TOOLTIP_LINES - 1)} more</div>}
      </div>
    ) : undefined

  return (
    <Picker
      open={open}
      onOpenChange={opened}
      title="Namespaces"
      align="end"
      className="w-72 p-0"
      tooltip={tooltip}
      sheetHeader={
        <div className="flex h-11 shrink-0 items-center gap-1 px-1">
          <button
            type="button"
            aria-label="Close"
            onClick={() => opened(false)}
            className={barButton}
          >
            <X />
          </button>
          {/* (The sheet's title, for a screen reader, is the picker's own: this is its look.) */}
          <span
            aria-hidden
            className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink-1"
          >
            Namespaces
          </span>
          {picked.length > 0 && (
            <button
              type="button"
              onClick={() => opened(false)}
              className="h-11 px-3 text-[15px] font-semibold text-accent"
            >
              Done
            </button>
          )}
        </div>
      }
      trigger={
        <button
          type="button"
          aria-label="Namespace"
          className={
            chip
              ? contextChip
              : `${trigger} hover:bg-surface-3 hover:text-ink-1 data-[state=open]:bg-surface-3`
          }
        >
          <LayoutGrid className="size-3.5 shrink-0 text-ink-3" />
          {chip && picked.length <= 1 ? (
            <MiddleTruncate text={text} />
          ) : (
            <span className="truncate font-medium">{text}</span>
          )}
          <ChevronDown className="size-3.5 shrink-0 text-ink-3" />
        </button>
      }
    >
      <Command
        loop
        filter={matchWords}
        value={highlighted}
        onValueChange={setHighlighted}
        onKeyDown={keys}
      >
        <Command.Input
          value={search}
          onValueChange={setSearch}
          placeholder="Find a namespace…"
          className="h-10 w-full border-b border-line bg-transparent px-3 text-[13px] text-ink-1 outline-none placeholder:text-ink-3 phone:h-11 phone:px-4"
        />
        <Command.List className="max-h-80 overflow-y-auto p-1 phone:max-h-none phone:px-2 phone:pb-3">
          <Command.Item value="All namespaces" onSelect={() => only(null)} className={menuItem}>
            <span className="flex-1">All namespaces</span>
            {picked.length === 0 && <Check className="size-4 text-accent" />}
          </Command.Item>
          <Command.Separator className="mx-1 my-1 h-px bg-line" />
          {top.map((name, i) => row(name, i))}
          {top.length > 0 && rest.length > 0 && (
            <Command.Separator className="mx-1 my-1 h-px bg-line" />
          )}
          {rest.map((name, i) => row(name, top.length + i))}
          {typed && !names.includes(typed) && !picked.includes(typed) && (
            <Command.Item
              forceMount
              value={usingTyped(typed)}
              onSelect={() => only(typed)}
              className={menuItem}
            >
              <Plus className="size-4 shrink-0 text-ink-2" />
              <span className="min-w-0 flex-1 truncate">Use namespace “{typed}”</span>
            </Command.Item>
          )}
        </Command.List>
        {full && (
          <p className="border-t border-line px-3 py-2 text-xs text-ink-3">
            {MOST_NAMESPACES} namespaces at most. Take one away to add another.
          </p>
        )}
        {linkNamed && !linkSaid && (
          <p className="border-t border-line px-3 py-2 text-xs text-ink-3">
            The link named {linkNamed} namespaces. The first {MOST_NAMESPACES}, in name order, are
            picked.
          </p>
        )}
        {notAName && (
          <p className="border-t border-line px-3 py-2 text-xs text-ink-3">
            {/[,\s]/.test(notAName)
              ? `Type one namespace at a time. ${MOD_KEY}↵ adds it and keeps the menu open.`
              : 'A namespace’s name is lowercase letters, digits and hyphens, 63 at most, starting and ending with a letter or a digit.'}
          </p>
        )}
        {listed.isError && (
          <p className="border-t border-line px-3 py-2 text-xs text-ink-3">
            Namespaces couldn’t be listed. Type a name to use it.
          </p>
        )}
        {!phone && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-line px-3 py-2 text-[11.5px] text-ink-3">
            <span className="flex items-center gap-1">
              <Kbd>↵</Kbd>only this one
            </span>
            <span className="flex items-center gap-1">
              <Kbd>{MOD_KEY}↵</Kbd>add or take away
            </span>
          </div>
        )}
      </Command>
    </Picker>
  )
}

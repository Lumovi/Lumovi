import { Command } from 'cmdk'
import { Check, ChevronDown, Globe2, LayoutGrid } from 'lucide-react'
import { useState } from 'react'
import { Picker } from '@renderer/components/Picker'
import { MiddleTruncate } from '@renderer/components/MiddleTruncate'
import { Tooltip } from '@renderer/components/Tooltip'
import { useList } from '@renderer/hooks/queries'
import { matchWords } from '@renderer/lib/match'
import { useCluster } from '@renderer/state/cluster'
import { menuItem } from './menu-styles'

const trigger =
  'flex h-8 max-w-56 items-center gap-2 rounded-lg px-2.5 text-[13px] text-ink-2 transition-colors no-drag'

/**
 * A chip of the context row, under a narrow page's top bar: 32 px high, in a row whose 44 px
 * are what a finger gets (the chip's own before reaches them).
 */
export const contextChip =
  'relative flex h-8 min-w-0 items-center gap-2 rounded-lg border border-line bg-surface-2 px-2.5 text-[13px] font-medium text-ink-1 before:absolute before:-inset-x-1 before:-inset-y-1.5'

export function NamespacePicker({
  clusterScoped,
  chip = false,
}: {
  clusterScoped: boolean
  /** In the context row, as a chip. */
  chip?: boolean
}) {
  const { namespace, setNamespace } = useCluster()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const namespaces = useList('Namespace', { namespace: null })
  const names = namespaces.data?.map((ns) => ns.metadata.name) ?? []
  const terminating = new Set(
    namespaces.data
      ?.filter((ns) => ns.status?.phase === 'Terminating')
      .map((ns) => ns.metadata.name),
  )
  const typed = search.trim()

  const choose = (value: string | null) => {
    setNamespace(value)
    setOpen(false)
    setSearch('')
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

  return (
    <Picker
      open={open}
      onOpenChange={setOpen}
      title="Namespace"
      align="end"
      className="w-64 p-0"
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
          {chip ? (
            <MiddleTruncate text={namespace ?? 'All namespaces'} />
          ) : (
            <span className="truncate font-medium">{namespace ?? 'All namespaces'}</span>
          )}
          <ChevronDown className="size-3.5 shrink-0 text-ink-3" />
        </button>
      }
    >
      <Command loop filter={matchWords}>
        <Command.Input
          value={search}
          onValueChange={setSearch}
          placeholder="Find a namespace…"
          className="h-10 w-full border-b border-line bg-transparent px-3 text-[13px] text-ink-1 outline-none placeholder:text-ink-3 phone:h-11 phone:px-4"
        />
        <Command.List className="max-h-80 overflow-y-auto p-1 phone:max-h-none phone:px-2 phone:pb-3">
          <Command.Item value="All namespaces" onSelect={() => choose(null)} className={menuItem}>
            <span className="flex-1">All namespaces</span>
            {namespace === null && <Check className="size-4 text-accent" />}
          </Command.Item>
          <Command.Separator className="mx-1 my-1 h-px bg-line" />
          {names.map((name) => (
            <Command.Item
              key={name}
              value={name}
              onSelect={() => choose(name)}
              className={menuItem}
            >
              <span className="flex-1 truncate">{name}</span>
              {terminating.has(name) && (
                <span className="text-2xs font-medium text-warn-text">Terminating</span>
              )}
              {namespace === name && <Check className="size-4 text-accent" />}
            </Command.Item>
          ))}
          {typed && !names.includes(typed) && (
            <Command.Item
              forceMount
              value={`use ${typed}`}
              onSelect={() => choose(typed)}
              className={menuItem}
            >
              Use namespace “{typed}”
            </Command.Item>
          )}
        </Command.List>
        {namespaces.isError && (
          <p className="border-t border-line px-3 py-2 text-xs text-ink-3">
            Namespaces couldn’t be listed. Type a name to use it.
          </p>
        )}
      </Command>
    </Picker>
  )
}

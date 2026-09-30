import { Command } from 'cmdk'
import { Check, ChevronDown, Globe2, LayoutGrid } from 'lucide-react'
import { Popover } from 'radix-ui'
import { useState } from 'react'
import { Tooltip } from '@renderer/components/Tooltip'
import { useList } from '@renderer/hooks/queries'
import { matchWords } from '@renderer/lib/match'
import { useCluster } from '@renderer/state/cluster'
import { menuContent, menuItem } from './menu-styles'

const trigger =
  'flex h-8 max-w-56 items-center gap-2 rounded-lg px-2.5 text-[13px] text-ink-2 transition-colors no-drag'

export function NamespacePicker({ clusterScoped }: { clusterScoped: boolean }) {
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
        <span aria-label="Namespace" className={`${trigger} cursor-default text-ink-3`}>
          <Globe2 className="size-3.5 shrink-0" />
          Cluster-wide
        </span>
      </Tooltip>
    )
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label="Namespace"
        className={`${trigger} hover:bg-surface-3 hover:text-ink-1 data-[state=open]:bg-surface-3`}
      >
        <LayoutGrid className="size-3.5 shrink-0 text-ink-3" />
        <span className="truncate font-medium">{namespace ?? 'All namespaces'}</span>
        <ChevronDown className="size-3.5 shrink-0 text-ink-3" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} className={`${menuContent} w-64 p-0`}>
          <Command loop filter={matchWords}>
            <Command.Input
              value={search}
              onValueChange={setSearch}
              placeholder="Find a namespace…"
              className="h-10 w-full border-b border-line bg-transparent px-3 text-[13px] text-ink-1 outline-none placeholder:text-ink-3"
            />
            <Command.List className="max-h-80 overflow-y-auto p-1">
              <Command.Item
                value="All namespaces"
                onSelect={() => choose(null)}
                className={menuItem}
              >
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
                Namespaces could not be listed. Type a name to use it.
              </p>
            )}
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

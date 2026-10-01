import { Ellipsis, Lock, LockOpen } from 'lucide-react'
import { ContextMenu, DropdownMenu, Popover } from 'radix-ui'
import { useEffect } from 'react'
import type { KubeObject } from '@shared/api'
import { Button } from '@renderer/components/Button'
import { Kbd, MOD_KEY } from '@renderer/components/Kbd'
import { Tooltip } from '@renderer/components/Tooltip'
import { useReadOnly } from '@renderer/hooks/settings'
import { cn } from '@renderer/lib/cn'
import { keepFocusInActionDialog, useActionsUi } from '@renderer/state/actions'
import { useCluster } from '@renderer/state/cluster'
import { menuContent, menuItem } from '../shell/menu-styles'
import { actionById } from './catalog'
import { useObjectActions, useRunAction, type AvailableAction } from './use-actions'

/** Renders the dialog of the action in progress, wherever it was started from. */
export function ActionHost() {
  const active = useActionsUi((state) => state.active)
  const close = useActionsUi((state) => state.close)
  if (!active) return null
  const Dialog = actionById(active.id, active.object).dialog!
  return <Dialog key={active.object.metadata.uid} object={active.object} onClose={close} />
}

const isEditable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

/**
 * The detail panel's actions: the most common ones as buttons, everything in
 * a menu. `.` opens the menu and ⌘⌫ starts a delete.
 */
export function ActionBar({ object }: { object: KubeObject }) {
  const available = useObjectActions(object)
  const run = useRunAction()
  const { readOnly } = useReadOnly()
  const open = useActionsUi((state) => state.menu)
  const setOpen = useActionsUi((state) => state.setMenu)
  // Kinds without a headline action (Secrets, Services…) offer their YAML instead.
  // Actions that depend on the object's state (Resume, Uncordon…) come first.
  const headline = available
    .filter(({ action }) => action.primary)
    .sort((a, b) => Number(Boolean(b.action.when)) - Number(Boolean(a.action.when)))
  const primary = (
    headline.length ? headline : available.filter(({ action }) => action.editor)
  ).slice(0, 2)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditable(event.target) || document.querySelector('[role="dialog"], [role="menu"]'))
        return
      if (event.key === '.' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault()
        setOpen(true)
        return
      }
      // Every kind with actions can be deleted.
      const remove = available.find(({ action }) => action.id === 'delete')!
      if (event.key === 'Backspace' && (event.metaKey || event.ctrlKey) && !remove.disabled) {
        event.preventDefault()
        run(remove.action, object)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  return (
    <div className="flex items-center gap-1.5">
      {readOnly && <ReadOnlyBadge />}
      {primary.map(({ action, disabled }) => {
        const button = (
          <Button
            key={action.id}
            disabled={disabled !== undefined}
            onClick={() => run(action, object)}
            className="h-7 px-2.5 text-xs disabled:opacity-50"
          >
            <action.icon className="!size-3.5" />
            {action.label}
          </Button>
        )
        // Disabled buttons get no pointer events, so a wrapper carries the reason.
        return disabled ? (
          <Tooltip key={action.id} content={disabled}>
            <span tabIndex={0}>{button}</span>
          </Tooltip>
        ) : (
          button
        )
      })}
      <DropdownMenu.Root open={open} onOpenChange={setOpen}>
        <DropdownMenu.Trigger
          aria-label="More actions"
          className="grid size-7 place-items-center rounded-lg border border-line-strong bg-surface-2 text-ink-2 shadow-xs transition-colors hover:bg-surface-3 hover:text-ink-1 data-[state=open]:bg-surface-3"
        >
          <Ellipsis className="size-4" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            sideOffset={6}
            onCloseAutoFocus={keepFocusInActionDialog}
            className={cn(menuContent, 'min-w-56')}
          >
            <DropdownMenu.Label className="flex items-center justify-between px-2 pt-1 pb-1.5 text-2xs font-medium tracking-wider text-ink-3 uppercase">
              Actions <Kbd>.</Kbd>
            </DropdownMenu.Label>
            <ActionItems
              available={available}
              object={object}
              Item={DropdownMenu.Item}
              Separator={DropdownMenu.Separator}
            />
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  )
}

/** The actions for a table row, inside its context menu. */
export function RowActions({ object }: { object: KubeObject }) {
  const available = useObjectActions(object)
  return (
    <>
      <ContextMenu.Separator className="mx-1 my-1 h-px bg-line" />
      <ActionItems
        available={available}
        object={object}
        Item={ContextMenu.Item}
        Separator={ContextMenu.Separator}
      />
    </>
  )
}

function ActionItems({
  available,
  object,
  Item,
  Separator,
}: {
  available: AvailableAction[]
  object: KubeObject
  Item: typeof DropdownMenu.Item
  Separator: typeof DropdownMenu.Separator
}) {
  const run = useRunAction()
  const safe = available.filter(({ action }) => !action.danger)
  const danger = available.filter(({ action }) => action.danger)
  const item = ({ action, disabled }: AvailableAction) => (
    <Item
      key={action.id}
      disabled={disabled !== undefined}
      aria-keyshortcuts={action.danger ? 'Meta+Backspace Control+Backspace' : undefined}
      onSelect={() => run(action, object)}
      className={cn(
        menuItem,
        'data-[disabled]:opacity-45',
        action.danger && 'text-critical-text data-[highlighted]:bg-critical/10',
      )}
    >
      <action.icon className={cn('size-4', action.danger ? 'text-critical-text' : 'text-ink-3')} />
      <span className="flex-1">{action.label}</span>
      {action.danger && (
        <span aria-hidden className="flex gap-0.5 opacity-70">
          <Kbd>{MOD_KEY}</Kbd>
          <Kbd>⌫</Kbd>
        </span>
      )}
    </Item>
  )
  const reason = available.find(({ disabled }) => disabled)?.disabled
  return (
    <>
      {safe.map(item)}
      <Separator className="mx-1 my-1 h-px bg-line" />
      {danger.map(item)}
      {reason && (
        <p className="max-w-64 px-2 pt-1.5 pb-1 text-xs leading-snug text-ink-3">{reason}</p>
      )}
    </>
  )
}

/** Shown instead of working actions when the cluster is read-only, with a way to allow changes. */
export function ReadOnlyBadge() {
  const { context } = useCluster()
  const { locked, set } = useReadOnly()
  return (
    <Popover.Root>
      <Popover.Trigger className="flex h-7 items-center gap-1.5 rounded-lg bg-surface-3 px-2.5 text-xs font-medium text-ink-2 hover:text-ink-1">
        <Lock className="size-3.5" /> Read-only
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content sideOffset={6} align="start" className={cn(menuContent, 'w-72 p-3')}>
          <p className="text-[13px] font-medium text-ink-1">Changes are off for {context}</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-2">
            {locked
              ? 'KUBESTACKS_READ_ONLY is set, so KubeStacks can’t change any cluster.'
              : 'KubeStacks won’t change anything in this cluster until you allow it.'}
          </p>
          {!locked && (
            <Button
              variant="secondary"
              className="mt-3 h-7 text-xs"
              onClick={() => void set(false)}
            >
              <LockOpen /> Allow changes
            </Button>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

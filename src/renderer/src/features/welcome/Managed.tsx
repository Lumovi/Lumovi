import { Lock } from 'lucide-react'
import { Popover } from 'radix-ui'
import { useSettings } from '@renderer/hooks/settings'
import { cn } from '@renderer/lib/cn'
import { menuContent } from '../shell/menu-styles'

/**
 * In place of adding clusters when an organization's policy keeps Lumovi to KUBECONFIG's
 * kubeconfig, or ~/.kube/config: why, and the policy's file.
 */
export function ManagedBadge({ reason }: { reason: string }) {
  const managed = useSettings().data?.managed
  return (
    <Popover.Root>
      <Popover.Trigger className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-surface-3 px-2.5 text-xs font-medium text-ink-2 hover:text-ink-1">
        <Lock className="size-3.5" /> Managed
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={6}
          align="end"
          className={cn(menuContent, 'w-[340px] p-3')}
          // Its keys are its own: not the list's it's in (React's events pass through portals).
          onKeyDown={(event) => event.stopPropagation()}
        >
          <p className="text-[13px] font-semibold text-ink-1">Managed by your organization</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-2">
            {managed?.problem
              ? reason
              : 'Your organization’s policy keeps Lumovi to the kubeconfig in KUBECONFIG or ~/.kube/config, so it can’t add files or clusters.'}
          </p>
          {managed?.source && (
            // Cut from the start: the policy's file name shows.
            <p
              className="mt-2 truncate font-mono text-2xs text-ink-3 [direction:rtl] selectable"
              title={managed.source}
            >
              <bdi>{managed.source}</bdi>
            </p>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

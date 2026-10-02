import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Cable, CircleAlert, ExternalLink, Square } from 'lucide-react'
import { Popover } from 'radix-ui'
import { useEffect } from 'react'
import type { KubestacksApi, PortForward } from '@shared/api'
import { IconButton } from '@renderer/components/Button'
import { CopyButton } from '@renderer/components/CopyButton'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { menuContent } from '../shell/menu-styles'

/** Ports forwarded to pods (by the desktop app), in every cluster; shown while there are any. */
export function ForwardsButton({
  api: forwarding,
}: {
  api: NonNullable<KubestacksApi['forwards']>
}) {
  const queryClient = useQueryClient()
  const forwards = useQuery({ queryKey: ['forwards'], queryFn: () => forwarding.list() }).data
  useEffect(
    () => forwarding.onChange((list) => queryClient.setQueryData(['forwards'], list)),
    [forwarding, queryClient],
  )
  if (!forwards?.length) return null
  const failing = forwards.some((f) => f.error)
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <IconButton label="Port forwards" className="relative">
          <Cable className={cn(failing && 'text-critical-text')} />
          <span className="absolute top-0.5 right-0.5 grid h-3.5 min-w-3.5 animate-pop-in place-items-center rounded-full bg-good px-1 text-[9px] font-semibold text-white tabular-nums">
            {forwards.length}
          </span>
        </IconButton>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          aria-label="Port forwards"
          className={cn(menuContent, 'w-[400px] p-0')}
        >
          <header className="border-b border-line px-4 py-2.5">
            <h2 className="text-[13px] font-semibold text-ink-1">Port forwards</h2>
          </header>
          <ul className="max-h-[60vh] divide-y divide-line overflow-y-auto">
            {forwards.map((forward) => (
              <Forward key={forward.id} forward={forward} stop={forwarding.stop} />
            ))}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function Forward({ forward, stop }: { forward: PortForward; stop: (id: string) => Promise<void> }) {
  const url = `http://localhost:${forward.localPort}`
  return (
    <li className="px-4 py-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void api.app.openExternal(url)}
          className="flex items-center gap-1.5 font-mono text-[13px] font-medium text-accent-strong hover:underline"
        >
          localhost:{forward.localPort}
          <ExternalLink className="size-3.5" />
        </button>
        <span className="flex-1" />
        <CopyButton text={url} label="Copy address" />
        <IconButton label="Stop forwarding" onClick={() => void stop(forward.id)}>
          <Square />
        </IconButton>
      </div>
      <p className="mt-0.5 text-xs text-ink-2">
        → {forward.kind === 'Service' ? `${forward.name} → ` : ''}
        <span className="font-mono">
          {forward.pod}:{forward.podPort}
        </span>{' '}
        · {forward.namespace} · {forward.context}
      </p>
      <p className="mt-0.5 text-xs text-ink-3" aria-live="polite">
        {forward.connections === 1 ? '1 connection' : `${forward.connections} connections`}
      </p>
      {forward.error && (
        <p className="mt-1 flex gap-1.5 text-xs text-critical-text">
          <CircleAlert className="mt-px size-3.5 shrink-0" />
          {forward.error}
        </p>
      )}
    </li>
  )
}

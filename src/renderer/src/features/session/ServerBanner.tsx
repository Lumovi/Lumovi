import { LoaderCircle } from 'lucide-react'
import { useConnection } from '@renderer/web/connection'

/** After this many failed attempts, the banner says what may be wrong. */
const PERSISTENT = 3

/** Says when the page lost its connection to the KubeStacks server, while it reconnects. */
export function ServerBanner() {
  const { state, failures } = useConnection()
  if (state !== 'reconnecting') return null
  return (
    <div
      role="status"
      className="flex shrink-0 animate-fade-in items-center gap-3 border-b border-warn/25 bg-warn/10 px-5 py-2 text-[13px]"
    >
      <LoaderCircle className="size-4 shrink-0 animate-spin text-warn-text" />
      <span className="min-w-0 flex-1 truncate text-ink-1">
        <span className="font-medium">Reconnecting to KubeStacks…</span>{' '}
        <span className="text-ink-2">
          {failures < PERSISTENT
            ? 'What’s shown may be out of date.'
            : 'If this goes on, the server may be down, or a proxy in front of it may not pass WebSockets.'}
        </span>
      </span>
    </div>
  )
}

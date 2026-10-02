import { CircleArrowUp, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { KubestacksApi, UpdateEvent, UpdateState } from '@shared/api'
import { REPO_URL } from '@shared/app'
import { api } from '@renderer/lib/api'
import { toast } from '@renderer/state/toasts'
import { Button } from './Button'

/** What a check the user asked for (Help → Check for Updates) found. */
function report(state: UpdateState) {
  switch (state.status) {
    case 'up-to-date':
      toast({ tone: 'success', title: 'KubeStacks is up to date' })
      break
    case 'downloading':
      toast({
        tone: 'success',
        title: `Downloading KubeStacks ${state.version}…`,
        description: 'You can restart into it once it’s downloaded.',
      })
      break
    case 'unsupported':
      toast({
        tone: 'error',
        title: 'This copy of KubeStacks doesn’t update itself',
        description: 'New versions are on GitHub.',
        action: {
          label: 'Download',
          run: () => void api.app.openExternal(`${REPO_URL}/releases/latest`),
        },
      })
      break
    case 'error':
      toast({ tone: 'error', title: 'Couldn’t check for updates', description: state.message })
      break
  }
}

/**
 * Says when a new version of the desktop app is ready to install, and reports
 * checks the user asked for.
 */
export function UpdateNotice({ updates }: { updates: NonNullable<KubestacksApi['updates']> }) {
  // The version ready to install, until the notice is dismissed.
  const [ready, setReady] = useState<string>()
  useEffect(() => {
    const apply = ({ state, manual }: UpdateEvent) => {
      setReady(state.status === 'ready' ? state.version : undefined)
      if (manual) report(state)
    }
    void updates.state().then(apply)
    return updates.onChange(apply)
  }, [updates])

  if (!ready) return null
  return (
    <section
      role="status"
      aria-label="Update"
      className="fixed bottom-4 left-4 z-[60] flex w-[340px] max-w-[calc(100vw-32px)] animate-toast-in items-start gap-3 rounded-xl border border-line-strong bg-surface-2 py-3 pr-2 pl-3.5 shadow-pop"
    >
      <CircleArrowUp className="mt-px size-[18px] shrink-0 text-accent-strong" />
      <div className="min-w-0 flex-1 py-px">
        <p className="text-[13px] leading-snug font-medium text-ink-1">
          KubeStacks {ready} is ready
        </p>
        <p className="mt-0.5 text-xs leading-relaxed text-ink-2">
          It’s installed when you quit, or restart into it now.
        </p>
        <div className="mt-2.5 flex gap-1.5">
          <Button
            variant="primary"
            className="h-7 px-2.5 text-xs"
            onClick={() => void updates.install()}
          >
            Restart now
          </Button>
          <Button
            variant="ghost"
            className="h-7 px-2 text-xs"
            onClick={() => void api.app.openExternal(`${REPO_URL}/releases/tag/v${ready}`)}
          >
            What’s new
          </Button>
        </div>
      </div>
      <button
        type="button"
        aria-label="Later"
        onClick={() => setReady(undefined)}
        className="grid size-6 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-surface-3 hover:text-ink-1"
      >
        <X className="size-3.5" />
      </button>
    </section>
  )
}

/**
 * Agreeing to run the code of one of the person's own plugins (Developer mode, the desktop
 * app's): the store's dialog, from what the main process reads of it now; that alone checks the
 * agreement and keeps it (src/main/plugins-agreed.ts). This only asks.
 */
import { useQueryClient } from '@tanstack/react-query'
import { createContext, useEffect, useState, type ReactNode } from 'react'
import type { Plugin } from '@shared/plugins'
import { api } from '@renderer/lib/api'
import type { KindNames } from './ask-lines'
import type { Granted } from './granted'
import { StoreDialog, type StoreDialogIs } from './store-dialog'

/** How the person's folder writes its path: with Windows' separator, where it does. */
const separator = (folder: string) => (folder.includes('\\') && !folder.includes('/') ? '\\' : '/')

/** Opens what one of the person's own may do, to agree to: the Plugins page's, from a row. */
export const AgreeFrom = createContext<((plugin: Plugin) => void) | undefined>(undefined)

/**
 * `ask`: opens the dialog for one of the person's own plugins whose code waits (none, where
 * there's no Developer mode here); `dialog`: the dialog, while it's open.
 */
export function useAgree({
  names,
  directory,
  onAgreed,
}: {
  names: KindNames
  /** The person's plugins folder, as it's shown ("~/.lumovi/plugins"). */
  directory: string
  /** After agreeing: its page runs again. */
  onAgreed?: () => void
}): { ask?: (plugin: Plugin) => Promise<void>; dialog: ReactNode } {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState<{ is: StoreDialogIs; asks: string; code: string }>()
  const own = api.ownCode

  /** Read again: the plugins, and whether each one's code is handed over now. */
  const done = async () => {
    await queryClient.invalidateQueries({ queryKey: ['plugins'] })
    await queryClient.invalidateQueries({ queryKey: ['plugin-hand-over'] })
  }
  const ask = async (plugin: Plugin) => {
    const standing = await own!.standing(plugin.name)
    // (Nothing to agree to now: agreed already, or no longer one of theirs with code.)
    if (!standing || standing.standing === 'agreed') return done()
    setOpen({
      is: {
        kind: 'agree',
        plugin,
        // (What it asks, and what was agreed, as the main process holds them: one text each.)
        granted: JSON.parse(standing.asks) as Granted,
        path: [directory, plugin.name, 'plugin.yaml'].join(separator(directory)),
        waiting: standing.standing,
        ...(standing.agreed !== undefined
          ? { agreed: JSON.parse(standing.agreed) as Granted }
          : {}),
      },
      asks: standing.asks,
      code: standing.code,
    })
  }

  const dialog: ReactNode = open && (
    <StoreDialog
      is={open.is}
      names={names}
      onConfirm={async () => {
        await own!.agree(open.is.plugin.name, open.asks, open.code)
        setOpen(undefined)
        await done()
        onAgreed?.()
      }}
      onClose={() => setOpen(undefined)}
    />
  )
  return { ...(own ? { ask } : {}), dialog }
}

/**
 * In Developer mode, the person's plugins folder as it changes: each change has the plugins read
 * again (and their code's hand-over), and is counted, for a page to be made anew with it.
 */
export function useOwnChanges(): number {
  const queryClient = useQueryClient()
  const [changes, setChanges] = useState(0)
  useEffect(
    () =>
      api.ownCode?.onChange(() => {
        void queryClient.invalidateQueries({ queryKey: ['plugins'] })
        void queryClient.invalidateQueries({ queryKey: ['plugin-hand-over'] })
        setChanges((n) => n + 1)
      }),
    [queryClient],
  )
  return changes
}

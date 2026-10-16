/**
 * What this window has below, kept for when Lumovi opens it again: read back once as the page
 * starts, then said to the main process as it changes (a little after, not at every keystroke).
 * And the window goes back to where its page was: never a cluster gone from the kubeconfig, nor
 * one that signs in through a program (that waits for a press, on the start screen).
 */
import { useEffect } from 'react'
import { movedTabOf } from '@shared/moved-tab'
import { api } from '@renderer/lib/api'
import { useActionsUi } from '@renderer/state/actions'
import { useDock } from './dock'

let restoredNow: () => void = () => {}
/** Once this window is back where it was (or on its start screen): what a link's card waits for. */
export const windowRestored = new Promise<void>((resolve) => (restoredNow = resolve))

/** How long a change waits before it's said, others after it said with it. */
const SAY_AFTER_MS = 300

export function BelowKept() {
  useEffect(() => {
    let gone = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let unsubscribe: (() => void) | undefined
    // A tab put back below here, from a window of its own: shown, on a cluster's page (where the
    // tabs below are). Not one that waits to be read: that's for when its cluster's opened.
    const returned = api.desktop!.onTabReturned((given) => {
      const tab = movedTabOf(given)
      if (!tab) return
      useDock.getState().receive(tab)
      const waiting = tab.kind === 'kept' && tab.waiting
      if (!waiting && !window.location.hash.startsWith('#/cluster/')) {
        window.location.hash = `#/cluster/${encodeURIComponent(tab.context)}`
      }
    })
    void (async () => {
      const [{ page, below, asked, tab }, contexts] = await Promise.all([
        api.desktop!.restored(),
        api.kube.contexts().catch(() => undefined),
      ])
      if (gone) return
      const known = new Map((contexts?.contexts ?? []).map((c) => [c.name, c]))
      // Where it was: gone to, where that's a cluster still there, and one that doesn't sign in
      // through a program (that waits for a press, from the start screen). Else the start screen.
      const at = page && /^#\/cluster\/([^/?]+)/.exec(page)?.[1]
      const cluster = at ? known.get(decodeURIComponent(at)) : undefined
      // (Opened from a link's card, New window: asked for, so it goes there whatever, on its tab.)
      if (page && (!at || (cluster && (!cluster.signsInWith || asked)))) {
        window.location.replace(page)
        const open = asked && tab ? new URLSearchParams(page.split('?')[1]).get('open') : null
        if (open && tab) {
          if (tab === 'logs') useActionsUi.setState({ linkedLogs: open })
          useActionsUi.getState().showTab(open, tab)
        }
      }
      restoredNow()
      // (A cluster that signs in through a program: its tabs wait to be shown before they read.)
      useDock.getState().restore(below, (context) => Boolean(known.get(context)?.signsInWith))
      const say = () => api.desktop!.keepBelow(useDock.getState().snapshot())
      say()
      unsubscribe = useDock.subscribe(() => {
        clearTimeout(timer)
        timer = setTimeout(say, SAY_AFTER_MS)
      })
    })()
    return () => {
      gone = true
      clearTimeout(timer)
      unsubscribe?.()
      returned()
    }
  }, [])
  return null
}

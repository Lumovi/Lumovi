import { useEffect } from 'react'
import { toast } from '@renderer/state/toasts'

/**
 * Says what Lumovi couldn't set up as it started (the desktop app): its organization's policy,
 * a certificate authority's file, a proxy. Otherwise only a terminal that started it would.
 */
export function StartupProblems({ problems }: { problems: () => Promise<string[]> }) {
  useEffect(() => {
    void problems().then((found) => {
      for (const description of found) {
        toast({
          tone: 'error',
          title: 'Lumovi started without something it was given',
          description,
        })
      }
    })
  }, [problems])
  return null
}

/** A note from Lumovi as it goes (the desktop app's), said once: a token it couldn't save, say. */
export type OnNote = (
  listener: (note: { title: string; description: string }) => void,
) => () => void

/** Says what Lumovi has to say as it goes, each once, as it's said. */
export function Notes({ onNote }: { onNote: OnNote }) {
  useEffect(
    () => onNote(({ title, description }) => toast({ tone: 'error', title, description })),
    [onNote],
  )
  return null
}

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

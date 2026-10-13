/**
 * The page's person's pins and saved views in the cluster that's open: the desktop's own, kept with
 * its preferences; or on a server, theirs, as the server keeps them for them (never in the
 * browser). A change shows at once and is put back if the server refuses it, saying why.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { spelled } from '@shared/kit/characters'
import { NO_MARKS, type Marks, type Pin } from '@shared/marks'
import { api, unwrap } from '@renderer/lib/api'
import { pinAt, pinning, repinning, unpinning } from '@renderer/lib/marks'
import { useCluster } from '@renderer/state/cluster'
import { usePrefs } from '@renderer/state/prefs'
import { useToasts } from '@renderer/state/toasts'

/** Where a server keeps them: none on the desktop. */
const kept = api.marks

export interface MarksStore {
  marks: Marks
  /** As they are now, for what's done later (an undo): never what was drawn a while ago. */
  latest(): Marks
  /** Keeps them; or says, in Lumovi's words, why they weren't. */
  save(next: Marks): Promise<string | undefined>
}

export function useMarks(): MarksStore {
  const { context } = useCluster()
  const queryClient = useQueryClient()
  const local = usePrefs((prefs) => prefs.marks[context])
  const setLocal = usePrefs((prefs) => prefs.setMarks)
  const server = useQuery({
    queryKey: ['marks', context],
    queryFn: () => unwrap(kept!.get(context)),
    enabled: kept !== undefined,
  })
  const marks = kept ? (server.data ?? NO_MARKS) : (local ?? NO_MARKS)
  const latest = useCallback(
    () =>
      kept
        ? (queryClient.getQueryData<Marks>(['marks', context]) ?? NO_MARKS)
        : (usePrefs.getState().marks[context] ?? NO_MARKS),
    [queryClient, context],
  )
  const save = useCallback(
    async (next: Marks) => {
      if (!kept) {
        setLocal(context, next)
        return undefined
      }
      const at = ['marks', context]
      const before = queryClient.getQueryData<Marks>(at)
      queryClient.setQueryData(at, next)
      const result = await kept.set(context, next).catch((error: unknown) => ({
        ok: false as const,
        error: { message: error instanceof Error ? error.message : String(error) },
      }))
      if (result.ok) return undefined
      queryClient.setQueryData(at, before)
      return result.error.message
    },
    [queryClient, context, setLocal],
  )
  return { marks, latest, save }
}

/** How a toast names a pinned object: its kind and name, the name's marks spelled. */
export const calledPin = (kindName: string, pin: Pin) => `${kindName} ${spelled(pin.name)}`

/** Pinning and unpinning, each said in a toast with an undo; a refusal said in Lumovi's words. */
export function usePinning() {
  const store = useMarks()
  const show = useToasts((toasts) => toasts.show)
  const { marks, latest, save } = store
  const refused = (title: string) => show({ tone: 'error', title })

  const unpin = async (pin: Pin, called: string) => {
    const { marks: next, at } = unpinning(latest(), pin)
    if (at < 0) return
    const why = await save(next)
    if (why) return refused(why)
    show({
      tone: 'success',
      title: `Unpinned ${called}`,
      action: {
        label: 'Undo',
        run: () => void save(repinning(latest(), pin, at)).then((no) => no && refused(no)),
      },
    })
  }

  const pin = async (pin: Pin, called: string) => {
    const worked = pinning(latest(), pin, called)
    if ('refused' in worked) return refused(worked.refused)
    const why = await save(worked.marks)
    if (why) return refused(why)
    show({
      tone: 'success',
      title: `Pinned ${called}`,
      action: {
        label: 'Undo',
        run: () => void save(unpinning(latest(), pin).marks).then((no) => no && refused(no)),
      },
    })
  }

  return {
    ...store,
    pinned: (each: Pin) => pinAt(marks, each) >= 0,
    pin,
    unpin,
    /** Pinned if it isn't, unpinned if it is. */
    toggle: (each: Pin, called: string) =>
      pinAt(latest(), each) >= 0 ? unpin(each, called) : pin(each, called),
  }
}

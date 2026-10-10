import { create } from 'zustand'
import { leftOutText, sized, type FileCopyEnd, type FileCopyProgress } from '@shared/files'
import { api } from '@renderer/lib/api'
import { useActivity } from './activity'
import { toast } from './toasts'

/** A copy of files out of a container or into one, from when it began. */
export interface FileCopy {
  id: string
  direction: 'download' | 'upload'
  /** What, and where: "/var/log/app.log from web-1". */
  what: string
  /** Its line in the activity log. */
  activity: number
  progress: FileCopyProgress
  end?: FileCopyEnd
  /** Whether its dialog is open: one that isn't is told of in a toast as it ends. */
  watched: boolean
}

interface FileCopiesState {
  copies: Record<string, FileCopy>
  /** A copy the server (or the app) said has begun. */
  begin(copy: {
    id: string
    direction: FileCopy['direction']
    what: string
    context: string
    command: string
    total?: number
  }): void
  /** Its dialog closed: how it ends is said in a toast, and one that has ended is let go. */
  leave(id: string): void
}

/** "3 files, 1.2 MiB", and what was left out or is worth knowing. */
export function copied(end: FileCopyEnd): string {
  const left = leftOutText(end.leftOut)
  return [
    `${end.files} ${end.files === 1 ? 'file' : 'files'}, ${sized(end.bytes)}.`,
    left ? `Left out: ${left}.` : '',
    end.note ?? '',
  ]
    .filter(Boolean)
    .join(' ')
}

/** What's said of a copy that was stopped, by which way it went. */
export const stopped = (direction: FileCopy['direction']) =>
  direction === 'download'
    ? 'The copy was stopped. Nothing of it was kept.'
    : 'The copy was stopped. What was sent before that may be in the container.'

const verbs = {
  download: { done: 'Downloaded', failed: 'Couldn’t download', stopped: 'Stopped downloading' },
  upload: { done: 'Uploaded', failed: 'Couldn’t upload', stopped: 'Stopped uploading' },
}

export const useFileCopies = create<FileCopiesState>((set, get) => ({
  copies: {},
  begin({ id, direction, what, context, command, total }) {
    const activity = useActivity
      .getState()
      .start({ context, title: `${verbs[direction].done} ${what}`, command })
    const copy: FileCopy = {
      id,
      direction,
      what,
      activity,
      progress: { bytes: 0, files: 0, ...(total === undefined ? {} : { total }) },
      watched: true,
    }
    set((state) => ({ copies: { ...state.copies, [id]: copy } }))
  },
  leave(id) {
    const { [id]: left, ...copies } = get().copies
    if (left) set({ copies: left.end ? copies : { ...copies, [id]: { ...left, watched: false } } })
  },
}))

api.files.onProgress((id, progress) => {
  useFileCopies.setState((state) => {
    const copy = state.copies[id]
    return copy ? { copies: { ...state.copies, [id]: { ...copy, progress } } } : state
  })
})

api.files.onEnd((id, end) => {
  const copy = useFileCopies.getState().copies[id]
  if (!copy) return
  useActivity
    .getState()
    .finish(
      copy.activity,
      end.outcome === 'done' ? 'done' : 'failed',
      end.outcome === 'done' ? undefined : (end.error?.message ?? stopped(copy.direction)),
    )
  if (copy.watched) {
    useFileCopies.setState((state) => ({ copies: { ...state.copies, [id]: { ...copy, end } } }))
    return
  }
  // Nobody is looking at it any more: said where they are.
  useFileCopies.setState((state) => {
    const { [id]: _gone, ...copies } = state.copies
    return { copies }
  })
  const words = verbs[copy.direction]
  const { saved } = end
  if (end.outcome === 'done') {
    toast({
      tone: 'success',
      title: `${words.done} ${copy.what}`,
      description: copied(end),
      ...(saved && api.files.show
        ? { action: { label: 'Show in folder', run: () => api.files.show!(saved) } }
        : {}),
    })
  } else if (end.outcome === 'cancelled') {
    toast({
      tone: 'info',
      title: `${words.stopped} ${copy.what}`,
      description: stopped(copy.direction),
    })
  } else {
    toast({ tone: 'error', title: `${words.failed} ${copy.what}`, description: end.error!.message })
  }
})

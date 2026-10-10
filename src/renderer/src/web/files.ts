/**
 * Files copied out of and into containers, from a page a Lumovi server serves: a download is
 * the browser's own, from an address that works once, and what's uploaded is picked in the
 * browser and sent in one request. The page asks for both over its connection, which is where
 * it hears how they go.
 */
import { IPC, type LumoviApi } from '@shared/api'
import type {
  FileCopyBegun,
  FileCopyEnd,
  FileCopyProgress,
  FileCopyResult,
  PickedFiles,
} from '@shared/files'
import { LOST, type Connection } from './connection'
import { serverUrl } from './session'

interface Entry {
  names: string[]
  folder: boolean
  size: number
  file?: File
}

interface Picked {
  name: string
  entries: Entry[]
}

/** Asks the browser for a file, or a folder's files; nothing if none was picked. */
function choose(folder: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.hidden = true
    input.webkitdirectory = folder
    const chosen = () => {
      input.remove()
      resolve([...(input.files ?? [])])
    }
    input.addEventListener('change', chosen)
    input.addEventListener('cancel', chosen)
    document.body.append(input)
    input.click()
  })
}

/** What was picked, in the order it's sent: each folder before what's in it. */
function entriesOf(files: File[], folder: boolean): Picked {
  if (!folder) {
    const file = files[0]!
    return {
      name: file.name,
      entries: [{ names: [file.name], folder: false, size: file.size, file }],
    }
  }
  const entries: Entry[] = []
  const folders = new Set<string>()
  const sorted = files
    .map((file) => ({ file, names: file.webkitRelativePath.split('/') }))
    .sort((a, b) => a.file.webkitRelativePath.localeCompare(b.file.webkitRelativePath))
  for (const { file, names } of sorted) {
    for (let depth = 1; depth < names.length; depth += 1) {
      const within = names.slice(0, depth)
      if (folders.has(within.join('/'))) continue
      folders.add(within.join('/'))
      entries.push({ names: within, folder: true, size: 0 })
    }
    entries.push({ names, folder: false, size: file.size, file })
  }
  return { name: sorted[0]!.names[0]!, entries }
}

export function webFiles(connection: Connection): {
  api: LumoviApi['files']
  /** The connection dropped: what was being copied has stopped. */
  dropped(): void
} {
  const picked = new Map<string, Picked>()
  /** Copies under way, each with how its upload's request is stopped. */
  const copies = new Map<string, AbortController>()
  connection.on(IPC.filesEnd, (id) => {
    copies.get(id as string)?.abort()
    copies.delete(id as string)
  })
  const listen =
    <A extends unknown[]>(channel: string) =>
    (listener: (...args: A) => void) =>
      connection.on(channel, listener as (...args: unknown[]) => void)
  const begin = async (id: string, pending: Promise<unknown>) => {
    const result = (await pending) as FileCopyResult<FileCopyBegun>
    if (result.ok) copies.set(id, new AbortController())
    return result
  }
  return {
    api: {
      pick: async (what) => {
        const files = await choose(what === 'folder')
        if (files.length === 0) return { ok: true, data: null }
        const { name, entries } = entriesOf(files, what === 'folder')
        const handle = crypto.randomUUID()
        // The last pick is the one that's sent.
        picked.clear()
        picked.set(handle, { name, entries })
        const data: PickedFiles = {
          handle,
          name,
          folder: what === 'folder',
          files: files.length,
          bytes: files.reduce((sum, file) => sum + file.size, 0),
          leftOut: 0,
        }
        return { ok: true, data }
      },
      download: async (id, request) => {
        const result = await begin(id, connection.invoke(IPC.filesDownload, id, request))
        if (result.ok && result.data.url) {
          // The browser's own download: it saves it where its person has it save things.
          const link = document.createElement('a')
          link.href = serverUrl(result.data.url).href
          link.download = ''
          link.click()
        }
        return result
      },
      upload: async (id, { source, ...request }) => {
        const sent = picked.get(source)
        if (!sent) {
          return {
            ok: false,
            error: { code: 'invalid', message: 'Pick what to upload again.' },
          }
        }
        const result = await begin(
          id,
          connection.invoke(IPC.filesUpload, id, request, {
            name: sent.name,
            entries: sent.entries.map(({ names, folder, size }) => ({ names, folder, size })),
          }),
        )
        if (result.ok && result.data.url) {
          // The files, one after the other, as the server was told they'd come: read from the
          // disk as they're sent. How it went is heard on the connection.
          void fetch(serverUrl(result.data.url), {
            method: 'POST',
            body: new Blob(sent.entries.flatMap((entry) => (entry.file ? [entry.file] : []))),
            headers: { 'Content-Type': 'application/octet-stream' },
            signal: copies.get(id)!.signal,
          }).catch(() => undefined)
        }
        return result
      },
      cancel: (id) => connection.send(IPC.filesCancel, id),
      onProgress: listen<[string, FileCopyProgress]>(IPC.filesProgress),
      onEnd: listen<[string, FileCopyEnd]>(IPC.filesEnd),
    },
    dropped: () => {
      for (const id of copies.keys()) {
        connection.emit(IPC.filesEnd, id, {
          outcome: 'failed',
          error: { code: 'unreachable', message: LOST },
          bytes: 0,
          files: 0,
        } satisfies FileCopyEnd)
      }
    },
  }
}

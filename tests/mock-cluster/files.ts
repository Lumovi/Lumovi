/**
 * `tar` in the mock cluster's containers, as `kubectl cp` (and Lumovi) run it over exec:
 * `tar cf - -C <folder> -- ./<name>` writes an archive of a small tree of files, and
 * `tar xmf - -C <folder>` unpacks one into it. A test can have a path answer with an archive
 * of its own making (what a container that isn't to be trusted would send), stop halfway, or
 * drop the connection.
 */
import { extract, pack, type Header } from 'tar-stream'
import type { WebSocket } from 'ws'

const STDIN = 0
const STDOUT = 1
const STDERR = 2
const ERROR = 3
/** v5's frame that closes a stream: its channel follows. */
const CLOSE = 255

const frame = (channel: number, data: string | Buffer) =>
  Buffer.concat([Buffer.from([channel]), Buffer.from(data)])

const success = { metadata: {}, status: 'Success' }
const exited = (code: number) => ({
  metadata: {},
  status: 'Failure',
  reason: 'NonZeroExitCode',
  message: `command terminated with non-zero exit code: error executing command [tar], exit code ${code}`,
  details: { causes: [{ reason: 'ExitCode', message: String(code) }] },
})

/** One thing in a container: a file's contents, a folder, or a link's target. */
export type MockFile =
  | { type: 'file'; content: Buffer; mode?: number }
  | { type: 'directory' }
  | { type: 'symlink'; linkname: string }

/** One entry of an archive a test makes: any name, any type, whatever a tar header can say. */
export interface CraftedEntry extends Partial<Header> {
  name: string
  content?: string | Buffer
}

/** What a path answers `tar cf` with, in place of its files. */
export interface Crafted {
  entries?: CraftedEntry[]
  /** Sent as it is, in place of an archive. */
  raw?: Buffer
  /** What tar says on stderr, and how it ends. */
  stderr?: string
  exit?: number
  /** After what it sends: 'hold' never ends, 'drop' closes the connection without a word. */
  then?: 'hold' | 'drop'
  /** Stops short of the archive's end, as a tar that's killed does. */
  cut?: boolean
  /** How long it waits between the pieces it sends, in milliseconds: a slow disk, or a big file. */
  slowly?: number
  /**
   * How long nothing follows the first entry's header, in milliseconds: a file tar has found
   * and not yet read anything of.
   */
  stalls?: number
}

/**
 * How `tar xmf` in a folder is cut short: 'exit' is killed as it reads, 'drop' loses its
 * connection (its pod is gone), 'hold' never ends.
 */
export type Interrupted = 'exit' | 'drop' | 'hold'

/** What `tar xmf` unpacked. */
export interface Unpacked {
  namespace: string
  pod: string
  container: string
  /** The folder it was unpacked in: `-C`'s. */
  folder: string
  /** How much came on stdin: whole records, as tar reads them. */
  bytes: number
  entries: { name: string; type: Header['type']; size: number; mode: number; content: string }[]
}

const text = (content: string, mode?: number): MockFile => ({
  type: 'file',
  content: Buffer.from(content),
  ...(mode === undefined ? {} : { mode }),
})

/** What every container holds. */
function tree(): Map<string, MockFile> {
  return new Map<string, MockFile>([
    ['/', { type: 'directory' }],
    ['/tmp', { type: 'directory' }],
    ['/readonly', { type: 'directory' }],
    ['/var', { type: 'directory' }],
    ['/var/log', { type: 'directory' }],
    ['/var/log/app.log', text('started\nlistening on :8080\nready\n')],
    ['/var/log/empty.log', text('')],
    ['/etc', { type: 'directory' }],
    ['/etc/app', { type: 'directory' }],
    ['/etc/app/config.yaml', text('port: 8080\nlog: info\n')],
    ['/etc/app/run.sh', text('#!/bin/sh\nexec app\n', 0o4755)],
    ['/etc/app/current', { type: 'symlink', linkname: 'config.yaml' }],
    ['/etc/app/conf.d', { type: 'directory' }],
    ['/etc/app/conf.d/10-limits.conf', text('max = 10\n')],
    ['/etc/app/conf.d/CON', text('reserved on Windows\n')],
    // 3 MiB: more than waits at once anywhere between the container and the disk.
    ['/data', { type: 'directory' }],
    ['/data/heap.bin', { type: 'file', content: Buffer.alloc(3 * 1024 * 1024, 7) }],
    ['/data/-rf', text('a name like an option\n')],
  ])
}

/** A path's names, from the root: `.` and empty ones dropped. */
const names = (...paths: string[]) =>
  paths.flatMap((path) => path.split('/')).filter((part) => part !== '' && part !== '.')

const join = (folder: string, name: string) => `/${names(folder, name).join('/')}`

export function containerFiles() {
  let files = tree()
  const crafted = new Map<string, Crafted>()
  const unpacked: Unpacked[] = []
  const interrupted = new Map<string, Interrupted>()

  /** The archive of a path: the thing itself, then, for a folder, what's in it. */
  function archive(folder: string, name: string): CraftedEntry[] | undefined {
    const top = join(folder, name)
    if (!files.has(top)) return undefined
    const entries: CraftedEntry[] = []
    // By their paths' characters: a folder before what's in it.
    for (const [path, file] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (path !== top && !path.startsWith(top === '/' ? '/' : `${top}/`)) continue
      const entry = `./${names(name, path.slice(top.length)).join('/')}`
      if (file.type === 'file') {
        entries.push({
          name: entry,
          mode: file.mode ?? 0o644,
          uid: 1000,
          gid: 1000,
          content: file.content,
        })
      } else if (file.type === 'directory') {
        entries.push({ name: `${entry}/`, type: 'directory', mode: 0o755 })
      } else {
        entries.push({ name: entry, type: 'symlink', linkname: file.linkname })
      }
    }
    return entries
  }

  return {
    /** Has `path` answer `tar cf` as a test says. */
    craft: (path: string, answer: Crafted) => void crafted.set(path, answer),
    /** Adds or replaces something in every container. */
    put: (path: string, file: MockFile) => void files.set(path, file),
    /** Has `tar xmf` in `folder` cut short. */
    interrupt: (folder: string, how: Interrupted) => void interrupted.set(folder, how),
    unpacked: () => unpacked,
    reset() {
      files = tree()
      crafted.clear()
      unpacked.length = 0
      interrupted.clear()
    },

    /** Runs a tar command on an exec connection; false if it isn't one this understands. */
    run(
      ws: WebSocket,
      command: string[],
      where: { namespace: string; pod: string; container: string },
    ): boolean {
      const end = (status: object) => {
        ws.send(frame(ERROR, JSON.stringify(status)))
        ws.close()
      }
      const fail = (said: string, code: number) => {
        ws.send(frame(STDERR, said))
        end(exited(code))
      }
      const [, flags, , dashC, folder = '', ...rest] = command
      if (dashC !== '-C') return false

      if (flags === 'cf') {
        // After `--`, one operand, which no tar reads as an option.
        const name = rest[0] === '--' && rest.length === 2 ? rest[1]! : undefined
        if (name === undefined || !name.startsWith('./')) {
          fail(`tar: unrecognized option '${rest[0] ?? ''}'\n`, 64)
          return true
        }
        const path = join(folder, name)
        const answer = crafted.get(path)
        if (answer) {
          void send(ws, answer).then((status) => status && end(status))
          return true
        }
        const entries = archive(folder, name)
        if (!entries) {
          fail(
            `tar: ${name}: Cannot stat: No such file or directory\ntar: Exiting with failure status due to previous errors\n`,
            2,
          )
          return true
        }
        void send(ws, { entries }).then((status) => status && end(status))
        return true
      }

      if (flags === 'xmf' && rest.length === 0) {
        if (files.get(folder)?.type !== 'directory') {
          fail(`tar: can't change directory to '${folder}': No such file or directory\n`, 1)
          return true
        }
        const reading = extract()
        const got: Unpacked = { ...where, folder, bytes: 0, entries: [] }
        let refused = false
        reading.on('entry', (header, contents, next) => {
          const chunks: Buffer[] = []
          contents.on('data', (chunk) => chunks.push(chunk as Buffer))
          contents.on('error', () => undefined)
          contents.on('end', () => {
            if (folder === '/readonly' && !refused) {
              refused = true
              fail(`tar: can't open '${header.name}': Read-only file system\n`, 1)
            }
            const content = Buffer.concat(chunks)
            got.entries.push({
              name: header.name,
              type: header.type,
              size: header.size,
              mode: header.mode,
              // Enough to tell what arrived, without keeping megabytes.
              content: content.subarray(0, 64).toString('utf8'),
            })
            if (header.type === 'file') {
              files.set(join(folder, header.name), { type: 'file', content, mode: header.mode })
            } else if (header.type === 'directory') {
              files.set(join(folder, header.name), { type: 'directory' })
            }
            next()
          })
          contents.resume()
        })
        reading.on('finish', () => {
          unpacked.push(got)
          if (!refused) end(success)
        })
        reading.on('error', () => {
          if (!refused) fail('tar: short read\n', 1)
        })
        const how = interrupted.get(folder)
        ws.on('message', (data: Buffer) => {
          if (how === 'drop') return ws.terminate()
          if (how === 'exit') {
            if (!refused) fail('Killed\n', 137)
            refused = true
            return
          }
          if (how === 'hold' && data[0] === CLOSE) return
          if (data[0] === STDIN) {
            got.bytes += data.length - 1
            reading.write(data.subarray(1))
          }
          // No more: tar has read the archive's end by now, in a whole record or not at all.
          if (data[0] === CLOSE && data[1] === STDIN) {
            if (got.bytes % 10240 === 0) reading.end(undefined)
            else reading.destroy(new Error('not whole records'))
          }
        })
        return true
      }
      return false
    },
  }
}

/** What a test has a path answer: its entries packed as they are, or its bytes. */
async function send(ws: WebSocket, answer: Crafted): Promise<object | undefined> {
  if (answer.raw) ws.send(frame(STDOUT, answer.raw))
  if (answer.entries) {
    const packed = pack()
    const chunks: Buffer[] = []
    packed.on('data', (chunk) => chunks.push(chunk as Buffer))
    const done = new Promise<void>((resolve) => packed.on('end', resolve))
    for (const { content, ...header } of answer.entries) {
      await new Promise<void>((resolve) => {
        if (content === undefined) packed.entry(header, () => resolve())
        else packed.entry(header, content, () => resolve())
      })
    }
    packed.finalize()
    await done
    const whole = Buffer.concat(chunks)
    // Held or dropped, it stops short: of the archive's end, and of its last file's.
    const bytes = answer.then || answer.cut ? whole.subarray(0, whole.length - 1024 - 512) : whole
    // In pieces, as a container's tar writes it.
    let from = 0
    if (answer.stalls) {
      ws.send(frame(STDOUT, bytes.subarray(0, 512)))
      await new Promise((resolve) => setTimeout(resolve, answer.stalls))
      from = 512
    }
    for (let at = from; at < bytes.length; at += 32 * 1024) {
      if (at > from && answer.slowly)
        await new Promise((resolve) => setTimeout(resolve, answer.slowly))
      if (ws.readyState !== ws.OPEN) return undefined
      ws.send(frame(STDOUT, bytes.subarray(at, at + 32 * 1024)))
    }
  }
  if (answer.stderr) ws.send(frame(STDERR, answer.stderr))
  if (answer.then === 'hold') return undefined
  if (answer.then === 'drop') {
    ws.terminate()
    return undefined
  }
  return answer.exit ? exited(answer.exit) : success
}

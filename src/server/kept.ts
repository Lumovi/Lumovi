/**
 * Where a server keeps what people set on its pages (their AI rules, who
 * may do what), and what it keeps so a restart signs nobody out: in a
 * ConfigMap (or, for that, a Secret) of the namespace Lumovi runs in (the
 * chart makes it, and lets Lumovi read and write it, and nothing else), in a
 * file under LUMOVI_DATA_DIR, or, with neither, in memory until the server
 * stops.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { KubeConfig } from '@kubernetes/client-node'
import { kubeRequest } from '@backend/kube/client'
import { KubeRequestError, toKubeError } from '@backend/kube/errors'
import { inCluster } from './cluster'
import { ConfigError } from './config'
import { log } from './log'

/** Where it's kept: a ConfigMap or Secret of the namespace Lumovi runs in, a file, or only in memory. */
export type Keeping =
  | { kind: 'configmap'; name: string }
  | { kind: 'secret'; name: string }
  | { kind: 'file'; path: string }
  | { kind: 'memory' }

/** Where what people set is kept: not a Secret (that's for what a restart mustn't lose). */
export type SettingsKeeping = Exclude<Keeping, { kind: 'secret' }>

/** What's kept, and how it reads and writes. */
export interface Kept<T> {
  /** What it holds, in what's said: "people’s AI rules". */
  what: string
  /** Its key in a ConfigMap, and the file's name under LUMOVI_DATA_DIR. */
  key: string
  /** With nothing kept yet. */
  empty: T
  /** As JSON. */
  write(value: T): string
  /** From JSON, checked: what doesn't make sense is a ConfigError saying where. */
  read(text: string, where: string): T
}

export interface Keeper<T, K extends Keeping['kind'] = Keeping['kind']> {
  kept: K
  read(): Promise<T>
  /** Refused (a conflict) when someone else wrote it since it was last read or written here. */
  write(value: T): Promise<void>
  /** Which version was last read or written here: it changes whenever what's kept does. */
  version(): string
}

/** How long a lock left by a writer that stopped mid-write holds the others back. */
const STALE_LOCK_MS = 30_000

/** A ConfigMap holds a megabyte, at most. */
export const MAX_KEPT_BYTES = 1_000_000

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16)

/** `quiet`: nothing's said of keeping it in memory (there's nothing to keep). */
export function keeper<T, K extends Keeping>(
  keeping: K,
  kept: Kept<T>,
  env: NodeJS.ProcessEnv,
  { quiet = false } = {},
): Keeper<T, K['kind']> {
  return (
    keeping.kind === 'configmap' || keeping.kind === 'secret'
      ? objectKeeper(keeping.kind, keeping.name, kept, env)
      : keeping.kind === 'file'
        ? fileKeeper(keeping.path, kept)
        : memoryKeeper(kept, quiet)
  ) as Keeper<T, K['kind']>
}

function memoryKeeper<T>(kept: Kept<T>, quiet: boolean): Keeper<T> {
  if (!quiet)
    log(
      `${kept.what[0]!.toUpperCase()}${kept.what.slice(1)} are kept in memory: they’re lost when Lumovi stops. Set LUMOVI_DATA_DIR, or install the Helm chart, to keep them.`,
    )
  let writes = 0
  return {
    kept: 'memory',
    read: async () => kept.empty,
    write: async () => void writes++,
    version: () => String(writes),
  }
}

function fileKeeper<T>(path: string, kept: Kept<T>): Keeper<T> {
  let version = ''
  return {
    kept: 'file',
    read: async () => {
      let text: string
      try {
        text = await readFile(path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return kept.empty
        throw new ConfigError(`Lumovi can’t read ${path}: ${(error as Error).message}`)
      }
      version = hash(text)
      return kept.read(text, path)
    },
    write: async (value) => {
      mkdirSync(dirname(path), { recursive: true })
      // One writer at a time, whichever replica: the lock is made, or another's writing (unless
      // one stopped mid-write long ago).
      // The lock says when it was taken. Made only if it isn't there, it's one writer's alone.
      const lock = `${path}.lock`
      const take = () => writeFileSync(lock, String(Date.now()), { flag: 'wx', mode: 0o600 })
      try {
        take()
      } catch {
        if (Date.now() - Number(readFileSync(lock, 'utf8')) < STALE_LOCK_MS) {
          throw new KubeRequestError('conflict', `Another of Lumovi’s replicas is writing ${path}.`)
        }
        // Moved aside by one taker alone (a rename is): the others' saves fail, as they should.
        const stale = `${lock}.${process.pid}`
        renameSync(lock, stale)
        rmSync(stale)
        take()
      }
      try {
        // Another replica (or someone, by hand) wrote it since: theirs isn't written over.
        let now = ''
        try {
          now = hash(readFileSync(path, 'utf8'))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        if (now !== version) {
          throw new KubeRequestError('conflict', `${path} changed since Lumovi last read it.`)
        }
        const text = kept.write(value)
        // Whole, or not at all: a server stopping mid-write leaves what was there.
        const next = `${path}.${process.pid}`
        writeFileSync(next, text, { mode: 0o600 })
        renameSync(next, path)
        version = hash(text)
      } finally {
        rmSync(lock, { force: true })
      }
    },
    version: () => version,
  }
}

/** A ConfigMap's or a Secret's: a Secret's data is base64, a ConfigMap's as it is. */
function objectKeeper<T>(
  kind: 'configmap' | 'secret',
  name: string,
  kept: Kept<T>,
  env: NodeJS.ProcessEnv,
): Keeper<T> {
  const found = inCluster(env)
  const kc = new KubeConfig()
  kc.loadFromOptions({
    clusters: [found.cluster],
    users: [found.account],
    contexts: [{ name: 'in-cluster', cluster: found.cluster.name, user: found.account.name }],
    currentContext: 'in-cluster',
  })
  const namespace = readFileSync(join(found.source, 'namespace'), 'utf8').trim()
  const path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/${kind}s/${encodeURIComponent(name)}`
  const where = `${kind === 'secret' ? 'Secret' : 'ConfigMap'} ${namespace}/${name}`
  const secret = kind === 'secret'
  const encode = (text: string) => (secret ? Buffer.from(text).toString('base64') : text)
  const decode = (text: string) => (secret ? Buffer.from(text, 'base64').toString('utf8') : text)
  /** The version last read or written: a write over another's is refused (a conflict). */
  let version = ''
  return {
    kept: kind,
    read: async () => {
      let object: { metadata: { resourceVersion: string }; data?: Record<string, string> }
      try {
        object = JSON.parse(await kubeRequest(kc, path, { timeoutMs: 20_000 }))
      } catch (error) {
        throw new ConfigError(
          `Lumovi can’t read ${where}, where it keeps ${kept.what}: ${toKubeError(error).message}`,
        )
      }
      version = object.metadata.resourceVersion
      const text = object.data?.[kept.key]
      return text === undefined ? kept.empty : kept.read(decode(text), where)
    },
    // Its data alone, as of the version read: what the chart set on it (the annotation that keeps
    // it when Lumovi is uninstalled, its labels) stays, and someone else's write is refused.
    write: async (value) => {
      const saved = JSON.parse(
        await kubeRequest(kc, path, {
          method: 'PATCH',
          contentType: 'application/merge-patch+json',
          timeoutMs: 20_000,
          body: {
            metadata: { resourceVersion: version },
            data: { [kept.key]: encode(kept.write(value)) },
          },
        }),
      ) as { metadata: { resourceVersion: string } }
      version = saved.metadata.resourceVersion
    },
    version: () => version,
  }
}

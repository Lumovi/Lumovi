/**
 * Where a server keeps what people set on its pages (their AI rules, who
 * may do what): in a ConfigMap of the namespace Lumovi runs in (the chart
 * makes it, and lets Lumovi read and write it, and nothing else), in a file
 * under LUMOVI_DATA_DIR, or, with neither, in memory until the server stops.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { KubeConfig } from '@kubernetes/client-node'
import { kubeRequest } from '@backend/kube/client'
import { KubeRequestError, toKubeError } from '@backend/kube/errors'
import { inCluster } from './cluster'
import { ConfigError } from './config'
import { log } from './log'

/** Where it's kept: a ConfigMap of the namespace Lumovi runs in, a file, or only in memory. */
export type Keeping =
  { kind: 'configmap'; name: string } | { kind: 'file'; path: string } | { kind: 'memory' }

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

export interface Keeper<T> {
  kept: Keeping['kind']
  read(): Promise<T>
  /** Refused (a conflict) when someone else wrote it since it was last read or written here. */
  write(value: T): Promise<void>
  /** Which version was last read or written here: it changes whenever what's kept does. */
  version(): string
}

/** A ConfigMap holds a megabyte, at most. */
export const MAX_KEPT_BYTES = 1_000_000

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16)

/** `quiet`: nothing's said of keeping it in memory (there's nothing to keep). */
export function keeper<T>(
  keeping: Keeping,
  kept: Kept<T>,
  env: NodeJS.ProcessEnv,
  { quiet = false } = {},
): Keeper<T> {
  return keeping.kind === 'configmap'
    ? configMapKeeper(keeping.name, kept, env)
    : keeping.kind === 'file'
      ? fileKeeper(keeping.path, kept)
      : memoryKeeper(kept, quiet)
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
      mkdirSync(dirname(path), { recursive: true })
      const next = `${path}.${process.pid}`
      writeFileSync(next, text, { mode: 0o600 })
      renameSync(next, path)
      version = hash(text)
    },
    version: () => version,
  }
}

function configMapKeeper<T>(name: string, kept: Kept<T>, env: NodeJS.ProcessEnv): Keeper<T> {
  const found = inCluster(env)
  const kc = new KubeConfig()
  kc.loadFromOptions({
    clusters: [found.cluster],
    users: [found.account],
    contexts: [{ name: 'in-cluster', cluster: found.cluster.name, user: found.account.name }],
    currentContext: 'in-cluster',
  })
  const namespace = readFileSync(join(found.source, 'namespace'), 'utf8').trim()
  const path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/configmaps/${encodeURIComponent(name)}`
  const where = `ConfigMap ${namespace}/${name}`
  /** The version last read or written: a write over another's is refused (a conflict). */
  let version = ''
  return {
    kept: 'configmap',
    read: async () => {
      let configMap: { metadata: { resourceVersion: string }; data?: Record<string, string> }
      try {
        configMap = JSON.parse(await kubeRequest(kc, path, { timeoutMs: 20_000 }))
      } catch (error) {
        throw new ConfigError(
          `Lumovi can’t read ${where}, where it keeps ${kept.what}: ${toKubeError(error).message}`,
        )
      }
      version = configMap.metadata.resourceVersion
      const text = configMap.data?.[kept.key]
      return text === undefined ? kept.empty : kept.read(text, where)
    },
    write: async (value) => {
      const saved = JSON.parse(
        await kubeRequest(kc, path, {
          method: 'PUT',
          timeoutMs: 20_000,
          body: {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: { name, namespace, resourceVersion: version },
            data: { [kept.key]: kept.write(value) },
          },
        }),
      ) as { metadata: { resourceVersion: string } }
      version = saved.metadata.resourceVersion
    },
    version: () => version,
  }
}

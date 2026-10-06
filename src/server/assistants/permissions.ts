/**
 * What each person on a server lets their AI assistants do: kept in a
 * ConfigMap of the namespace Lumovi runs in (the chart makes it, and lets
 * Lumovi read and write it, and nothing else), in a file
 * (LUMOVI_DATA_DIR), or, with neither, in memory until the server stops.
 * One person's are theirs alone, whatever browser they use.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { KubeConfig } from '@kubernetes/client-node'
import {
  checkedPermissions,
  NO_PERMISSIONS,
  type AiPermissions,
  type AiPermissionsKept,
} from '@shared/ai-permissions'
import { kubeRequest } from '@backend/kube/client'
import { toKubeError } from '@backend/kube/errors'
import { inCluster } from '../cluster'
import { ConfigError, type RulesKeeping } from '../config'
import { log } from '../log'

type People = Record<string, AiPermissions>

/** The key the ConfigMap keeps everyone's under, as JSON. */
const KEY = 'rules.json'
/** A ConfigMap holds a megabyte, at most. */
const MAX_BYTES = 1_000_000

/** What's kept: everyone's, by who they are. */
const documentOf = (people: People) => JSON.stringify({ version: 1, people })

/** What was kept, checked: anything that doesn't make sense stops the server, rather than loosen someone's. */
function peopleOf(text: string, where: string): People {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ConfigError(`${where} isn’t JSON: Lumovi can’t read the AI rules it kept there.`)
  }
  const people = (parsed as { people?: unknown }).people
  if (typeof people !== 'object' || people === null || Array.isArray(people)) {
    throw new ConfigError(`${where} doesn’t hold the AI rules Lumovi keeps (no people).`)
  }
  return Object.fromEntries(
    Object.entries(people).map(([person, given]) => {
      try {
        return [person, checkedPermissions(given)]
      } catch (error) {
        throw new ConfigError(`${where}: ${person}’s AI rules: ${(error as Error).message}`)
      }
    }),
  )
}

/** Where they're written, and read again (a write that conflicted). */
interface Keeper {
  kept: AiPermissionsKept
  read(): Promise<People>
  write(people: People): Promise<void>
}

export class PermissionsStore {
  #people: People = {}

  private constructor(private readonly keeper: Keeper) {}

  /** Opens where they're kept, and reads what's there: it can't be read, the server doesn't start. */
  static async open(keep: RulesKeeping, env: NodeJS.ProcessEnv): Promise<PermissionsStore> {
    const keeper =
      keep.kind === 'configmap'
        ? configMapKeeper(keep.name, env)
        : keep.kind === 'file'
          ? fileKeeper(keep.path)
          : memoryKeeper()
    const store = new PermissionsStore(keeper)
    store.#people = await keeper.read()
    return store
  }

  get kept(): AiPermissionsKept {
    return this.keeper.kept
  }

  /** `person`'s own: the defaults, until they say otherwise. */
  get(person: string): AiPermissions {
    return this.#people[person] ?? NO_PERMISSIONS
  }

  /** Keeps `person`'s, once they're checked; what couldn't be kept isn't used either. */
  async set(person: string, given: unknown): Promise<AiPermissions> {
    const permissions = checkedPermissions(given)
    const people = { ...this.#people, [person]: permissions }
    if (Buffer.byteLength(documentOf(people)) > MAX_BYTES) {
      throw new Error('Lumovi can’t keep more AI rules: everyone’s together would be over 1 MB.')
    }
    try {
      try {
        await this.keeper.write(people)
        this.#people = people
      } catch (error) {
        // Someone else wrote first (an administrator, by hand): theirs, with this person's.
        if (toKubeError(error).code !== 'conflict') throw error
        const latest = { ...(await this.keeper.read()), [person]: permissions }
        await this.keeper.write(latest)
        this.#people = latest
      }
    } catch (error) {
      throw new Error(`Lumovi couldn’t keep your AI rules: ${toKubeError(error).message}`, {
        cause: error,
      })
    }
    return permissions
  }
}

function memoryKeeper(): Keeper {
  log(
    'AI rules are kept in memory: people’s are lost when Lumovi stops. Set LUMOVI_DATA_DIR, or install the Helm chart, to keep them.',
  )
  return { kept: 'memory', read: async () => ({}), write: async () => undefined }
}

function fileKeeper(path: string): Keeper {
  return {
    kept: 'file',
    read: async () => {
      let text: string
      try {
        text = await readFile(path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
        throw new ConfigError(`Lumovi can’t read ${path}: ${(error as Error).message}`)
      }
      return peopleOf(text, path)
    },
    write: async (people) => {
      // Whole, or not at all: a server stopping mid-write leaves what was there.
      mkdirSync(dirname(path), { recursive: true })
      const next = `${path}.${process.pid}`
      writeFileSync(next, documentOf(people), { mode: 0o600 })
      renameSync(next, path)
    },
  }
}

function configMapKeeper(name: string, env: NodeJS.ProcessEnv): Keeper {
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
  let version: string | undefined
  return {
    kept: 'configmap',
    read: async () => {
      let configMap: { metadata: { resourceVersion: string }; data?: Record<string, string> }
      try {
        configMap = JSON.parse(await kubeRequest(kc, path, { timeoutMs: 20_000 }))
      } catch (error) {
        throw new ConfigError(
          `Lumovi can’t read ${where}, where it keeps people’s AI rules: ${toKubeError(error).message}`,
        )
      }
      version = configMap.metadata.resourceVersion
      const text = configMap.data?.[KEY]
      return text === undefined ? {} : peopleOf(text, where)
    },
    write: async (people) => {
      const saved = JSON.parse(
        await kubeRequest(kc, path, {
          method: 'PUT',
          timeoutMs: 20_000,
          body: {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: { name, namespace, resourceVersion: version },
            data: { [KEY]: documentOf(people) },
          },
        }),
      ) as { metadata: { resourceVersion: string } }
      version = saved.metadata.resourceVersion
    },
  }
}

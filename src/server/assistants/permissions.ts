/**
 * What each person on a server lets their AI assistants do: kept in a
 * ConfigMap of the namespace Lumovi runs in (the chart makes it, and lets
 * Lumovi read and write it, and nothing else), in a file
 * (LUMOVI_DATA_DIR), or, with neither, in memory until the server stops.
 * One person's are theirs alone, whatever browser they use.
 */
import {
  checkedPermissions,
  NO_PERMISSIONS,
  type AiPermissions,
  type AiPermissionsKept,
} from '@shared/ai-permissions'
import { toKubeError } from '@backend/kube/errors'
import { ConfigError } from '../config'
import { keeper, MAX_KEPT_BYTES, type Keeper, type Keeping } from '../kept'

type People = Record<string, AiPermissions>

/** The key the ConfigMap keeps everyone's under, as JSON. */
const KEY = 'rules.json'
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

export class PermissionsStore {
  #people: People = {}

  private constructor(private readonly keeper: Keeper<People>) {}

  /** Opens where they're kept, and reads what's there: it can't be read, the server doesn't start. */
  static async open(keep: Keeping, env: NodeJS.ProcessEnv): Promise<PermissionsStore> {
    const store = new PermissionsStore(
      keeper(
        keep,
        { what: 'people’s AI rules', key: KEY, empty: {}, write: documentOf, read: peopleOf },
        env,
      ),
    )
    store.#people = await store.keeper.read()
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
    if (Buffer.byteLength(documentOf(people)) > MAX_KEPT_BYTES) {
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

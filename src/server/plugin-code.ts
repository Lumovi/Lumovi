/**
 * Whose plugins' code runs for each person on a server: what they turned off, or on again, on the
 * Plugins page. Kept where people's AI rules are (a ConfigMap of the namespace Lumovi runs in, a
 * file under LUMOVI_DATA_DIR, or, with neither, memory until the server stops), under its own key.
 * One person's choices are theirs alone, whatever browser they use.
 */
import { dirname, join } from 'node:path'
import { PLUGIN_NAME } from '@shared/plugins'
import { toKubeError } from '@backend/kube/errors'
import { ConfigError } from './config'
import { keeper, MAX_KEPT_BYTES, type Keeper, type SettingsKeeping } from './kept'

/** Each person's choices, by plugin: on, or off. */
type People = Record<string, Record<string, boolean>>

/** The key it's kept under, beside the AI rules' own. */
const KEY = 'plugin-code.json'
const documentOf = (people: People) => JSON.stringify({ version: 1, people })

/** What was kept, checked: anything that doesn't make sense stops the server, rather than turn someone's code back on. */
function peopleOf(text: string, where: string): People {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ConfigError(
      `${where} isn’t JSON: Lumovi can’t read whose plugins’ code it kept there.`,
    )
  }
  const people = (parsed as { people?: unknown }).people
  const record = (value: unknown) =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
  if (!record(people)) {
    throw new ConfigError(`${where} doesn’t hold whose plugins’ code runs (no people).`)
  }
  return Object.fromEntries(
    Object.entries(people as Record<string, unknown>).map(([person, chosen]) => {
      if (
        !record(chosen) ||
        !Object.entries(chosen as Record<string, unknown>).every(
          ([plugin, on]) => PLUGIN_NAME.test(plugin) && typeof on === 'boolean',
        )
      ) {
        throw new ConfigError(
          `${where}: ${person}’s plugins’ code isn’t plugins’ names, each on or off.`,
        )
      }
      return [person, { ...(chosen as Record<string, boolean>) }]
    }),
  )
}

export class PluginCodeStore {
  #people: People = {}

  private constructor(private readonly keeper: Keeper<People, SettingsKeeping['kind']>) {}

  /**
   * Opens where it's kept, and reads what's there: it can't be read, the server doesn't start.
   * `keep`: where the AI rules are. In their ConfigMap, under its own key; under LUMOVI_DATA_DIR,
   * in a file of its own beside theirs.
   */
  static async open(keep: SettingsKeeping, env: NodeJS.ProcessEnv): Promise<PluginCodeStore> {
    const own: SettingsKeeping =
      keep.kind === 'file' ? { kind: 'file', path: join(dirname(keep.path), KEY) } : keep
    const store = new PluginCodeStore(
      keeper(
        own,
        {
          what: 'whose plugins’ code runs',
          key: KEY,
          empty: {},
          write: documentOf,
          read: peopleOf,
        },
        env,
      ),
    )
    store.#people = await store.keeper.read()
    return store
  }

  /** `person`'s own choices: none, until they make one. */
  get(person: string): Readonly<Record<string, boolean>> {
    return this.#people[person] ?? {}
  }

  /** Keeps `person`'s choice for `plugin`; what couldn't be kept isn't used either. */
  async set(
    person: string,
    plugin: string,
    on: boolean,
  ): Promise<Readonly<Record<string, boolean>>> {
    const chosen = { ...this.get(person), [plugin]: on }
    const people = { ...this.#people, [person]: chosen }
    if (Buffer.byteLength(documentOf(people)) > MAX_KEPT_BYTES) {
      throw new Error(
        'Lumovi can’t keep more choices of plugins’ code: everyone’s together would be over 1 MB.',
      )
    }
    try {
      try {
        await this.keeper.write(people)
        this.#people = people
      } catch (error) {
        // Someone else wrote first (an administrator, by hand): theirs, with this person's.
        if (toKubeError(error).code !== 'conflict') throw error
        const latest = await this.keeper.read()
        const merged = { ...latest, [person]: { ...(latest[person] ?? {}), [plugin]: on } }
        await this.keeper.write(merged)
        this.#people = merged
      }
    } catch (error) {
      throw new Error(`Lumovi couldn’t keep your choice: ${toKubeError(error).message}`, {
        cause: error,
      })
    }
    return this.get(person)
  }
}

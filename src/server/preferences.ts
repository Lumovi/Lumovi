/**
 * Each person's own settings on a server (LMV-357): how Lumovi looks to them, how it says times,
 * their terminals' font, which namespace a cluster opens in, and their theme. Kept in the
 * server's state (state.ts), sealed, under their user name, so every device they sign in from
 * shows the same; never let go to make room. What whoever runs the server sets in
 * LUMOVI_SETTINGS (the chart's `settings:`) is what they are for everyone, and locked.
 */
import type { SessionUser } from '@shared/server'
import type { Settings, ThemePreference } from '@shared/api'
import {
  checkedPreferences,
  effectivePreferences,
  isDefault,
  type PreferenceKey,
  type Preferences,
} from '@shared/preferences'
import { isTheme } from '@backend/settings'
import { ConfigError } from './config'
import type { ServerState } from './state'

/** What's kept of a person: their settings, and their theme. */
interface Entry {
  preferences: Partial<Preferences>
  theme?: ThemePreference
}

/** What the server sets for everyone, and locks. */
export type LockedSettings = Partial<Preferences> & { theme?: ThemePreference }

/** LUMOVI_SETTINGS, checked: JSON, each a setting a page has (the desktop's shell isn't one). */
export function lockedSettings(text: string | undefined): LockedSettings | undefined {
  if (!text) return undefined
  let given: unknown
  try {
    given = JSON.parse(text)
  } catch {
    throw new ConfigError('LUMOVI_SETTINGS must be JSON: {"theme": "dark", "clock": "24"}.')
  }
  const { preferences, problems } = checkedPreferences(given)
  const theme = (given as { theme?: unknown }).theme
  if (theme !== undefined && !isTheme(theme)) problems.push('theme must be system, light or dark.')
  if ('shell' in preferences)
    problems.push('shell is the desktop app’s: a server starts no shells of its own.')
  if (Object.values(preferences).includes(null)) problems.push('A setting can’t be null.')
  if (problems.length) throw new ConfigError(`LUMOVI_SETTINGS: ${problems.join(' ')}`)
  return { ...(preferences as Partial<Preferences>), ...(isTheme(theme) ? { theme } : {}) }
}

/** Everyone's settings, each person's theirs alone. */
export class PeoplePreferences {
  constructor(
    private readonly state: ServerState,
    private readonly locked: LockedSettings = {},
  ) {}

  /** One person's, as the page is given them (in `Settings`). */
  of(user: SessionUser) {
    const key = user.name
    const entry = () => this.state.get<Entry>('preferences', key) ?? { preferences: {} }
    const { theme: lockedTheme, ...lockedOwn } = this.locked
    const lockedKeys = Object.keys(this.locked) as PreferenceKey[]
    return {
      /** What Settings says of them. */
      settings: (): Pick<Settings, 'preferences' | 'locked'> & { theme?: ThemePreference } => {
        const kept = entry()
        return {
          preferences: effectivePreferences(kept.preferences, lockedOwn),
          ...(lockedTheme ? { theme: lockedTheme } : kept.theme ? { theme: kept.theme } : {}),
          ...(lockedKeys.length ? { locked: lockedKeys } : {}),
        }
      },
      /** Changes them, checked; null puts one back. Refused (nothing changed) where it can't be. */
      set: async (patch: unknown): Promise<void> => {
        const { preferences, problems } = checkedPreferences(patch)
        const theme = (patch as { theme?: unknown } | null)?.theme
        if (theme !== undefined && theme !== null && !isTheme(theme)) {
          problems.push('theme must be system, light or dark.')
        }
        if ('shell' in preferences) problems.push('shell is the desktop app’s.')
        const refused = [
          ...Object.keys(preferences),
          ...(theme !== undefined ? ['theme'] : []),
        ].filter((name) => Object.hasOwn(this.locked, name))
        if (refused.length) problems.push(`${refused.join(', ')}: set by whoever runs this server.`)
        if (problems.length) throw new Error(problems.join(' '))
        const kept = entry()
        const own: Record<string, unknown> = { ...kept.preferences }
        // (One set to its default is kept as unset: it follows the default.)
        for (const [name, value] of Object.entries(preferences)) {
          if (value === null || isDefault(name, value)) delete own[name]
          else own[name] = value
        }
        const next: Entry = {
          preferences: own as Partial<Preferences>,
          ...(theme === undefined
            ? kept.theme
              ? { theme: kept.theme }
              : {}
            : isTheme(theme)
              ? { theme }
              : {}),
        }
        this.state.set('preferences', key, next)
        await this.state.flush()
      },
    }
  }
}

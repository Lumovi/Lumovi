import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Settings, ThemePreference } from '@shared/api'

const THEMES: readonly ThemePreference[] = ['system', 'light', 'dark']
const DEFAULTS: Settings = { theme: 'system', readOnly: [] }

export function isTheme(value: unknown): value is ThemePreference {
  return THEMES.includes(value as ThemePreference)
}

/** Persists user preferences as JSON in the app's userData directory. */
export class SettingsStore {
  readonly #file: string
  #settings: Settings
  /** KUBESTACKS_READ_ONLY makes every context read-only, whatever was stored. */
  readonly #readOnlyAll: boolean

  constructor(
    private readonly dir: string,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.#file = join(dir, 'settings.json')
    this.#settings = this.#read()
    this.#readOnlyAll = ['1', 'true'].includes(env.KUBESTACKS_READ_ONLY ?? '')
  }

  get(): Settings {
    return { ...this.#settings, ...(this.#readOnlyAll ? { readOnlyAll: true } : {}) }
  }

  isReadOnly(context: string): boolean {
    return this.#readOnlyAll || this.#settings.readOnly!.includes(context)
  }

  setReadOnly(context: string, readOnly: boolean): Settings {
    const others = this.#settings.readOnly!.filter((name) => name !== context)
    return this.update({ readOnly: readOnly ? [...others, context] : others })
  }

  update(patch: Partial<Omit<Settings, 'readOnlyAll'>>): Settings {
    this.#settings = { ...this.#settings, ...patch }
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.#file, JSON.stringify(this.#settings, null, 2))
    return this.get()
  }

  #read(): Settings {
    try {
      const stored = JSON.parse(readFileSync(this.#file, 'utf8')) as Partial<Settings>
      return {
        theme: isTheme(stored.theme) ? stored.theme : DEFAULTS.theme,
        // Validated against the connected displays when the window opens.
        window: stored.window,
        readOnly: Array.isArray(stored.readOnly)
          ? stored.readOnly.filter((name) => typeof name === 'string')
          : [],
      }
    } catch {
      // First run, or the file is unreadable: start from defaults.
      return { ...DEFAULTS }
    }
  }
}

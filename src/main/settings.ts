import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Settings, ThemePreference } from '@shared/api'

const THEMES: readonly ThemePreference[] = ['system', 'light', 'dark']
const DEFAULTS: Settings = { theme: 'system' }

export function isTheme(value: unknown): value is ThemePreference {
  return THEMES.includes(value as ThemePreference)
}

/** Persists user preferences as JSON in the app's userData directory. */
export class SettingsStore {
  readonly #file: string
  #settings: Settings

  constructor(private readonly dir: string) {
    this.#file = join(dir, 'settings.json')
    this.#settings = this.#read()
  }

  get(): Settings {
    return { ...this.#settings }
  }

  update(patch: Partial<Settings>): Settings {
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
      }
    } catch {
      // First run, or the file is unreadable: start from defaults.
      return { ...DEFAULTS }
    }
  }
}

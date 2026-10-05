import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  NODE_SHELL_DEFAULTS,
  type MetricsSourceSetting,
  type NodeShellSetting,
  type Settings,
} from '@shared/api'
import { DEFAULT_ASSISTANTS_PORT, isAiChanges, isPort, type AiChanges } from '@shared/assistants'
import {
  isMetricsSourceSetting,
  isNodeShellSetting,
  isTheme,
  type SettingsAccess,
} from '@backend/settings'

const DEFAULTS: Settings = {
  theme: 'system',
  readOnly: [],
  metricsSource: {},
  nodeShell: {},
  autoUpdate: true,
  assistants: { enabled: false, port: DEFAULT_ASSISTANTS_PORT },
  aiChanges: {},
}

/** What a token looks like (a random one, URL-safe). */
const TOKEN = /^[\w-]{32,}$/

/** Persists user preferences as JSON in the app's userData directory. */
export class SettingsStore implements SettingsAccess {
  readonly #file: string
  #settings: Settings
  /** LUMOVI_READ_ONLY makes every context read-only, whatever was stored. */
  readonly #readOnlyAll: boolean

  constructor(
    private readonly dir: string,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.#file = join(dir, 'settings.json')
    this.#settings = this.#read()
    this.#readOnlyAll = ['1', 'true'].includes(env.LUMOVI_READ_ONLY ?? '')
  }

  get(): Settings {
    return {
      ...this.#settings,
      nodeShellDefault: NODE_SHELL_DEFAULTS,
      ...(this.#readOnlyAll ? { readOnlyAll: true } : {}),
    }
  }

  isReadOnly(context: string): boolean {
    return this.#readOnlyAll || this.#settings.readOnly!.includes(context)
  }

  setReadOnly(context: string, readOnly: boolean): Settings {
    const others = this.#settings.readOnly!.filter((name) => name !== context)
    return this.update({ readOnly: readOnly ? [...others, context] : others })
  }

  metricsSource(context: string): MetricsSourceSetting {
    return this.#settings.metricsSource![context] ?? { mode: 'auto' }
  }

  setMetricsSource(context: string, setting: MetricsSourceSetting): Settings {
    const { [context]: _previous, ...others } = this.#settings.metricsSource!
    return this.update({
      metricsSource: setting.mode === 'auto' ? others : { ...others, [context]: setting },
    })
  }

  nodeShell(context: string): NodeShellSetting {
    return this.#settings.nodeShell![context] ?? NODE_SHELL_DEFAULTS
  }

  setNodeShell(context: string, setting: NodeShellSetting | null): Settings {
    const { [context]: _previous, ...others } = this.#settings.nodeShell!
    return this.update({ nodeShell: setting ? { ...others, [context]: setting } : others })
  }

  /** Whether AI assistants' changes to `context` are asked about (unless set otherwise). */
  aiChanges(context: string): AiChanges {
    return this.#settings.aiChanges![context] ?? 'ask'
  }

  setAiChanges(context: string, changes: AiChanges): Settings {
    const { [context]: _previous, ...others } = this.#settings.aiChanges!
    return this.update({
      aiChanges: changes === 'ask' ? others : { ...others, [context]: changes },
    })
  }

  update(patch: Partial<Omit<Settings, 'readOnlyAll' | 'nodeShellDefault'>>): Settings {
    this.#settings = { ...this.#settings, ...patch }
    mkdirSync(this.dir, { recursive: true })
    // Yours alone: it holds the token AI assistants connect with.
    writeFileSync(this.#file, JSON.stringify(this.#settings, null, 2), { mode: 0o600 })
    chmodSync(this.#file, 0o600)
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
        // Settings that don't make sense (edited by hand, say) fall back to detection.
        metricsSource: Object.fromEntries(
          Object.entries(stored.metricsSource ?? {}).filter(([, setting]) =>
            isMetricsSourceSetting(setting),
          ),
        ),
        nodeShell: Object.fromEntries(
          Object.entries(stored.nodeShell ?? {}).filter(([, setting]) =>
            isNodeShellSetting(setting),
          ),
        ),
        // On unless turned off.
        autoUpdate: stored.autoUpdate !== false,
        assistants: {
          enabled: stored.assistants?.enabled === true,
          port: isPort(stored.assistants?.port) ? stored.assistants.port : DEFAULT_ASSISTANTS_PORT,
          ...(TOKEN.test(String(stored.assistants?.token))
            ? { token: stored.assistants!.token }
            : {}),
          ...(Array.isArray(stored.assistants?.launch) &&
          stored.assistants.launch.every((arg) => typeof arg === 'string')
            ? { launch: stored.assistants.launch }
            : {}),
        },
        aiChanges: Object.fromEntries(
          Object.entries(stored.aiChanges ?? {}).filter(([, changes]) => isAiChanges(changes)),
        ),
      }
    } catch {
      // First run, or the file is unreadable: start from defaults.
      return { ...DEFAULTS }
    }
  }
}

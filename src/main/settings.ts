import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  NODE_SHELL_DEFAULTS,
  type MetricsSourceSetting,
  type NodeShellSetting,
  type Settings,
} from '@shared/api'
import {
  checkedPermissions,
  NO_PERMISSIONS,
  parseMatcher,
  type AiPermissions,
  type AiRule,
} from '@shared/ai-permissions'
import { DEFAULT_ASSISTANTS_PORT, isAiChanges, isPort, isToken } from '@shared/assistants'
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
  aiPermissions: NO_PERMISSIONS,
}

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

  /** What AI assistants may do, and where. */
  aiPermissions(): AiPermissions {
    return this.#settings.aiPermissions!
  }

  /** Keeps them, once they're checked (a page sends them). */
  setAiPermissions(given: unknown): AiPermissions {
    return this.update({ aiPermissions: checkedPermissions(given) }).aiPermissions!
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
          ...(isToken(stored.assistants?.token) ? { token: stored.assistants.token } : {}),
          ...(Array.isArray(stored.assistants?.launch) &&
          stored.assistants.launch.every((arg) => typeof arg === 'string')
            ? { launch: stored.assistants.launch }
            : {}),
        },
        aiPermissions: storedPermissions(stored),
      }
    } catch {
      // First run, or the file is unreadable: start from defaults.
      return { ...DEFAULTS }
    }
  }
}

/**
 * What AI assistants may do, as kept: unless it was edited into something
 * that doesn't make sense, then the defaults. Before them, each context's
 * changes were asked about, made without asking or refused (aiChanges): those
 * are rules now, a context each.
 */
function storedPermissions(stored: Partial<Settings> & { aiChanges?: unknown }): AiPermissions {
  if (stored.aiPermissions !== undefined) {
    try {
      return checkedPermissions(stored.aiPermissions)
    } catch {
      return NO_PERMISSIONS
    }
  }
  const rules: AiRule[] = Object.entries(Object(stored.aiChanges) as Record<string, unknown>)
    .filter(([context, changes]) => {
      const named = parseMatcher(context)
      return (
        isAiChanges(changes) &&
        changes !== 'ask' &&
        typeof named !== 'string' &&
        named.kind === 'name'
      )
    })
    .map(([context, changes], i) => ({
      id: `context-${i + 1}`,
      name: context,
      clusters: [context],
      namespaces: [],
      set: { changes: changes as AiRule['set']['changes'] },
    }))
  return { ...NO_PERMISSIONS, rules }
}

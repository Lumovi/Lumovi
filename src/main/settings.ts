import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import {
  managedReadOnly,
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
import { NO_POLICY, type Policy } from './policy'

const DEFAULTS: Settings = {
  theme: 'system',
  readOnly: [],
  metricsSource: {},
  nodeShell: {},
  autoUpdate: true,
  matchingKubectl: true,
  assistants: { enabled: false, port: DEFAULT_ASSISTANTS_PORT },
  aiPermissions: NO_PERMISSIONS,
}

/** What AI assistants may do when what was kept can't be read: nothing, until it's set again. */
const UNREADABLE: AiPermissions = {
  defaults: { changes: 'never', secrets: 'hidden', env: 'all', logs: 'off' },
  rules: [],
}

/** Persists user preferences as JSON in the app's userData directory. */
export class SettingsStore implements SettingsAccess {
  readonly #file: string
  #settings: Settings
  /** LUMOVI_READ_ONLY makes every context read-only, whatever was stored. */
  readonly #readOnlyAll: boolean
  /** AI permissions as they were kept, when they couldn't be read. */
  #unreadable: unknown

  constructor(
    private readonly dir: string,
    env: NodeJS.ProcessEnv = process.env,
    /** What the organization's policy sets, which this computer's person can't change. */
    private readonly policy: Policy = NO_POLICY,
  ) {
    this.#file = join(dir, 'settings.json')
    this.#settings = this.#read()
    this.#readOnlyAll = ['1', 'true'].includes(env.LUMOVI_READ_ONLY ?? '')
  }

  get(): Settings {
    const { managed } = this.policy
    return {
      ...this.#settings,
      nodeShellDefault: NODE_SHELL_DEFAULTS,
      ...(this.#readOnlyAll ? { readOnlyAll: true } : {}),
      // As the policy sets them, whatever was kept.
      ...(managed && {
        managed,
        ...(managed.updatesOff && { autoUpdate: false }),
        ...(managed.kubectlOff && { matchingKubectl: false }),
        ...(managed.assistantsOff && {
          assistants: { ...this.#settings.assistants!, enabled: false },
        }),
      }),
    }
  }

  isReadOnly(context: string): boolean {
    return (
      this.#readOnlyAll ||
      managedReadOnly(this.policy.managed, context) ||
      this.#settings.readOnly!.includes(context)
    )
  }

  /** What AI assistants may do at most, as the organization's policy says. */
  adminRules(): AiRule[] {
    return this.policy.assistantRules
  }

  setReadOnly(context: string, readOnly: boolean): Settings {
    if (!readOnly && managedReadOnly(this.policy.managed, context)) {
      throw new Error(`Your organization’s policy makes ${context} read-only.`)
    }
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

  /** Whether what was kept couldn't be read (so assistants may do nothing), until it's set again. */
  aiPermissionsUnreadable(): boolean {
    return this.#settings.aiPermissions === UNREADABLE
  }

  /** Keeps them, once they're checked (a page sends them). */
  setAiPermissions(given: unknown): AiPermissions {
    return this.update({ aiPermissions: checkedPermissions(given) }).aiPermissions!
  }

  /**
   * The kubeconfig files chosen in Lumovi in place of KUBECONFIG's (or ~/.kube/config), and
   * those added after them, unless the organization's policy keeps to the default.
   */
  kubeconfigFiles(): { chosen: string[]; added: string[] } {
    if (this.policy.managed?.kubeconfigFilesLocked) return { chosen: [], added: [] }
    return {
      chosen: this.#settings.kubeconfigFiles ?? [],
      added: this.#settings.kubeconfigAdded ?? [],
    }
  }

  update(patch: Partial<Omit<Settings, 'readOnlyAll' | 'nodeShellDefault'>>): Settings {
    // What the policy sets is shown, not kept: the person's own stays for when it's gone.
    const managed = this.policy.managed
    const { managed: _managed, ...given } = patch
    if (managed?.updatesOff) delete given.autoUpdate
    if (managed?.kubectlOff) delete given.matchingKubectl
    if (managed?.assistantsOff && given.assistants) {
      given.assistants = { ...given.assistants, enabled: this.#settings.assistants!.enabled }
    }
    this.#settings = { ...this.#settings, ...given }
    mkdirSync(this.dir, { recursive: true })
    // Yours alone: it holds the token AI assistants connect with.
    // What couldn't be read stays as it was, until the person sets it again.
    const kept =
      this.#settings.aiPermissions === UNREADABLE
        ? { ...this.#settings, aiPermissions: this.#unreadable }
        : this.#settings
    writeFileSync(this.#file, JSON.stringify(kept, null, 2), { mode: 0o600 })
    chmodSync(this.#file, 0o600)
    return this.get()
  }

  #read(): Settings {
    try {
      const stored = JSON.parse(readFileSync(this.#file, 'utf8')) as Partial<Settings>
      const aiPermissions = storedPermissions(stored)
      if (aiPermissions === UNREADABLE) this.#unreadable = stored.aiPermissions
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
        // Where each is (they're read where they are, never written).
        ...(paths(stored.kubeconfigFiles) ? { kubeconfigFiles: stored.kubeconfigFiles } : {}),
        ...(paths(stored.kubeconfigAdded) ? { kubeconfigAdded: stored.kubeconfigAdded } : {}),
        // On unless turned off.
        autoUpdate: stored.autoUpdate !== false,
        matchingKubectl: stored.matchingKubectl !== false,
        assistants: {
          enabled: stored.assistants?.enabled === true,
          port: isPort(stored.assistants?.port) ? stored.assistants.port : DEFAULT_ASSISTANTS_PORT,
          ...(isToken(stored.assistants?.token) ? { token: stored.assistants.token } : {}),
          ...(Array.isArray(stored.assistants?.launch) &&
          stored.assistants.launch.every((arg) => typeof arg === 'string')
            ? { launch: stored.assistants.launch }
            : {}),
        },
        aiPermissions,
      }
    } catch {
      // First run, or the file is unreadable: start from defaults.
      return { ...DEFAULTS }
    }
  }
}

/** Whether a setting is a list of files, each where it is. */
const paths = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((file) => typeof file === 'string' && isAbsolute(file))

/**
 * What AI assistants may do, as kept: unless it was edited into something
 * that doesn't make sense, then nothing at all, until the person says again
 * (never looser than they meant). Before them, each context's changes were
 * asked about, made without asking or refused (aiChanges): those are rules
 * now, a context each.
 */
function storedPermissions(stored: Partial<Settings> & { aiChanges?: unknown }): AiPermissions {
  if (stored.aiPermissions !== undefined) {
    try {
      return checkedPermissions(stored.aiPermissions)
    } catch {
      return UNREADABLE
    }
  }
  const rules: AiRule[] = Object.entries(Object(stored.aiChanges) as Record<string, unknown>)
    .filter(([context, changes]) => {
      if (!isAiChanges(changes) || changes === 'ask') return false
      // A name, as it was; one that reads as a pattern only where that's stricter (never).
      const named = parseMatcher(context)
      return (
        typeof named !== 'string' &&
        (named.kind === 'name' || (named.kind === 'pattern' && changes === 'never'))
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

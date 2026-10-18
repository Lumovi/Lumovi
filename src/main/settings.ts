import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import {
  developerModeLocked,
  managedReadOnly,
  NODE_SHELL_DEFAULTS,
  type AgreedRecord,
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
import { checkedClusterSettings, type ClusterSettings } from '@shared/cluster-settings'
import type { InstalledCopy, InstalledRecord } from '@shared/plugin-store'
import { PLUGIN_NAME } from '@shared/plugins'
import {
  checkedPreferences,
  effectivePreferences,
  isDefault,
  lockedNames,
  refusedNames,
  type PreferenceKey,
  type Preferences,
} from '@shared/preferences'
import { NO_POLICY, type Policy } from './policy'
import { effectiveKeys, shortcutProblems } from '@shared/shortcuts'

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
    const { theme: lockedTheme, ...lockedOwn } = managed?.settings ?? {}
    const locked: PreferenceKey[] = [
      ...lockedNames(managed?.settings ?? {}),
      ...(managed?.updatesOff ? (['autoUpdate'] as const) : []),
    ]
    return {
      ...this.#settings,
      ...(lockedTheme ? { theme: lockedTheme } : {}),
      preferences: effectivePreferences(this.#own(), lockedOwn),
      ...(locked.length ? { locked } : {}),
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

  /** The person's own settings, as kept (what they set, not the defaults). */
  #own(): Partial<Preferences> {
    return (this.#settings.preferences ?? {}) as Partial<Preferences>
  }

  /**
   * Changes the person's own settings, checked; null puts one back. One the policy sets, or a
   * value a setting doesn't take, is refused, and nothing changes.
   */
  setPreferences(patch: unknown): Settings {
    const { preferences, problems } = checkedPreferences(patch)
    const lockedOwn = this.policy.managed?.settings ?? {}
    const locked = refusedNames(preferences, lockedOwn)
    if (locked.length) problems.push(`${locked.join(', ')}: set by your organization.`)
    const own: Record<string, unknown> = { ...this.#own() }
    // (One set to its default is kept as unset: it follows the default, and Restore has nothing.)
    for (const [key, value] of Object.entries(preferences)) {
      if (value === null || isDefault(key, value)) delete own[key]
      else own[key] = value
    }
    if ('shortcuts' in preferences && !problems.length) {
      const { shortcuts } = effectivePreferences(own, lockedOwn as Partial<Preferences>)
      const keys = effectiveKeys(shortcuts, process.platform === 'darwin')
      problems.push(...shortcutProblems(keys, process.platform === 'darwin', true))
    }
    if (problems.length) throw new Error(problems.join(' '))
    return this.update({ preferences: own as unknown as Preferences })
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

  /** How a cluster shows in Lumovi: all of it (what's left out is unset), checked. */
  setCluster(context: string, settings: unknown): Settings {
    const kept = checkedClusterSettings(settings)
    const { [context]: _was, ...others } = this.#settings.clusters ?? {}
    return this.update({
      clusters: Object.keys(kept).length > 0 ? { ...others, [context]: kept } : others,
    })
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

  pluginCode(): Readonly<Record<string, boolean>> {
    return this.#settings.pluginCode ?? {}
  }

  setPluginCode(plugin: string, on: boolean): Settings {
    // (Off by the organization's policy: nothing here turns it on.)
    if (on && this.policy.managed?.pluginCodeOff) {
      throw new Error('Your organization’s policy doesn’t let plugins run code.')
    }
    return this.update({ pluginCode: { ...this.pluginCode(), [plugin]: on } })
  }

  /** The highest serial of Lumovi-plugins' releases taken here: none, 0. */
  pluginStoreSerial(): number {
    return this.#settings.pluginStoreSerial ?? 0
  }

  /** The plugins installed from Lumovi-plugins, as they were agreed to. */
  pluginsInstalled(): Readonly<Record<string, InstalledRecord>> {
    return this.#settings.pluginsInstalled ?? {}
  }

  /** Keeps them, as the installer leaves them. */
  setPluginsInstalled(records: Record<string, InstalledRecord>): void {
    this.update({ pluginsInstalled: records })
  }

  /** Whether Developer mode is on: never while the organization's policy keeps it off. */
  pluginDeveloperMode(): boolean {
    return this.#settings.pluginDeveloperMode === true && !developerModeLocked(this.policy.managed)
  }

  setPluginDeveloperMode(on: boolean): Settings {
    // (Off by the organization's policy: nothing here turns it on.)
    if (on && developerModeLocked(this.policy.managed)) {
      throw new Error('Your organization’s policy keeps Developer mode off.')
    }
    return this.update({ pluginDeveloperMode: on })
  }

  /** What the person agreed to run of each of their own plugins' code. */
  pluginsAgreed(): Readonly<Record<string, AgreedRecord>> {
    return this.#settings.pluginsAgreed ?? {}
  }

  /** Keeps them, as the agreements leave them. */
  setPluginsAgreed(records: Record<string, AgreedRecord>): void {
    this.update({ pluginsAgreed: records })
  }

  /** Keeps a release's serial, where it's higher than any taken before. */
  acceptPluginStoreSerial(serial: number): void {
    if (serial > this.pluginStoreSerial()) this.update({ pluginStoreSerial: serial })
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
   * The kubeconfig files chosen in Lumovi in place of KUBECONFIG's (or ~/.kube/config), those
   * added after them, and the folders of them added, unless the organization's policy keeps to
   * the default.
   */
  kubeconfigFiles(): { chosen: string[]; added: string[]; folders: string[] } {
    if (this.policy.managed?.kubeconfigFilesLocked) return { chosen: [], added: [], folders: [] }
    return {
      chosen: this.#settings.kubeconfigFiles ?? [],
      added: this.#settings.kubeconfigAdded ?? [],
      folders: this.#settings.kubeconfigFolders ?? [],
    }
  }

  /** What a folder's kubeconfig has its credentials do that the person agreed to (digests). */
  kubeconfigConsents(file: string): string[] {
    return this.#settings.kubeconfigConsents?.[file] ?? []
  }

  /** Keeps those, for that file, with any agreed to before (the newest last, a few hundred at most). */
  agreeTo(file: string, consents: string[]): void {
    const all = this.#settings.kubeconfigConsents ?? {}
    const kept = [...new Set([...(all[file] ?? []), ...consents])].slice(-MAX_CONSENTS)
    this.update({ kubeconfigConsents: { ...all, [file]: kept } })
  }

  /** What was agreed to for the files no longer read in any folder, forgotten. */
  forgetConsents(keep: (file: string) => boolean): void {
    const all = this.#settings.kubeconfigConsents ?? {}
    const kept = Object.fromEntries(Object.entries(all).filter(([file]) => keep(file)))
    if (Object.keys(kept).length !== Object.keys(all).length) {
      this.update({ kubeconfigConsents: kept })
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
        // Validated against the connected displays when each window opens.
        windows: Array.isArray(stored.windows)
          ? stored.windows.filter((each) => typeof each === 'object' && each !== null)
          : undefined,
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
        ...(paths(stored.kubeconfigFolders) ? { kubeconfigFolders: stored.kubeconfigFolders } : {}),
        ...consentsOf(stored.kubeconfigConsents),
        // A cluster's that don't make sense (edited by hand, say) are left as if unset.
        ...clustersOf(stored.clusters),
        // The person's own settings: each that doesn't make sense (edited by hand) left as unset.
        preferences: Object.fromEntries(
          Object.entries(checkedPreferences(stored.preferences ?? {}).preferences).filter(
            ([, value]) => value !== null,
          ),
        ) as unknown as Preferences,
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
        // Each plugin's, as it was chosen: one that doesn't make sense is as if never chosen.
        ...pluginCodeOf(stored.pluginCode),
        // Each installed plugin's record, as it was kept: one that doesn't make sense is as if
        // never installed (Lumovi's own, or none, is used).
        ...installedOf(stored.pluginsInstalled),
        // On only where it was turned on; what was agreed, each as kept (one that doesn't make
        // sense is as if never agreed: its code waits for the person again).
        ...(stored.pluginDeveloperMode === true ? { pluginDeveloperMode: true } : {}),
        ...agreedOf(stored.pluginsAgreed),
        // (One that isn't a whole number is as if none was taken: the built-in release's holds.)
        ...(Number.isSafeInteger(stored.pluginStoreSerial) && stored.pluginStoreSerial! > 0
          ? { pluginStoreSerial: stored.pluginStoreSerial }
          : {}),
      }
    } catch {
      // First run, or the file is unreadable: start from defaults.
      return { ...DEFAULTS }
    }
  }
}

/** Each cluster's settings that make sense, as kept (none: left out). */
function clustersOf(value: unknown): { clusters?: Record<string, ClusterSettings> } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const clusters = Object.fromEntries(
    Object.entries(value).flatMap(([context, settings]) => {
      try {
        return [[context, checkedClusterSettings(settings)]]
      } catch {
        return []
      }
    }),
  )
  return Object.keys(clusters).length > 0 ? { clusters } : {}
}

/** Whose plugins' code runs, as chosen: plugins' names, each on or off (the rest left out). */
function pluginCodeOf(value: unknown): { pluginCode?: Record<string, boolean> } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const chosen = Object.fromEntries(
    Object.entries(value).filter(
      ([plugin, on]) => PLUGIN_NAME.test(plugin) && typeof on === 'boolean',
    ),
  ) as Record<string, boolean>
  return Object.keys(chosen).length > 0 ? { pluginCode: chosen } : {}
}

const HEX64 = /^[0-9a-f]{64}$/
const THREE_NUMBERS = /^\d+\.\d+\.\d+$/

/** A copy of an installed plugin as it was kept, if it makes sense. */
function copyOf(value: unknown): InstalledCopy | undefined {
  const copy = value as Partial<InstalledCopy> | undefined
  if (typeof copy !== 'object' || copy === null) return undefined
  const files = copy.files as Record<string, unknown> | undefined
  const sound =
    typeof copy.version === 'string' &&
    THREE_NUMBERS.test(copy.version) &&
    typeof copy.release === 'string' &&
    THREE_NUMBERS.test(copy.release) &&
    typeof copy.asks === 'string' &&
    HEX64.test(copy.asks) &&
    typeof copy.at === 'string' &&
    typeof files === 'object' &&
    files !== null &&
    typeof files['plugin.yaml'] === 'string' &&
    Object.entries(files).every(
      ([path, sha]) =>
        (path === 'plugin.yaml' || path === 'plugin.js') &&
        typeof sha === 'string' &&
        HEX64.test(sha),
    )
  return sound
    ? {
        version: copy.version!,
        release: copy.release!,
        files: { ...(files as Record<string, string>) },
        asks: copy.asks!,
        at: copy.at!,
      }
    : undefined
}

/** The installed plugins' records that make sense, as kept (none: left out). */
function installedOf(value: unknown): { pluginsInstalled?: Record<string, InstalledRecord> } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const records = Object.fromEntries(
    Object.entries(value).flatMap(([name, record]) => {
      const current = copyOf((record as Partial<InstalledRecord> | null)?.current)
      if (!PLUGIN_NAME.test(name) || !current) return []
      const kept = copyOf((record as Partial<InstalledRecord>).kept)
      return [[name, { current, ...(kept && kept.version !== current.version ? { kept } : {}) }]]
    }),
  )
  return Object.keys(records).length > 0 ? { pluginsInstalled: records } : {}
}

/** The agreements to a person's own plugins' code that make sense, as kept (none: left out). */
function agreedOf(value: unknown): { pluginsAgreed?: Record<string, AgreedRecord> } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const records = Object.fromEntries(
    Object.entries(value).flatMap(([name, record]) => {
      const r = record as Partial<AgreedRecord> | null
      return PLUGIN_NAME.test(name) &&
        typeof r?.asks === 'string' &&
        typeof r.code === 'string' &&
        /^sha256:[0-9a-f]{64}$/.test(r.code) &&
        typeof r.file === 'string' &&
        typeof r.at === 'string'
        ? [[name, { asks: r.asks, code: r.code, file: r.file, at: r.at }]]
        : []
    }),
  )
  return Object.keys(records).length > 0 ? { pluginsAgreed: records } : {}
}

/** Whether a setting is a list of files, each where it is. */
const paths = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((file) => typeof file === 'string' && isAbsolute(file))

/** The most digests kept for one file. */
const MAX_CONSENTS = 200

/** What was agreed to, by file, as kept: digests alone (anything else is left out). */
function consentsOf(value: unknown): { kubeconfigConsents?: Record<string, string[]> } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const consents = Object.fromEntries(
    Object.entries(value).flatMap(([file, digests]) =>
      isAbsolute(file) && Array.isArray(digests)
        ? [
            [
              file,
              digests.filter(
                (digest) => typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest),
              ),
            ],
          ]
        : [],
    ),
  )
  return Object.keys(consents).length > 0 ? { kubeconfigConsents: consents } : {}
}

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

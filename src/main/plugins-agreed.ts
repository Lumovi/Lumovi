/**
 * What a person agreed to run of their own plugins' code (the desktop app's, in Developer mode):
 * kept in settings by plugin, as what its file asked then (`asksOf`'s text), its code's digest
 * and its file, and held against each plugin every time it's read. What was agreed is what runs:
 * a file that asks otherwise, or code that isn't what was agreed to, waits for the person again.
 *
 * Whoever can write their settings can write these too, as with every setting of theirs: a
 * record that doesn't parse, or doesn't match, is as if never made.
 */
import type { Recorded, Recorder } from '@backend/audit/recorder'
import {
  developerModeLocked,
  type AgreedRecord,
  type ManagedSettings,
  type OwnCode,
  type Waiting,
} from '@shared/api'
import { PLUGIN_NAME } from '@shared/plugins'
import type { KnownPlugin } from '@shared/plugins-known'

export interface AgreedOptions {
  records: () => Readonly<Record<string, AgreedRecord>>
  keep: (records: Record<string, AgreedRecord>) => void
  /** The plugins in use, as the backend reads them now. */
  known: () => Promise<readonly Readonly<KnownPlugin>[]>
  /** Where a plugin's file is, as a person reads it ("~/.lumovi/plugins/toys/plugin.yaml"). */
  shown: (file: string) => string
  audit: Pick<Recorder, 'record'>
  /** Recorded by Lumovi itself, not by the person: what the organization's policy did. */
  byLumovi: (input: Recorded) => void
  now?: () => Date
}

export class AgreedPlugins {
  readonly #options: AgreedOptions

  constructor(options: AgreedOptions) {
    this.#options = options
  }

  /** How one of a person's own with code stands: agreed to as it is, or why it waits. */
  standing(plugin: Readonly<KnownPlugin>): Waiting | 'agreed' {
    const record = this.#recordOf(plugin.name)
    if (!record || record.file !== plugin.file) return 'first'
    if (record.asks !== plugin.asks) return 'asks'
    return record.code === plugin.codeDigest ? 'agreed' : 'code'
  }

  /** One of a person's own with code that's read now, and how it stands; none, no such one. */
  async ownCode(name: unknown): Promise<OwnCode | undefined> {
    const plugin = await this.#own(name)
    if (!plugin) return undefined
    const agreed = this.#recordOf(plugin.name)?.asks
    return {
      standing: this.standing(plugin),
      asks: plugin.asks!,
      code: plugin.codeDigest!,
      ...(agreed !== undefined ? { agreed } : {}),
    }
  }

  /**
   * Agrees to run one's code, as the person was shown it: what its file asks and its code's
   * digest, which must be what Lumovi reads now (else it changed while they looked).
   */
  async agree(name: unknown, asks: unknown, code: unknown): Promise<void> {
    const plugin = await this.#own(name)
    if (!plugin) {
      throw new Error(
        'Lumovi runs no code of this plugin: it isn’t one of yours with code, or Developer mode is off.',
      )
    }
    if (plugin.asks !== asks || plugin.codeDigest !== code) {
      throw new Error(
        'It changed while its dialog was open. Open it again to see what it asks now.',
      )
    }
    const before = this.standing(plugin)
    const records = { ...this.#options.records() }
    records[plugin.name] = {
      asks: plugin.asks!,
      code: plugin.codeDigest!,
      file: plugin.file,
      at: (this.#options.now?.() ?? new Date()).toISOString(),
    }
    this.#options.keep(records)
    const label = plugin.label ?? plugin.name
    this.#audit({
      action: 'plugin.code-agreed',
      outcome: 'success',
      target: { kind: 'Plugin', name: plugin.name },
      summary: `Agreed to run the code of the plugin ${label} ${plugin.version}, from ${this.#options.shown(plugin.file)}`,
      details: {
        plugin: plugin.name,
        pluginVersion: plugin.version,
        pluginDigest: plugin.digest,
        codeDigest: plugin.codeDigest!,
        // (A second agreement: what changed since the one before.)
        ...(before === 'code' || before === 'asks' ? { changed: before } : {}),
      },
    })
  }

  /**
   * Under a policy that keeps Developer mode off, lets go of every agreement: once it's allowed
   * again, each waits for the person from the start. Said once, where there was any.
   */
  clearUnder(managed: ManagedSettings | undefined): void {
    if (!developerModeLocked(managed)) return
    if (Object.keys(this.#options.records()).length === 0) return
    this.#options.keep({})
    this.#options.byLumovi({
      action: 'plugin.code-agreed',
      outcome: 'cancelled',
      summary:
        'Let go of what you agreed to run of your own plugins’ code: your organization’s policy turns Developer mode off',
      details: { policy: managed!.source },
    })
  }

  /** A record by a plugin's name: only a plugin's name, and only its own. */
  #recordOf(name: string): AgreedRecord | undefined {
    const records = this.#options.records()
    return PLUGIN_NAME.test(name) && Object.hasOwn(records, name) ? records[name] : undefined
  }

  /** One of a person's own plugins whose code was read (in Developer mode), by its name. */
  async #own(name: unknown): Promise<Readonly<KnownPlugin> | undefined> {
    if (typeof name !== 'string' || !PLUGIN_NAME.test(name)) return undefined
    const plugin = (await this.#options.known()).find((p) => p.name === name)
    return plugin?.origin === 'yours' &&
      plugin.asks !== undefined &&
      plugin.codeDigest !== undefined
      ? plugin
      : undefined
  }

  #audit(input: Recorded): void {
    this.#options.audit.record(input)
  }
}

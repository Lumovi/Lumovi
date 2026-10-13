/**
 * Plugins installed from Lumovi-plugins (the desktop app's): each written, as its release has it,
 * to the app's folder (plugins/installed/<name>/<version>/), with a record of what was agreed to
 * kept in its settings: the version, each file's SHA-256, what it asks (`asksOf`), and when. The
 * copy before it is kept too, and only that one.
 *
 * Nothing is written but on the person's press, after the release is checked again then (the
 * store's `again`): what it asks must be what they were shown, its Lumovi new enough, and the
 * organization's policy must allow it. Every time Lumovi reads them (`read`), each file is checked
 * against its record, and its Lumovi and the policy again: one that fails isn't used, and Lumovi's
 * own (or none) is in its place, with the page saying why.
 *
 * Each change is audited: installed, updated, went back, removed.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Recorded, Recorder } from '@backend/audit/recorder'
import type { ManagedSettings } from '@shared/api'
import {
  asksOf,
  failedLine,
  policyRefusal,
  unsaid,
  type Installed,
  type InstalledCopy,
  type InstalledRecord,
} from '@shared/plugin-store'
import { older, parsePlugin, PLUGIN_NAME, type Plugin } from '@shared/plugins'
import type { PluginStore } from './plugin-store'
import { VERSION } from './plugins-release'

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')

/** A plugin's files, by their path in it: its file, and its code where it has some. */
const FILE = 'plugin.yaml'
const CODE = 'plugin.js'

/** Why something asked of the installer can't be done: in words the page shows as they are. */
export class InstallError extends Error {}

export interface InstalledOptions {
  /** Where the copies are: the app's own folder's plugins/installed. */
  dir: string
  /** The records, as settings keep them, and keeping them. */
  records: () => Readonly<Record<string, InstalledRecord>>
  keep: (records: Record<string, InstalledRecord>) => void
  store: Pick<PluginStore, 'again'>
  /** This Lumovi's version. */
  lumovi: string
  /** The organization's policy, read each time. */
  managed: () => ManagedSettings | undefined
  /** The plugins that come with this Lumovi: each one's version, by its name. */
  builtIn: () => Promise<ReadonlyMap<string, string>>
  audit: Pick<Recorder, 'record'>
  now?: () => Date
}

/** A copy, read and checked against its record: its file and code, and its plugin. */
interface Read {
  file: string
  code?: string
  plugin?: Plugin
}

export class InstalledPlugins {
  readonly #options: InstalledOptions

  constructor(options: InstalledOptions) {
    this.#options = options
  }

  /** Where a plugin's copy of a version is. */
  #at(name: string, version: string): string {
    // (Both are checked before they're ever part of a path: a name, and three numbers.)
    if (!PLUGIN_NAME.test(name) || !VERSION.test(version)) {
      throw new InstallError(`${name} ${version} isn’t a plugin’s name and version`)
    }
    return join(this.#options.dir, name, version)
  }

  /** A copy's files, each checked against its record: or nothing where one isn't. */
  async #read(name: string, copy: InstalledCopy): Promise<Read | undefined> {
    const at = this.#at(name, copy.version)
    const read: Partial<Record<string, string>> = {}
    for (const [path, pinned] of Object.entries(copy.files)) {
      try {
        const bytes = await readFile(join(at, path))
        if (sha256(bytes) !== pinned) return undefined
        read[path] = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        return undefined
      }
    }
    const file = read[FILE]!
    const { plugin } = parsePlugin(file, `${name}.yaml`, { carriesCode: true })
    return {
      file,
      ...(read[CODE] === undefined ? {} : { code: read[CODE] }),
      ...(plugin ? { plugin } : {}),
    }
  }

  /**
   * The installed plugins in use, with their files and code, and why any isn't: each file checked
   * against what was agreed, each plugin's Lumovi against this one, and each against the policy.
   */
  async read(): Promise<Installed & { codes: Record<string, string> }> {
    // (Read again only when something it's made from changed: the records, the policy, or a
    // file's size or times. Marked before it's read, so a file changed meanwhile is read again.)
    const mark = await this.#mark()
    if (this.#last?.mark === mark) return this.#last.installed
    const installed = await this.#readAll()
    this.#last = { mark, installed }
    return installed
  }

  #last?: { mark: string; installed: Installed & { codes: Record<string, string> } }

  /** What the installed plugins are now, without reading them. */
  async #mark(): Promise<string> {
    const records = this.#options.records()
    const files = await Promise.all(
      Object.entries(records).flatMap(([name, { current }]) =>
        Object.keys(current.files).map(async (path) => {
          try {
            const s = await stat(join(this.#at(name, current.version), path), { bigint: true })
            return [name, path, s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':')
          } catch (error) {
            return `${name}:${path}:${(error as NodeJS.ErrnoException).code ?? 'unreadable'}`
          }
        }),
      ),
    )
    return JSON.stringify([records, this.#options.managed() ?? null, files])
  }

  async #readAll(): Promise<Installed & { codes: Record<string, string> }> {
    const installed: Installed & { codes: Record<string, string> } = {
      plugins: [],
      notUsed: [],
      codes: {},
    }
    for (const [name, record] of Object.entries(this.#options.records())) {
      const { current, kept } = record
      const read = await this.#read(name, current)
      const notUsed = (why: 'files' | 'lumovi' | 'policy', needs?: string) =>
        installed.notUsed.push({ name, version: current.version, why, ...(needs ? { needs } : {}) })
      if (!read || (read.plugin && read.plugin.version !== current.version)) {
        notUsed('files')
        continue
      }
      // (One this Lumovi can't read at all: written for a newer one.)
      const needs = read.plugin?.needs.lumovi
      if (!read.plugin || (needs && older(this.#options.lumovi, needs))) {
        notUsed('lumovi', needs)
        continue
      }
      if (policyRefusal(this.#options.managed(), read.plugin, read.code !== undefined)) {
        notUsed('policy')
        continue
      }
      // (The copy kept, offered to go back to only where it's still the one agreed to.)
      const before = kept && (await this.#read(name, kept))
      installed.plugins.push({
        name,
        version: current.version,
        release: current.release,
        ...(kept && before
          ? {
              kept: {
                version: kept.version,
                release: kept.release,
                file: before.file,
                code: before.code !== undefined,
              },
            }
          : {}),
        file: read.file,
        code: read.code !== undefined,
      })
      if (read.code !== undefined) installed.codes[name] = read.code
    }
    return installed
  }

  /**
   * Installs `name` at `version` from Lumovi-plugins' latest release, checked again now: only if
   * what it asks is `agreed` (what the person was shown, `asksOf`), its Lumovi is new enough, and
   * the policy allows it. The copy in use before is kept; any older one goes.
   */
  async install(name: string, version: string, agreed: string): Promise<void> {
    const at = this.#at(name, version)
    const fresh = await this.#options.store.again()
    if ('failure' in fresh) {
      throw new InstallError(
        fresh.failure === 'off'
          ? 'Your organization’s policy turns off checking for newer plugins.'
          : failedLine(fresh.failure),
      )
    }
    const entry = fresh.release.plugins.find(
      (plugin) => plugin.name === name && plugin.version === version,
    )
    if (!entry) {
      throw new InstallError(
        `Lumovi-plugins release ${fresh.release.version} doesn’t have ${name} ${version}. Check again for what it has.`,
      )
    }
    const code = fresh.files[`${name}.js`]
    const { plugin } = parsePlugin(entry.file, `${name}.yaml`, { carriesCode: true })
    if (!plugin || plugin.name !== name || plugin.version !== version) {
      throw new InstallError(`This Lumovi can’t read ${name} ${version}.`)
    }
    // (A field this Lumovi can't say what it asks: never installed, rather than agreed to unseen.)
    if (unsaid(plugin).length > 0) {
      throw new InstallError(
        `This Lumovi can’t say all that ${name} ${version} asks for, so it doesn’t install it.`,
      )
    }
    const asks = asksOf(plugin, code !== undefined)
    if (asks !== agreed) {
      throw new InstallError(
        'What it asks isn’t what you were shown: the release changed since. Look at it again.',
      )
    }
    if (older(this.#options.lumovi, plugin.needs.lumovi)) {
      throw new InstallError(`It needs Lumovi ${plugin.needs.lumovi}.`)
    }
    const refused = policyRefusal(this.#options.managed(), plugin, code !== undefined)
    if (refused) throw new InstallError(refused.line)

    // Written whole, under a name of its own, then moved into place: a copy is there whole or not
    // at all.
    const files: Record<string, string> = {
      [FILE]: entry.file,
      ...(code === undefined ? {} : { [CODE]: code }),
    }
    const part = join(this.#options.dir, name, `.${version}.${randomUUID()}.part`)
    await mkdir(part, { recursive: true })
    try {
      for (const [path, text] of Object.entries(files)) await writeFile(join(part, path), text)
      await rm(at, { recursive: true, force: true })
      await rename(part, at)
    } catch (error) {
      await rm(part, { recursive: true, force: true })
      throw error
    }

    const records = { ...this.#options.records() }
    const was = records[name]
    const copy: InstalledCopy = {
      version,
      release: fresh.release.version,
      files: Object.fromEntries(Object.entries(files).map(([path, text]) => [path, sha256(text)])),
      asks: sha256(asks),
      at: (this.#options.now?.() ?? new Date()).toISOString(),
    }
    // The one before is kept: the copy that was in use, unless it's this version again.
    const kept = was && was.current.version !== version ? was.current : was?.kept
    records[name] = { current: copy, ...(kept && kept.version !== version ? { kept } : {}) }
    this.#options.keep(records)
    await this.#tidy(name, records[name])
    const label = plugin.place?.label ?? name
    // (Updated from the copy in use: one installed earlier, or the one that comes with Lumovi.)
    const from = was?.current.version ?? (await this.#options.builtIn()).get(name)
    const details = {
      plugin: name,
      version,
      release: fresh.release.version,
      // Each file's SHA-256, as "plugin.yaml sha256:…".
      files: Object.entries(copy.files).map(([path, sha]) => `${path} sha256:${sha}`),
      asks: `sha256:${copy.asks}`,
    }
    this.#audit(
      from !== undefined
        ? {
            action: 'plugin.updated',
            target: { kind: 'Plugin', name },
            summary: `Updated the plugin ${label} from ${from} to ${version}`,
            details: { ...details, from },
            outcome: 'success',
          }
        : {
            action: 'plugin.installed',
            target: { kind: 'Plugin', name },
            summary: `Installed the plugin ${label} ${version}`,
            details,
            outcome: 'success',
          },
    )
  }

  /**
   * Back to the copy kept (`kept`, checked again against its record, and against the policy, its
   * Lumovi and what was `agreed`), or to the one that came with Lumovi (`lumovi`: every copy goes).
   */
  async goBack(name: string, to: 'kept' | 'lumovi', agreed?: string): Promise<void> {
    const records = { ...this.#options.records() }
    const was = this.#record(records, name)
    const label = await this.#label(name, was.current)
    if (to === 'lumovi') {
      if (!(await this.#options.builtIn()).has(name)) {
        throw new InstallError(`No ${label} comes with this Lumovi.`)
      }
      delete records[name]
      this.#options.keep(records)
      await rm(join(this.#options.dir, name), { recursive: true, force: true })
      this.#audit({
        action: 'plugin.went-back',
        target: { kind: 'Plugin', name },
        summary: `Went back to Lumovi’s own ${label}`,
        details: { plugin: name, from: was.current.version, to: 'lumovi' },
        outcome: 'success',
      })
      return
    }
    const kept = was.kept
    if (!kept)
      throw new InstallError(`No version of ${label} before ${was.current.version} is kept.`)
    const read = await this.#read(name, kept)
    if (!read?.plugin) {
      throw new InstallError(`Its kept ${kept.version} isn’t the one you agreed to.`)
    }
    if (older(this.#options.lumovi, read.plugin.needs.lumovi)) {
      throw new InstallError(`Its kept ${kept.version} needs Lumovi ${read.plugin.needs.lumovi}.`)
    }
    const refused = policyRefusal(this.#options.managed(), read.plugin, read.code !== undefined)
    if (refused) throw new InstallError(refused.line)
    if (unsaid(read.plugin).length > 0) {
      throw new InstallError(`This Lumovi can’t say all that its kept ${kept.version} asks for.`)
    }
    // (What the person was shown now, as this Lumovi says it: never against an older Lumovi's.)
    const asks = asksOf(read.plugin, read.code !== undefined)
    // (Going back never adds a permission unasked: what it asks must be what the person was
    // shown, whatever the page decided about showing it.)
    if (agreed !== asks) {
      throw new InstallError('What it asks isn’t what you were shown. Look at it again.')
    }
    records[name] = { current: { ...kept, asks: sha256(asks) } }
    this.#options.keep(records)
    await this.#tidy(name, records[name])
    this.#audit({
      action: 'plugin.went-back',
      target: { kind: 'Plugin', name },
      summary: `Went back to the plugin ${label} ${kept.version}`,
      details: {
        plugin: name,
        from: was.current.version,
        to: kept.version,
        asks: `sha256:${sha256(asks)}`,
      },
      outcome: 'success',
    })
  }

  /** Removes one that doesn't come with Lumovi: every copy, and its record. */
  async remove(name: string): Promise<void> {
    const records = { ...this.#options.records() }
    const was = this.#record(records, name)
    const label = await this.#label(name, was.current)
    if ((await this.#options.builtIn()).has(name)) {
      throw new InstallError(`${label} comes with Lumovi: go back to it instead.`)
    }
    delete records[name]
    this.#options.keep(records)
    await rm(join(this.#options.dir, name), { recursive: true, force: true })
    this.#audit({
      action: 'plugin.removed',
      target: { kind: 'Plugin', name },
      summary: `Removed the plugin ${label} ${was.current.version}`,
      details: { plugin: name, version: was.current.version },
      outcome: 'success',
    })
  }

  /** A plugin's record: only by a plugin's name, and only its own (never what every object has). */
  #record(records: Record<string, InstalledRecord>, name: string): InstalledRecord {
    if (!PLUGIN_NAME.test(name) || !Object.hasOwn(records, name)) {
      throw new InstallError(`${name} isn’t installed.`)
    }
    return records[name]!
  }

  /** The name a person reads it by: its file's label, where it can still be read. */
  async #label(name: string, copy: InstalledCopy): Promise<string> {
    return (await this.#read(name, copy).catch(() => undefined))?.plugin?.place?.label ?? name
  }

  /** Every copy of `name` but the ones its record names goes. */
  async #tidy(name: string, record: InstalledRecord): Promise<void> {
    const keep = new Set([record.current.version, record.kept?.version])
    const folder = join(this.#options.dir, name)
    for (const entry of await readdir(folder).catch(() => [])) {
      if (!keep.has(entry)) await rm(join(folder, entry), { recursive: true, force: true })
    }
  }

  #audit(input: Recorded): void {
    this.#options.audit.record(input)
  }
}

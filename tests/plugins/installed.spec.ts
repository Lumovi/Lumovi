/**
 * Plugins installed from Lumovi-plugins (src/main/plugins-installed.ts): written only when what
 * they ask is what was agreed, their Lumovi new enough and the policy allows them; one copy
 * before kept, and no more; and every time they're read, each file checked against its record,
 * their Lumovi and the policy again. What the page shows of it is plugin-install.spec.ts's.
 */
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Recorded } from '../../src/backend/audit/recorder.ts'
import type { ManagedSettings } from '../../src/shared/api.ts'
import { InstalledPlugins, type InstalledOptions } from '../../src/main/plugins-installed.ts'
import {
  asksOf,
  PLUGIN_FIELDS,
  unsaid,
  type InstalledRecord,
  type StoreFailure,
} from '../../src/shared/plugin-store.ts'
import { parsePlugin, type Plugin } from '../../src/shared/plugins.ts'

/** A plugin's file at a version, needing a Lumovi, with `more` of what it asks. */
const file = (version: string, lumovi = '1.0.0', more = '') => `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: toys }
spec:
  version: ${version}
  needs: { lumovi: ${lumovi} }
  groups: [example.com]
  label: Toys
  kinds: [{ group: example.com, kind: Widget }]
${more}`
/** What its pages add: a page of its own. */
const PAGES = `  pages: [{ id: overview, title: Overview }]
`
/** What it asks to show of a Secret. */
const SECRET = `  showsSecrets:
    - { group: example.com, kind: Widget, path: spec.secretName, keys: [token] }
`
/** What its pages show besides: containers' logs. */
const LOGS = `  logs: shown
`
/** Containers' logs of the pods it reads: shown on its pages, or read by its code too. */
const PODS_LOGS = (
  logs: 'shown' | 'read',
) => `  reads: [{ group: '', kind: Pod, fields: [metadata.name] }]
  logs: ${logs}
`
/** What it asks besides: a link to Pods by name. */
const LINKS = `  views:
    - kinds: [{ group: example.com, kind: Widget }]
      links:
        - name: Its pod
          kind: Pod
          objectName: '{{ .metadata.name }}'
`
const agreed = (text: string, code = false) =>
  asksOf(parsePlugin(text, 'toys.yaml', { carriesCode: true }).plugin!, code)

/** The latest release, as the store would hand it over after checking it again. */
function released(texts: Record<string, string>, code?: string) {
  return {
    release: {
      version: '9.1.0',
      serial: 5,
      checked: 0,
      plugins: Object.entries(texts).map(([name, text]) => ({
        name,
        version: parsePlugin(text, `${name}.yaml`, { carriesCode: true }).plugin!.version,
        file: text,
        code: code !== undefined,
      })),
    },
    files: {
      ...Object.fromEntries(Object.entries(texts).map(([name, text]) => [`${name}.yaml`, text])),
      ...(code === undefined ? {} : { 'toys.js': code }),
    },
  }
}

/** An installer over a folder of its own, its records kept here, and what it audited. */
function installer(options: Partial<InstalledOptions> & { latest?: () => unknown } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-installed-'))
  let records: Record<string, InstalledRecord> = {}
  const audited: Recorded[] = []
  let managed: ManagedSettings | undefined
  const installed = new InstalledPlugins({
    dir,
    records: () => records,
    keep: (kept) => (records = kept),
    store: {
      again: async () => (options.latest?.() ?? released({ toys: file('1.3.0') })) as never,
    },
    lumovi: '1.22.0',
    managed: () => managed,
    builtIn: async () => new Map([['toys', '1.2.0']]),
    audit: { record: (input) => void audited.push(input) },
    ...options,
  })
  return {
    installed,
    dir,
    audited,
    records: () => records,
    policy: (said: Partial<ManagedSettings>) => (managed = { source: 'policy.json', ...said }),
  }
}

test('installed only with what was agreed: written whole, recorded, and one copy before kept', async () => {
  let latest = released({ toys: file('1.3.0') })
  const made = installer({ latest: () => latest })
  await made.installed.install('toys', '1.3.0', agreed(file('1.3.0')))
  expect(made.records().toys!.current).toMatchObject({ version: '1.3.0', release: '9.1.0' })
  expect(made.audited.at(-1)).toMatchObject({
    action: 'plugin.updated',
    summary: 'Updated the plugin Toys from 1.2.0 to 1.3.0',
  })
  for (const version of ['1.4.0', '1.5.0']) {
    latest = released({ toys: file(version) })
    await made.installed.install('toys', version, agreed(file(version)))
  }
  // The one in use, and the one before: nothing older, and nothing half written.
  expect(readdirSync(join(made.dir, 'toys')).sort()).toEqual(['1.4.0', '1.5.0'])
  expect(made.records().toys).toMatchObject({
    current: { version: '1.5.0' },
    kept: { version: '1.4.0' },
  })
  const read = await made.installed.read()
  expect(read.plugins[0]).toMatchObject({ version: '1.5.0', kept: { version: '1.4.0' } })
})

test('refused, with nothing written, where it isn’t what was agreed, needs a newer Lumovi, or the release can’t be taken', async () => {
  const made = installer()
  await expect(
    made.installed.install('toys', '1.3.0', agreed(file('1.3.0', '1.0.0', LINKS))),
  ).rejects.toThrow('What it asks isn’t what you were shown')
  // (What its pages add is asked too: a page agreed to nowhere is refused.)
  const paged = installer({ latest: () => released({ toys: file('1.3.0', '1.0.0', PAGES) }) })
  await expect(paged.installed.install('toys', '1.3.0', agreed(file('1.3.0')))).rejects.toThrow(
    'What it asks isn’t what you were shown',
  )
  // (And so is showing containers' logs.)
  const logged = installer({ latest: () => released({ toys: file('1.3.0', '1.0.0', LOGS) }) })
  await expect(logged.installed.install('toys', '1.3.0', agreed(file('1.3.0')))).rejects.toThrow(
    'What it asks isn’t what you were shown',
  )
  // (Its code reading them is more than its pages showing them: agreed to as shown, refused.)
  const reading = installer({
    latest: () => released({ toys: file('1.3.0', '1.0.0', PODS_LOGS('read')) }),
  })
  await expect(
    reading.installed.install('toys', '1.3.0', agreed(file('1.3.0', '1.0.0', PODS_LOGS('shown')))),
  ).rejects.toThrow('What it asks isn’t what you were shown')
  // (As read, it's what was agreed.)
  expect(agreed(file('1.3.0', '1.0.0', PODS_LOGS('read')))).not.toBe(
    agreed(file('1.3.0', '1.0.0', PODS_LOGS('shown'))),
  )
  await expect(made.installed.install('toys', '1.9.0', '')).rejects.toThrow(
    'Lumovi-plugins release 9.1.0 doesn’t have toys 1.9.0',
  )
  const newer = installer({ latest: () => released({ toys: file('1.3.0', '99.0.0') }) })
  await expect(
    newer.installed.install('toys', '1.3.0', agreed(file('1.3.0', '99.0.0'))),
  ).rejects.toThrow('It needs Lumovi 99.0.0.')
  const failed = installer({
    latest: () => ({ failure: { check: 'signed' } satisfies StoreFailure }),
  })
  await expect(failed.installed.install('toys', '1.3.0', '')).rejects.toThrow(
    'Couldn’t check for newer plugins: the release isn’t signed by Lumovi-plugins’ release workflow',
  )
  await expect(made.installed.install('../toys', '1.3.0', '')).rejects.toThrow(
    'isn’t a plugin’s name and version',
  )
  expect(readdirSync(made.dir)).toEqual([])
  expect(made.records()).toEqual({})
})

test('the policy refuses what it doesn’t allow, saying which, at install and at every read', async () => {
  const withSecret = file('1.3.0', '1.0.0', SECRET + LOGS)
  const made = installer({ latest: () => released({ toys: withSecret }, 'box.then(() => {})\n') })
  const policies: [Partial<ManagedSettings>, string][] = [
    [{ pluginSecretsOff: true }, 'doesn’t let plugins show what’s in Secrets'],
    [
      { pluginLogsOff: true },
      'doesn’t let plugins show or read containers’ logs, and this one would',
    ],
    [{ pluginCodeOff: true }, 'doesn’t let plugins run code'],
    [{ pluginsAllowed: ['toys@1.2.0'] }, 'doesn’t allow this version'],
  ]
  for (const [said, why] of policies) {
    made.policy(said)
    await expect(made.installed.install('toys', '1.3.0', agreed(withSecret, true))).rejects.toThrow(
      why,
    )
  }
  made.policy({ pluginsAllowed: ['toys@1.3.0'] })
  await made.installed.install('toys', '1.3.0', agreed(withSecret, true))
  expect((await made.installed.read()).plugins).toHaveLength(1)
  // A later policy that doesn't allow it: not used, and said why.
  made.policy({ pluginSecretsOff: true })
  expect(await made.installed.read()).toMatchObject({
    plugins: [],
    notUsed: [{ name: 'toys', version: '1.3.0', why: 'policy' }],
  })
})

test('every read checks each file against what was agreed, and its Lumovi against this one', async () => {
  const made = installer()
  await made.installed.install('toys', '1.3.0', agreed(file('1.3.0')))
  writeFileSync(join(made.dir, 'toys', '1.3.0', 'plugin.yaml'), `${file('1.3.0')}# changed\n`)
  expect(await made.installed.read()).toMatchObject({
    plugins: [],
    notUsed: [{ name: 'toys', why: 'files' }],
  })
  // Installed by a newer Lumovi, read by this older one.
  const later = installer({ latest: () => released({ toys: file('1.3.0', '1.22.0') }) })
  await later.installed.install('toys', '1.3.0', agreed(file('1.3.0', '1.22.0')))
  const older = new InstalledPlugins({
    dir: later.dir,
    records: later.records,
    keep: () => undefined,
    store: { again: async () => ({ failure: 'off' as const }) },
    lumovi: '1.21.0',
    managed: () => undefined,
    builtIn: async () => new Map(),
    audit: { record: () => undefined },
  })
  expect(await older.read()).toMatchObject({
    notUsed: [{ name: 'toys', why: 'lumovi', needs: '1.22.0' }],
  })
})

test('going back: to the copy kept, as shown now, or to Lumovi’s own; one with none of Lumovi’s is removed instead', async () => {
  let latest = released({ toys: file('1.3.0') })
  const made = installer({ latest: () => latest })
  await made.installed.install('toys', '1.3.0', agreed(file('1.3.0')))
  latest = released({ toys: file('1.4.0', '1.0.0', LINKS) })
  await made.installed.install('toys', '1.4.0', agreed(file('1.4.0', '1.0.0', LINKS)))
  await expect(
    made.installed.goBack('toys', 'kept', agreed(file('1.4.0', '1.0.0', LINKS))),
  ).rejects.toThrow('What it asks isn’t what you were shown')
  await made.installed.goBack('toys', 'kept', agreed(file('1.3.0')))
  expect(made.records().toys).toEqual({ current: expect.objectContaining({ version: '1.3.0' }) })
  expect(readdirSync(join(made.dir, 'toys'))).toEqual(['1.3.0'])
  await expect(made.installed.goBack('toys', 'kept')).rejects.toThrow('No version of Toys before')
  await expect(made.installed.remove('toys')).rejects.toThrow('Toys comes with Lumovi')
  await made.installed.goBack('toys', 'lumovi')
  expect(made.records()).toEqual({})
  expect(readdirSync(made.dir)).toEqual([])
  expect(made.audited.map(({ summary }) => summary).slice(-2)).toEqual([
    'Went back to the plugin Toys 1.3.0',
    'Went back to Lumovi’s own Toys',
  ])

  // None of Lumovi's: no going back to it, but Remove.
  const theirs = installer({ builtIn: async () => new Map() })
  await theirs.installed.install('toys', '1.3.0', agreed(file('1.3.0')))
  expect(theirs.audited.at(-1)).toMatchObject({ summary: 'Installed the plugin Toys 1.3.0' })
  await expect(theirs.installed.goBack('toys', 'lumovi')).rejects.toThrow(
    'No Toys comes with this Lumovi.',
  )
  await theirs.installed.remove('toys')
  expect(theirs.records()).toEqual({})
  expect(theirs.audited.at(-1)).toMatchObject({
    action: 'plugin.removed',
    summary: 'Removed the plugin Toys 1.3.0',
  })
})

test('going back to a copy that asks for more needs what the person was shown, in the main process', async () => {
  let latest = released({ toys: file('1.3.0', '1.0.0', LINKS) })
  const made = installer({ latest: () => latest })
  await made.installed.install('toys', '1.3.0', agreed(file('1.3.0', '1.0.0', LINKS)))
  latest = released({ toys: file('1.4.0') })
  await made.installed.install('toys', '1.4.0', agreed(file('1.4.0')))
  const before = JSON.stringify(made.records())
  // Whatever a page sends, or doesn't: nothing it wasn't shown.
  for (const said of [undefined, agreed(file('1.4.0'))]) {
    await expect(made.installed.goBack('toys', 'kept', said)).rejects.toThrow(
      'What it asks isn’t what you were shown. Look at it again.',
    )
  }
  expect(JSON.stringify(made.records())).toBe(before)
  expect(readdirSync(join(made.dir, 'toys')).sort()).toEqual(['1.3.0', '1.4.0'])
  await made.installed.goBack('toys', 'kept', agreed(file('1.3.0', '1.0.0', LINKS)))
  expect(made.records().toys!.current.version).toBe('1.3.0')
})

test('a name that isn’t an installed plugin’s is refused, what every object has among them', async () => {
  const made = installer()
  await made.installed.install('toys', '1.3.0', agreed(file('1.3.0')))
  const before = JSON.stringify(made.records())
  for (const name of [
    'constructor',
    '__proto__',
    'toString',
    'hasOwnProperty',
    '../toys',
    'tinker',
  ]) {
    await expect(made.installed.remove(name)).rejects.toThrow(`${name} isn’t installed.`)
    await expect(made.installed.goBack(name, 'lumovi')).rejects.toThrow(`${name} isn’t installed.`)
  }
  expect(JSON.stringify(made.records())).toBe(before)
  expect(readdirSync(made.dir)).toEqual(['toys'])
})

test('what a person agrees to is every field of a plugin but who it is and what it needs', () => {
  // (Widening this is a review's to see: anything left off what's agreed is listed here.)
  expect(
    Object.entries(PLUGIN_FIELDS)
      .filter(([, is]) => is === 'not-asked')
      .map(([field]) => field)
      .sort(),
  ).toEqual(['name', 'needs', 'source', 'version'])
  const plugin = parsePlugin(file('1.3.0', '1.0.0', LINKS), 'toys.yaml', {
    carriesCode: true,
  }).plugin!
  expect(unsaid(plugin)).toEqual([])
  // A field this Lumovi can't say what it asks: nothing installs it, or goes back to it.
  expect(unsaid({ ...plugin, server: { name: 'argocd-server' } } as Plugin)).toEqual(['server'])
})

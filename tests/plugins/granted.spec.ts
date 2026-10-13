/**
 * What a version of a plugin grants against another (src/renderer/src/features/plugins/granted.ts):
 * worked out from what each asks, never from the words, so the store's dialog says exactly what's
 * new and what's gone. And the proposals line, as the Plugins page and the dialog both say it.
 */
import { expect, test } from '@playwright/test'
import { LOGS_LINE, proposesLine } from '../../src/renderer/src/features/plugins/proposes.ts'
import { compared, grantedOf, isEmpty } from '../../src/renderer/src/features/plugins/granted.ts'
import { parsePlugin } from '../../src/shared/plugins.ts'

const plugin = (more: string) =>
  parsePlugin(
    `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: toys }
spec:
  version: 1.0.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
  label: Toys
  kinds: [{ group: example.com, kind: Widget }]
${more}`,
    'toys.yaml',
    { carriesCode: true },
  ).plugin!

const READS = (fields: string) => `  reads: [{ group: '', kind: Pod, fields: [${fields}] }]
  pages: [{ id: overview, title: Overview }]
`

test('what’s new is exactly what it asks that it didn’t: a field, its code; and what’s gone', () => {
  const was = grantedOf(plugin(READS('metadata.name')), false)
  const next = grantedOf(plugin(READS('metadata.name, status.phase')), true)
  const { added, gone, same } = compared(was, next)
  expect(added.asks.reads).toEqual([
    { kind: 'Pod', fields: ['status.phase'], status: false, events: false, usage: false },
  ])
  expect(added.code).toBe(true)
  expect(added.added.pages).toEqual([])
  expect(isEmpty(gone)).toBe(true)
  expect(same.asks.reads).toEqual([
    { kind: 'Pod', fields: ['metadata.name'], status: false, events: false, usage: false },
  ])
  expect(same.added.pages).toEqual([{ id: 'overview', title: 'Overview' }])
  // Back the other way: the field and the code are what it no longer has.
  const back = compared(next, was)
  expect(isEmpty(back.added)).toBe(true)
  expect(back.gone.asks.reads[0]!.fields).toEqual(['status.phase'])
  expect(back.gone.code).toBe(true)
})

test('one that asks the same, whatever else changed, asks nothing new', () => {
  const same = compared(
    grantedOf(plugin(READS('metadata.name')), true),
    grantedOf(plugin(READS('metadata.name')), true),
  )
  expect(isEmpty(same.added)).toBe(true)
  expect(isEmpty(same.gone)).toBe(true)
})

const names = { plural: (kind: string) => `${kind.split('.')[0]}s`, bare: (kind: string) => kind }

test('the proposals line says each verb once, with the kinds that share it', () => {
  expect(
    proposesLine(
      [
        { kind: 'Gadget.example.com', actions: ['patch', 'delete'] },
        { kind: 'Gizmo.example.com', actions: ['delete', 'patch'] },
      ],
      names,
    ),
  ).toBe(
    'Its pages may propose to change and delete Gadgets and Gizmos, each change one you confirm in Lumovi.',
  )
  expect(
    proposesLine(
      [
        { kind: 'Gadget.example.com', actions: ['patch', 'delete'] },
        { kind: 'Gizmo.example.com', actions: ['patch'] },
        { kind: 'Backup.example.com', actions: ['create'] },
      ],
      names,
    ),
  ).toBe(
    'Its pages may propose to change Gadgets and Gizmos, to create Backups, and to delete Gadgets, each change one you confirm in Lumovi.',
  )
})

test('what its pages add and where they link are what it asks too: a new page, a new link', () => {
  const was = grantedOf(plugin(READS('metadata.name')), true)
  const next = grantedOf(
    plugin(`  reads: [{ group: '', kind: Pod, fields: [metadata.name] }]
  pages: [{ id: overview, title: Overview }, { id: history, title: History }]
  links: [logs]
`),
    true,
  )
  const { added } = compared(was, next)
  expect(added.added.pages).toEqual([{ id: 'history', title: 'History' }])
  expect(added.links).toEqual(['logs'])
  expect(isEmpty(compared(next, was).gone)).toBe(false)
})

test('its code reading containers’ logs is more than its pages showing them, and said in red', () => {
  const none = grantedOf(plugin(READS('metadata.name')), true)
  const shown = grantedOf(plugin(`${READS('metadata.name')}  logs: shown\n`), true)
  const read = grantedOf(plugin(`${READS('metadata.name')}  logs: read\n`), true)
  // Shown, then read: new. Nothing, then read: new. Read, then shown: nothing new, and it's gone.
  expect(compared(shown, read).added.logs).toBe('read')
  expect(compared(none, read).added.logs).toBe('read')
  expect(isEmpty(compared(read, shown).added)).toBe(true)
  expect(compared(read, shown).gone.logs).toBe('read')
  // Its words: docs' red line, with how much under it; shown, its quiet line, never red. (The
  // store's dialog draws them: plugin-install.spec.ts.)
  expect(LOGS_LINE).toEqual({
    shown: { text: 'It shows containers’ logs: Lumovi reads them, and its code never sees them.' },
    read: {
      text: 'Its code reads containers’ logs: what they print, which can hold tokens and personal data, reaches its code.',
      note: 'Of pods its page shows, one container at a time: at most its last 500 lines or hour, as you, within your access.',
      red: true,
    },
  })
})

test('its tool’s server is asked too: all of it where it’s new or elsewhere, else the paths it adds', () => {
  const server = (where: string, ...paths: string[]) =>
    grantedOf(
      plugin(`  pages: [{ id: overview, title: Overview }]
  server: { service: { name: ${where} }, in: { group: example.com, kind: Widget }, port: http, paths: [${paths.join(', ')}] }
`),
      true,
    )
  const none = grantedOf(plugin('  pages: [{ id: overview, title: Overview }]\n'), true)
  const one = server('toys-api', '/status')
  const two = server('toys-api', '/status', '/targets')
  // None before: all of it.
  expect(compared(none, one).added.server).toEqual(one.server)
  // A path more: that path, of the same Service.
  expect(compared(one, two).added.server).toEqual({ ...two.server, paths: ['/targets'] })
  expect(isEmpty(compared(one, two).gone)).toBe(true)
  // A path less: no longer, and nothing new.
  expect(compared(two, one).gone.server).toEqual({ ...two.server, paths: ['/targets'] })
  expect(isEmpty(compared(two, one).added)).toBe(true)
  // Another Service: all of it is new, and what it asked before is gone.
  const other = server('other-api', '/status')
  expect(compared(one, other).added.server).toEqual(other.server)
  expect(compared(one, other).gone.server).toEqual(one.server)
  // The same: nothing new.
  expect(isEmpty(compared(two, two).added)).toBe(true)
  expect(compared(two, two).same.server).toEqual(two.server)
})

test('showing containers’ logs is asked too: new where it didn’t, no longer where it doesn’t', () => {
  const was = grantedOf(plugin(READS('metadata.name')), true)
  const next = grantedOf(plugin(`${READS('metadata.name')}  logs: shown\n`), true)
  const { added, gone, same } = compared(was, next)
  expect(added.logs).toBe('shown')
  expect(isEmpty(added)).toBe(false)
  expect(isEmpty(gone)).toBe(true)
  expect(same.logs).toBeUndefined()
  const back = compared(next, was)
  expect(back.gone.logs).toBe('shown')
  expect(isEmpty(back.added)).toBe(true)
  // As before, where both show them.
  expect(compared(next, next).same.logs).toBe('shown')
  expect(isEmpty(compared(next, next).added)).toBe(true)
})

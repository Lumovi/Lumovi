/**
 * What a Secret's part on a plugin's page is drawn from (src/renderer/src/plugins/secret-part.ts):
 * its Secret only where Lumovi knows whose page it is and what its code was handed with, since a
 * press's read names both. Without either, no Secret is drawn at all, so nothing can be read.
 */
import { expect, test } from '@playwright/test'
import { secretPart } from '../../src/renderer/src/plugins/secret-part.ts'

const SECRET = {
  namespace: 'default',
  name: 'widget-keys',
  keys: ['password', 'note'],
  namedBy: { kind: 'Widget.example.com', name: 'keyed', path: 'spec.secretName' },
}
const PROPS = { title: { their: 'Widget keys' }, secret: SECRET, keys: [{ their: 'password' }] }
const BY = { plugin: 'toys', name: 'Toys', version: '1.2.0' }
const CODE = { digest: 'sha256:aa', codeDigest: 'sha256:bb' }

test('a Secret’s part is drawn with its Secret, and read for its plugin, where Lumovi knows the page’s hand-over', () => {
  expect(secretPart(PROPS, BY, CODE)).toEqual({
    shown: { title: 'Widget keys', secret: SECRET, keys: ['password'] },
    via: { plugin: 'toys', digest: 'sha256:aa', codeDigest: 'sha256:bb' },
  })
  // (No `keys`: all the file's.)
  expect(secretPart({ title: PROPS.title, secret: SECRET }, BY, CODE).shown).toEqual({
    title: 'Widget keys',
    secret: SECRET,
  })
})

test('without whose page it is, or what its code was handed with, it’s drawn with no Secret: nothing is read as the person’s own', () => {
  const none = { shown: { title: 'Widget keys', keys: ['password'] } }
  expect(secretPart(PROPS, BY, undefined)).toEqual(none)
  expect(secretPart(PROPS, undefined, CODE)).toEqual(none)
  expect(secretPart(PROPS, undefined, undefined)).toEqual(none)
  // (Digests that say nothing are no hand-over either, and a name that says nothing no plugin.)
  expect(secretPart(PROPS, BY, { digest: '', codeDigest: '' })).toEqual(none)
  expect(secretPart(PROPS, BY, { digest: 'sha256:aa', codeDigest: '' })).toEqual(none)
  expect(secretPart(PROPS, BY, { digest: '', codeDigest: 'sha256:bb' })).toEqual(none)
  expect(secretPart(PROPS, { ...BY, plugin: '' }, CODE)).toEqual(none)
  // A token the page didn't hold left no Secret already: the same, with a hand-over.
  expect(secretPart({ title: PROPS.title }, BY, CODE)).toEqual({
    shown: { title: 'Widget keys' },
    via: { plugin: 'toys', digest: 'sha256:aa', codeDigest: 'sha256:bb' },
  })
})

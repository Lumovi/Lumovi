/**
 * What a list says it's of (src/shared/resources.ts's listNoun): one rule for Lumovi's own lists
 * and a plugin's, so the same list is never said two ways.
 */
import { expect, test } from '../temp-folders.ts'
import { listNoun } from '../../src/shared/resources.ts'

test('a built-in kind’s list is said in lower case, any other as it’s written', () => {
  expect(listNoun('Pods', true)).toBe('pods')
  expect(listNoun('Applications', false)).toBe('Applications')
})

test('a list nothing says more of is said by its label: as Lumovi’s own list where it’s one’s', () => {
  // A plugin's list called as one of Lumovi's is said as that list.
  expect(listNoun('Pods')).toBe('pods')
  expect(listNoun('Volume Claims')).toBe('volume claims')
  // Any other, as its plugin wrote it: Argo CD's Applications, as the Application kind's own list.
  expect(listNoun('Applications')).toBe('Applications')
  expect(listNoun('NodePools')).toBe('NodePools')
})

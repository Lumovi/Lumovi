/** What a plugin's header is measured by, read back: each of its texts whole, whatever's in it. */
import { expect, test } from '../temp-folders.ts'
import { fitKey, fromFitKey } from '../../src/renderer/src/kit/fit-key.ts'

test('a header’s fit key reads back each name whole, a line’s end and all', () => {
  const name = 'payments\nprimary'
  const labels = ['Show logs', 'Sync\n…', 'Delete…', '']
  expect(fromFitKey(fitKey(name, 'Out of sync', labels))).toEqual({
    name,
    word: 'Out of sync',
    labels,
  })
  // (Two headers differing only where a line ends are told apart.)
  expect(fitKey('a\nb', '', ['c'])).not.toBe(fitKey('a', 'b', ['c']))
})

/**
 * What Lumovi says where a plugin's page ended: a sentence for every way it ends, and a plugin's
 * own words shown as text that can't pass for Lumovi's.
 */
import { expect, test } from '@playwright/test'
import { inPieces } from '../../src/shared/kit/characters.ts'
import { endedWords, SAID_AT_MOST, type PageEnd } from '../../src/shared/plugin-ended.ts'

const STILL =
  'The rest of Lumovi is as it was, and stopping the page changed nothing in your cluster.'

test('every way a page ends has its sentence, and says nothing else changed', () => {
  const stopped: [PageEnd['why'], string, boolean][] = [
    ['memory', 'It was using more memory than a plugin may.', true],
    ['processor', 'Over the last half minute it used more than half of a processor core.', true],
    ['shared', 'It wasn’t running apart from the rest, as a plugin must.', false],
    ['silent', 'It had stopped answering.', false],
    ['too-much', 'It sent more at once than a plugin may.', false],
    ['not-allowed', 'It sent something a plugin can’t.', false],
  ]
  for (const [why, sentence, advised] of stopped) {
    const words = endedWords('Karpenter', { why } as PageEnd)
    expect(words).toMatchObject({
      title: 'Lumovi stopped Karpenter’s page.',
      why: sentence,
      still: STILL,
      again: true,
    })
    expect(words.said, why).toBeUndefined()
    expect(words.advice !== undefined, why).toBe(advised)
  }
})

test('a page that failed by itself says so in its plugin’s words, and one with none says none', () => {
  expect(endedWords('Karpenter', { why: 'failed', said: 'x is not a function' })).toEqual({
    title: 'Karpenter’s page stopped by itself.',
    said: ['x is not a function'],
    still: STILL,
    again: true,
  })
  expect(endedWords('Karpenter', { why: 'failed', said: '   ' })).toEqual({
    title: 'Karpenter’s page stopped by itself.',
    still: STILL,
    again: true,
  })
})

test('a page that couldn’t start offers no opening again, and says only what’s true of it', () => {
  expect(endedWords('Karpenter', { why: 'no-box' })).toEqual({
    title: 'Karpenter’s page couldn’t start.',
    why: 'Lumovi couldn’t open the place a plugin’s code runs in.',
    still: 'The rest of Lumovi is as it was.',
    again: false,
  })
})

test('a name ending in s takes the apostrophe alone', () => {
  expect(endedWords('Argo Workflows', { why: 'silent' }).title).toBe(
    'Lumovi stopped Argo Workflows’ page.',
  )
  expect(endedWords('Argo Workflows', { why: 'no-box' }).title).toBe(
    'Argo Workflows’ page couldn’t start.',
  )
})

test('a fault of Lumovi’s own is said as that, with no word of stopping', () => {
  expect(endedWords('Karpenter', { why: 'drawing' })).toEqual({
    title: 'Lumovi couldn’t draw Karpenter’s page.',
    why: 'That’s a fault in Lumovi, not in the plugin.',
    still: 'The rest of Lumovi is as it was.',
    advice: 'If it happens again, tell us.',
    again: true,
  })
})

test('a plugin’s own words come in pieces: its text as it is, what can’t be seen as a mark of Lumovi’s', () => {
  const u = (unseen: string) => ({ unseen })
  const said = (text: string) => inPieces(text, SAID_AT_MOST)
  expect(said('plain words, é and 日本 and 🙂')).toEqual(['plain words, é and 日本 and 🙂'])
  // The mark's own spelling, typed by a plugin, is its text and nothing more.
  expect(said('<U+200B> U+200B')).toEqual(['<U+200B> U+200B'])
  expect(said('a\u200Bb')).toEqual(['a', u('U+200B'), 'b'])
  expect(said('a\u0000\u001b\u007f')).toEqual(['a', u('U+0000'), u('U+001B'), u('U+007F')])
  // What turns the direction of text, or hides in it.
  expect(said('safe\u202Egnp.exe')).toEqual(['safe', u('U+202E'), 'gnp.exe'])
  expect(said('\u2066a\u2069\u2060\uFEFF\u00AD')).toEqual([
    u('U+2066'),
    'a',
    u('U+2069'),
    u('U+2060'),
    u('U+FEFF'),
    u('U+00AD'),
  ])
  // Spaces that aren't the plain one, a tab, letters drawn as nothing.
  expect(said('a\u00A0b\u3000c\td\u3164')).toEqual([
    'a',
    u('U+00A0'),
    'b',
    u('U+3000'),
    'c',
    u('U+0009'),
    'd',
    u('U+3164'),
  ])
  // Half of a pair, a code point of nobody's, one that isn't assigned.
  expect(said('a\uD83Db\uE000c\uFFFFd')).toEqual([
    'a',
    u('U+D83D'),
    'b',
    u('U+E000'),
    'c',
    u('U+FFFF'),
    'd',
  ])
  // Lines stay lines, five at most; empty ones and every end past the fifth line are a space.
  expect(said('one\r\ntwo\n\n\n three\u2028four\rfive\nsix\nseven\n')).toEqual([
    'one\ntwo\nthree\nfour\nfive six seven',
  ])
  expect(said('\n'.repeat(300) + 'a')).toEqual(['a'])
  expect(
    said('a' + '\n.'.repeat(300))
      .join('')
      .split('\n'),
  ).toHaveLength(5)
  // Cut by characters, never through a pair; and each mark counts as the one character it stands for.
  expect(said('🙂'.repeat(SAID_AT_MOST + 5))).toEqual(['🙂'.repeat(SAID_AT_MOST)])
  expect(said('\u200B'.repeat(500))).toHaveLength(SAID_AT_MOST)
  expect(said(5 as unknown as string)).toEqual(['5'])
  expect(said('   ')).toEqual([])
})

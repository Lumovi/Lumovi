/**
 * What Lumovi says where a plugin's page ended: a sentence for every way it ends, and a plugin's
 * own words shown as text that can't pass for Lumovi's.
 */
import { expect, test } from '@playwright/test'
import {
  codePoint,
  inPieces,
  MARKS_AT_MOST,
  quotedBack,
  shortInPieces,
  spelled,
} from '../../src/shared/kit/characters.ts'
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

const u = (unseen: string) => ({ unseen })

test('a text that isn’t Lumovi’s comes in pieces: text as written, and marks for what would act', () => {
  // Text, drawn as written: every script and emoji, every space, what writing is joined and
  // broken with, the weak direction marks, a code point with no glyph.
  for (const text of [
    'plain words, é and 日本 and 🙂 and ❤️',
    '<U+200B> U+202E',
    '👨‍👩‍👧 🏳️‍🌈',
    'می‌خواهم',
    'क्‍ष',
    'super­califragilistic',
    '﻿name',
    'שלום 123 ‏!',
    'a​b⁠c͏d‎e؜f',
    'a b c d e f　g',
    'a\tb',
    'e' + '́'.repeat(60),
    'x�y\u{E01EF}͸',
  ])
    expect(inPieces(text), JSON.stringify(text)).toEqual([text])
  // A line's end is one, however it was written, and never a mark.
  expect(inPieces('a\r\nb\rc\u0085d e f\n')).toEqual(['a\nb\nc\nd\ne\nf\n'])
  // What turns text round is a mark, and what follows it isn't turned.
  expect(inPieces('abc‮def')).toEqual(['abc', u('U+202E'), 'def'])
  for (const turning of ['‪', '‫', '‬', '‭', '⁦', '⁧', '⁨', '⁩'])
    expect(inPieces(`a${turning}b`)).toEqual(['a', u(codePoint(turning)), 'b'])
  // Controls; an escape sequence as one mark, and an escape that starts none alone.
  expect(inPieces('x\u0000y\u0007\u007f\u0080\u009f\u000b')).toEqual([
    'x',
    u('U+0000'),
    'y',
    u('U+0007'),
    u('U+007F'),
    u('U+0080'),
    u('U+009F'),
    u('U+000B'),
  ])
  expect(inPieces('\u001b[31mfailed\u001b[0m')).toEqual([u('U+001B'), 'failed', u('U+001B')])
  expect(inPieces('\u001b[38;5;196mred\u001bO \u001b[' + '1'.repeat(17) + 'm')).toEqual([
    u('U+001B'),
    'red',
    u('U+001B'),
    'O ',
    u('U+001B'),
    '[' + '1'.repeat(17) + 'm',
  ])
  // The other format characters, tags, blank letters, the object's placeholder.
  for (const marked of [
    '᠎',
    '⁪',
    '￹',
    '￻',
    '￼',
    '\u{1D173}',
    '\u{E0001}',
    '\u{E0067}',
    '\u{E007F}',
    'ᅟ',
    'ᅠ',
    'ㅤ',
    'ﾠ',
  ])
    expect(inPieces(`a${marked}b`), codePoint(marked)).toEqual(['a', u(codePoint(marked)), 'b'])
  // Private use, noncharacters, half of a pair.
  for (const marked of [
    '',
    '',
    '\u{F0000}',
    '\u{10FFFD}',
    '﷐',
    '￾',
    '￿',
    '\u{1FFFE}',
    '\u{10FFFF}',
    '\uD800',
    '\uDFFF',
  ])
    expect(inPieces(`a${marked}b`), codePoint(marked)).toEqual(['a', u(codePoint(marked)), 'b'])
  // A controller's message, as one comes: taken whole.
  expect(
    inPieces('﻿Reconcile failed:\r\n\u001b[31mError\u001b[0m: admission webhook denied ✋\r\n'),
  ).toEqual([
    '﻿Reconcile failed:\n',
    u('U+001B'),
    'Error',
    u('U+001B'),
    ': admission webhook denied ✋\n',
  ])
  // Twenty marks a text, and then how many more there were.
  const many = inPieces('\u0007'.repeat(4000))
  expect(many).toHaveLength(MARKS_AT_MOST + 1)
  expect(many.at(-1)).toEqual({ more: 3980 })
  expect(inPieces('\u0007'.repeat(MARKS_AT_MOST))).toHaveLength(MARKS_AT_MOST)
  expect(inPieces(5 as unknown as string)).toEqual(['5'])
})

test('where a mark can’t be drawn it’s spelled, by the same rule', () => {
  expect(spelled('abc‮def')).toBe('abc U+202E def')
  expect(spelled('می‌خواهم 👨‍👩‍👧')).toBe('می‌خواهم 👨‍👩‍👧')
  expect(spelled('\u0007'.repeat(4000))).toMatch(/^( U\+0007 ){20} and 3,980 more $/)
  expect(quotedBack('style\n2026 "all well"‮' + 'x'.repeat(500))).toBe(
    '"style 2026 \\"all well\\" U+202E xxxxxxxxxxxxxxxxxx…"',
  )
})

test('a plugin’s last words: short, five lines at most, cut by characters', () => {
  const said = (text: string) => shortInPieces(text, SAID_AT_MOST, 5)
  // Lines stay lines, five at most; empty ones and every end past the fifth line are a space.
  expect(said('one\r\ntwo\n\n\n three four\rfive\nsix\nseven\n')).toEqual([
    'one\ntwo\nthree\nfour\nfive six seven',
  ])
  expect(said('\n'.repeat(300) + 'a')).toEqual(['a'])
  expect(
    said('a' + '\n.'.repeat(300))
      .join('')
      .split('\n'),
  ).toHaveLength(5)
  expect(said('a‮b')).toEqual(['a', u('U+202E'), 'b'])
  // Cut by characters, never through a pair.
  expect(said('🙂'.repeat(SAID_AT_MOST + 5))).toEqual(['🙂'.repeat(SAID_AT_MOST)])
  expect(said('\u0007'.repeat(500))).toHaveLength(MARKS_AT_MOST + 1)
  expect(said('   ')).toEqual([])
})

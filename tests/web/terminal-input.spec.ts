/**
 * What a terminal sends its shell while the shell is still being opened: kept, and sent once
 * it's open. (A shell may ask the terminal something as it starts and wait for the answer.)
 */
import { expect, test } from '@playwright/test'
import { ShellInput } from '../../src/renderer/src/features/terminal/input.ts'

test('an answer given while the shell is being opened reaches it once it’s open: once, in order', () => {
  const sent: string[] = []
  const input = new ShellInput((data) => sent.push(data))
  input.take('\u001b[1;1R')
  input.take('\u001b[?1;2c')
  expect(sent).toEqual([])
  input.opened()
  expect(sent).toEqual(['\u001b[1;1R', '\u001b[?1;2c'])
  // Once: opening again sends nothing again; and from then on it's sent as it comes.
  input.opened()
  input.take('ls\r')
  expect(sent).toEqual(['\u001b[1;1R', '\u001b[?1;2c', 'ls\r'])
})

test('a shell that never opened, or has ended, is sent nothing', () => {
  const sent: string[] = []
  const failed = new ShellInput((data) => sent.push(data))
  failed.take('\u001b[1;1R')
  failed.over()
  failed.opened()
  failed.take('a')
  const ended = new ShellInput((data) => sent.push(data))
  ended.opened()
  ended.over()
  ended.take('a')
  expect(sent).toEqual([])
})

test('what’s kept is bounded, and never has a gap: once something doesn’t fit, nothing after it is kept', () => {
  const sent: string[] = []
  const input = new ShellInput((data) => sent.push(data))
  input.take('\u001b[1;1R')
  input.take('kubectl get pods')
  // A paste too long to keep, then a key: neither is sent, or the key would run alone.
  input.take('x'.repeat(5000))
  input.take(' --all-namespaces')
  input.take('\r')
  input.opened()
  expect(sent).toEqual(['\u001b[1;1R', 'kubectl get pods'])
  // What's typed once it's open is sent as ever.
  input.take('\r')
  expect(sent.at(-1)).toBe('\r')

  // Up to the bound exactly, everything; the first piece past it, and all after, nothing.
  const full: string[] = []
  const other = new ShellInput((data) => full.push(data))
  other.take('a'.repeat(4096))
  other.take('b')
  other.opened()
  expect(full).toEqual(['a'.repeat(4096)])
})

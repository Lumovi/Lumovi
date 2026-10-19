/**
 * A terminal's running shell on its way to a window of its own (src/main/windows.ts): held for
 * the new window's page until it asks for its tab. Windows and pages here are stand-ins, with
 * only what Windows uses of them.
 */
import { EventEmitter } from 'node:events'
import { expect, test } from '../temp-folders.ts'
import type { BrowserWindow, WebContents } from 'electron'
import { Windows } from '../../src/main/windows.ts'

let ids = 0

/** A page: what it's been sent, in order. */
function page() {
  const sent: unknown[][] = []
  const contents = {
    id: ++ids,
    sent,
    send: (...args: unknown[]) => sent.push(args),
    isDestroyed: () => false,
  }
  return contents as unknown as WebContents & { sent: unknown[][] }
}

/** A window with its page; `close()` closes it, as Electron says it has. */
function window() {
  const events = new EventEmitter()
  const contents = page()
  const win = {
    id: ++ids,
    webContents: contents,
    on: (event: string, listener: () => void) => events.on(event, listener),
    isDestroyed: () => false,
    close: () => events.emit('closed'),
  }
  return win as unknown as BrowserWindow & { webContents: typeof contents; close: () => void }
}

/** A terminal on `from`'s page, moved to a window of its own: the shell's id, and its window. */
function moved(windows: Windows) {
  const from = window()
  const to = window()
  windows.add(from)
  windows.add(to)
  expect(windows.own('shell-1', from.webContents)).toBe(true)
  windows.holdTab(
    to,
    { kind: 'terminal', context: 'demo', shell: { id: 'shell-1', lines: '' } },
    from,
  )
  return { from, to }
}

test('a moved terminal’s window closed before its page asks for it ends the shell: nothing’s left of it', () => {
  const ended: string[][] = []
  const windows = new Windows((ids) => ended.push(ids))
  const { from, to } = moved(windows)
  windows.toOwner('terminal:data', 'shell-1', 'said on the way')
  to.close()
  expect(ended).toEqual([['shell-1']])
  // Nothing of it's left to anyone: the page it came from isn't told, and owns nothing by it.
  windows.toOwner('terminal:data', 'shell-1', 'said after')
  expect(from.webContents.sent).toEqual([])
  expect(windows.release(from.webContents)).toEqual([])
})

test('a moved terminal’s window closed after its page took the shell leaves it to that page', () => {
  const ended: string[][] = []
  const windows = new Windows((ids) => ended.push(ids))
  const { to } = moved(windows)
  expect(windows.takeTab(to.webContents).tab).toMatchObject({ shell: { id: 'shell-1' } })
  to.close()
  // (Its page's own streams end with it there: release, as every page's do.)
  expect(ended).toEqual([])
  expect(windows.release(to.webContents)).toEqual(['shell-1'])
})

test('past the most held for a page that isn’t listening yet, the oldest go: the shell’s exit is always there', () => {
  const windows = new Windows()
  const { to } = moved(windows)
  for (let i = 0; i < 6_000; i++) windows.toOwner('terminal:data', 'shell-1', `${i}\r\n`)
  windows.toOwner('terminal:exit', 'shell-1', { code: 0 })
  windows.takeTab(to.webContents)
  windows.adopt('shell-1', to.webContents)
  const sent = to.webContents.sent
  expect(sent).toHaveLength(5_000)
  expect(sent.at(-1)).toEqual(['terminal:exit', 'shell-1', { code: 0 }])
  // What came last before it, with nothing missing at the end.
  expect(sent.at(-2)).toEqual(['terminal:data', 'shell-1', '5999\r\n'])
  expect(sent[0]).toEqual(['terminal:data', 'shell-1', '1001\r\n'])
})

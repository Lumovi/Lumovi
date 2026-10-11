// Preloaded into the app's main process by the e2e tests (and the screenshot
// script), so they can run while you use the computer:
//
// - Copying goes to a clipboard of the page's own (window.__clipboard), never
//   to yours.
// - Windows are shown without taking focus, invisible and click-through, and
//   on macOS the app stays out of the Dock and ⌘-Tab. Playwright drives pages
//   over the DevTools protocol, so that changes nothing the tests see.
//   LUMOVI_E2E_FOREGROUND=1 shows them as usual. Where nobody's watching
//   (CI, npm run test:linux), LUMOVI_E2E_OPAQUE=1 draws them, still
//   click-through: Linux and Windows treat a fully transparent window as not
//   drawn, and render it slowly (macOS renders transparent ones faster).
// - electron-updater is a stand-in the tests drive (globalThis.__updater):
//   nothing is looked up or downloaded.
// -r loads CommonJS.
/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow, session } = require('electron')
const Module = require('node:module')
const { EventEmitter } = require('node:events')
/* eslint-enable @typescript-eslint/no-require-imports */

const updater = Object.assign(new EventEmitter(), {
  checks: 0,
  installs: 0,
  // What a check resolves to: null when the app can't update itself.
  result: {},
  checkForUpdates() {
    this.checks++
    return Promise.resolve(this.result)
  },
  quitAndInstall() {
    this.installs++
  },
})
// Its own session, as electron-updater's: asked for once the app is ready (Object.assign
// would ask as it copies).
Object.defineProperty(updater, 'netSession', {
  get: () => session.fromPartition('electron-updater'),
})
globalThis.__updater = updater
// Every terminal's pty is counted (globalThis.__ptys): when it was started, when its first
// output came and how much came in all. A failure's diagnostics say it, beside what the page
// was handed (window.__terminalHeard) and what the page sent back (globalThis.__terminalSent),
// to tell where a terminal's output stopped.
//
// node-pty's own exports are changed, in place and before the app loads it: the app's main
// process is an ES module, and what it imports never passes through the hook below (which sees
// only what's loaded with require), but it does get this same object's `spawn`.
globalThis.__ptys = []
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodePty = require('node-pty')
const spawnPty = nodePty.spawn
nodePty.spawn = function spawn(file, ...rest) {
  const made = spawnPty.call(this, file, ...rest)
  const entry = {
    pid: made.pid,
    file,
    started: Date.now(),
    first: null,
    characters: 0,
    ended: null,
  }
  globalThis.__ptys.push(entry)
  made.onData((data) => {
    entry.first ??= Date.now()
    entry.characters += data.length
  })
  made.onExit(() => (entry.ended = Date.now()))
  return made
}
// What the page sent each terminal's shell: how much, and the first of what begins with an
// escape, which is the terminal's own answer to something the shell (or its console) asked as
// it started, or a test's own arrow or function key. No person types into a test's terminal.
globalThis.__terminalSent = {}
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('electron').ipcMain.on('terminal:input', (_event, id, data) => {
  if (typeof id !== 'string' || typeof data !== 'string') return
  const sent = (globalThis.__terminalSent[id] ??= { characters: 0, beganWithAnEscape: [] })
  sent.characters += data.length
  if (data.startsWith('\u001b') && sent.beganWithAnEscape.length < 8)
    sent.beganWithAnEscape.push(data.slice(0, 32))
})
const load = Module._load
Module._load = function (request, ...rest) {
  if (request === 'electron-updater') return { autoUpdater: updater }
  return load.call(this, request, ...rest)
}

const CLIPBOARD = `
  window.__clipboard = ''
  navigator.clipboard.writeText = async (text) => { window.__clipboard = String(text) }
  navigator.clipboard.readText = async () => window.__clipboard
`
// What the page is handed of each terminal's output: how much, when the first came, and its
// first 512 characters (a shell's opening lines: whether it asked the terminal anything).
const TERMINALS = `
  window.__terminalHeard = {}
  window.lumovi?.terminal?.onData((id, data) => {
    const heard = (window.__terminalHeard[id] ??= { first: Date.now(), characters: 0, start: '' })
    heard.characters += String(data).length
    if (heard.start.length < 512) heard.start = (heard.start + data).slice(0, 512)
  })
`
app.on('web-contents-created', (_event, contents) => {
  contents.on('dom-ready', () => {
    void contents.executeJavaScript(CLIPBOARD)
    void contents.executeJavaScript(TERMINALS).catch(() => undefined)
  })
})

if (!process.env.LUMOVI_E2E_FOREGROUND) {
  BrowserWindow.prototype.show = function show() {
    if (!process.env.LUMOVI_E2E_OPAQUE) this.setOpacity(0)
    this.setIgnoreMouseEvents(true)
    this.showInactive()
  }
  BrowserWindow.prototype.focus = function focus() {}
  if (process.platform === 'darwin') {
    app.setActivationPolicy('accessory')
    app.dock?.hide()
  }
}

// System notifications (a change an AI assistant asks for, while the window isn't focused) are
// kept for the tests (globalThis.__notifications), never shown.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Notification } = require('electron')
globalThis.__notifications = []
Notification.prototype.show = function show() {
  globalThis.__notifications.push(this)
}

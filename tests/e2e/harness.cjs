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
const load = Module._load
Module._load = function (request, ...rest) {
  return request === 'electron-updater'
    ? { autoUpdater: updater }
    : load.call(this, request, ...rest)
}

const CLIPBOARD = `
  window.__clipboard = ''
  navigator.clipboard.writeText = async (text) => { window.__clipboard = String(text) }
  navigator.clipboard.readText = async () => window.__clipboard
`
app.on('web-contents-created', (_event, contents) => {
  contents.on('dom-ready', () => void contents.executeJavaScript(CLIPBOARD))
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

// Preloaded into the app's main process by the e2e tests, so they can run while
// you use the computer: windows are shown without taking focus, invisible and
// click-through, and on macOS the app stays out of the Dock and ⌘-Tab.
// Playwright drives pages over the DevTools protocol, so none of that changes
// what the tests see. KUBESTACKS_E2E_FOREGROUND=1 shows them as usual.
// -r loads CommonJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { app, BrowserWindow } = require('electron')

BrowserWindow.prototype.show = function show() {
  this.setOpacity(0)
  this.setIgnoreMouseEvents(true)
  this.showInactive()
}
BrowserWindow.prototype.focus = function focus() {}

if (process.platform === 'darwin') {
  app.setActivationPolicy('accessory')
  app.dock?.hide()
}

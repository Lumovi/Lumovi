// Preloaded into the app's main process by the e2e tests (and the screenshot
// script), so they can run while you use the computer:
//
// - Copying goes to a clipboard of the page's own (window.__clipboard), never
//   to yours.
// - Windows are shown without taking focus, invisible and click-through, and
//   on macOS the app stays out of the Dock and ⌘-Tab. Playwright drives pages
//   over the DevTools protocol, so that changes nothing the tests see.
//   KUBESTACKS_E2E_FOREGROUND=1 shows them as usual. Where nobody's watching
//   (CI, npm run test:linux), KUBESTACKS_E2E_OPAQUE=1 draws them, still
//   click-through: Linux and Windows treat a fully transparent window as not
//   drawn, and render it slowly (macOS renders transparent ones faster).
// -r loads CommonJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { app, BrowserWindow } = require('electron')

const CLIPBOARD = `
  window.__clipboard = ''
  navigator.clipboard.writeText = async (text) => { window.__clipboard = String(text) }
  navigator.clipboard.readText = async () => window.__clipboard
`
app.on('web-contents-created', (_event, contents) => {
  contents.on('dom-ready', () => void contents.executeJavaScript(CLIPBOARD))
})

if (!process.env.KUBESTACKS_E2E_FOREGROUND) {
  BrowserWindow.prototype.show = function show() {
    if (!process.env.KUBESTACKS_E2E_OPAQUE) this.setOpacity(0)
    this.setIgnoreMouseEvents(true)
    this.showInactive()
  }
  BrowserWindow.prototype.focus = function focus() {}
  if (process.platform === 'darwin') {
    app.setActivationPolicy('accessory')
    app.dock?.hide()
  }
}

// Renders build/icon.svg to the PNGs electron-builder derives the app icons from.
// Run with: npx electron scripts/render-icon.mjs
//
// - build/icon.png: the whole canvas, with the margin macOS icons keep around their
//   shape (also used on Linux).
// - build/icon-win.png: just the rounded square, as Windows icons fill their space.
import { readFileSync, writeFileSync } from 'node:fs'
import { app, BrowserWindow } from 'electron'

const SIZE = 1024
/** The rounded square in icon.svg's 1024×1024 canvas. */
const SHAPE = { x: 100, y: 100, size: 824 }

app.disableHardwareAcceleration()
app
  .whenReady()
  .then(async () => {
    const win = new BrowserWindow({
      width: SIZE,
      height: SIZE,
      show: false,
      transparent: true,
      frame: false,
      useContentSize: true,
      webPreferences: { offscreen: true, zoomFactor: 1 },
    })
    const render = async (svg, file) => {
      const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      await new Promise((resolve) => setTimeout(resolve, 500))
      const image = (await win.webContents.capturePage()).resize({
        width: SIZE,
        height: SIZE,
        quality: 'best',
      })
      writeFileSync(file, image.toPNG())
      console.log(file, image.getSize())
    }
    const svg = readFileSync('build/icon.svg', 'utf8')
    await render(svg, 'build/icon.png')
    const box = `${SHAPE.x} ${SHAPE.y} ${SHAPE.size} ${SHAPE.size}`
    await render(svg.replace('viewBox="0 0 1024 1024"', `viewBox="${box}"`), 'build/icon-win.png')
    app.quit()
  })
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })

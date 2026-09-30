// Renders build/icon.svg to build/icon.png (1024×1024), from which electron-builder
// derives the macOS, Windows and Linux icons. Run with: npx electron scripts/render-icon.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { app, BrowserWindow } from 'electron'

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    transparent: true,
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: true, zoomFactor: 1 },
  })
  const svg = readFileSync('build/icon.svg', 'utf8')
  const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  await new Promise((resolve) => setTimeout(resolve, 500))
  const image = (await win.webContents.capturePage()).resize({
    width: 1024,
    height: 1024,
    quality: 'best',
  })
  writeFileSync('build/icon.png', image.toPNG())
  console.log('build/icon.png', image.getSize())
  app.quit()
})

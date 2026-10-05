// Preloaded into the app's main process for screenshots, after tests/e2e/harness.cjs.
// How long a cluster takes to answer is measured, so it'd differ from one screenshot to
// the next: each cluster is shown answering in a steady time instead.
// -r loads CommonJS.
/* eslint-disable @typescript-eslint/no-require-imports */
const { app, ipcMain } = require('electron')
/* eslint-enable @typescript-eslint/no-require-imports */

const LATENCY_MS = { production: 18, staging: 9, 'load-test': 24 }

const handle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) =>
  handle(channel, async (event, ...args) => {
    const result = await listener(event, ...args)
    if (channel !== 'kube:version' || !result?.ok) return result
    return { ...result, data: { ...result.data, latencyMs: LATENCY_MS[args[0]] ?? 12 } }
  })

// A change an AI assistant asks for expires five minutes after it's asked, by this process's
// clock; the page's is stopped (at LUMOVI_SCREENSHOT_EPOCH), so the page is given the time
// it has left from then.
const epoch = Number(process.env.LUMOVI_SCREENSHOT_EPOCH)
const fromEpoch = (proposal) => ({
  ...proposal,
  expiresAt: epoch + proposal.expiresAt - Date.now(),
})
const answer = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) =>
  answer(channel, async (event, ...args) => {
    const result = await listener(event, ...args)
    return channel === 'assistants:pending' ? result.map(fromEpoch) : result
  })
app.on('web-contents-created', (_event, contents) => {
  const send = contents.send.bind(contents)
  contents.send = (channel, ...args) =>
    send(channel, ...(channel === 'assistants:proposal' ? [fromEpoch(args[0])] : args))
})

// Preloaded into the app's main process for screenshots, after tests/e2e/harness.cjs.
// How long a cluster takes to answer is measured, so it'd differ from one screenshot to
// the next: each cluster is shown answering in a steady time instead.
// -r loads CommonJS.
/* eslint-disable @typescript-eslint/no-require-imports */
const { ipcMain } = require('electron')
/* eslint-enable @typescript-eslint/no-require-imports */

const LATENCY_MS = { production: 18, staging: 9, 'load-test': 24 }

const handle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) =>
  handle(channel, async (event, ...args) => {
    const result = await listener(event, ...args)
    if (channel !== 'kube:version' || !result?.ok) return result
    return { ...result, data: { ...result.data, latencyMs: LATENCY_MS[args[0]] ?? 12 } }
  })

// Preloaded into the screenshots' audit server: its clock starts at LUMOVI_SCREENSHOT_EPOCH
// (where the page's is stopped) and runs on from there, so what it records is when the page
// says it is. Its timers aren't touched.
//
// It runs on a minute at a time, and the ids it makes count up: what the server records as it
// starts is the audit log's newest event, whose hash a screenshot shows, and with the moment
// and an id of its own it'd be another hash each time.
const MINUTE = 60_000
const offset = Number(process.env.LUMOVI_SCREENSHOT_EPOCH) - Date.now()
const RealDate = Date
const now = () => Math.floor((RealDate.now() + offset) / MINUTE) * MINUTE
globalThis.Date = class extends RealDate {
  constructor(...args) {
    super(...(args.length === 0 ? [now()] : args))
  }

  static now() {
    return now()
  }
}

/* eslint-disable @typescript-eslint/no-require-imports */
const crypto = require('node:crypto')
const { syncBuiltinESMExports } = require('node:module')
/* eslint-enable @typescript-eslint/no-require-imports */
let ids = 0
crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`
syncBuiltinESMExports()

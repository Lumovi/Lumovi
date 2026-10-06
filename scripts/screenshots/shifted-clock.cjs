// Preloaded into the screenshots' audit server: its clock starts at LUMOVI_SCREENSHOT_EPOCH
// (where the page's is stopped) and runs on from there, so what it records is when the page
// says it is. Its timers aren't touched.
const offset = Number(process.env.LUMOVI_SCREENSHOT_EPOCH) - Date.now()
const RealDate = Date
globalThis.Date = class extends RealDate {
  constructor(...args) {
    super(...(args.length === 0 ? [RealDate.now() + offset] : args))
  }

  static now() {
    return RealDate.now() + offset
  }
}

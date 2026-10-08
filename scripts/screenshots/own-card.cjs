// Preloaded into the app's main process and the server for screenshots: Lumovi's own sponsor
// card, whatever Lumovi/main-sponsor says that day, so the screenshots don't follow it (or change
// a few seconds into a run). Its reads get no answer, as offline; everything else goes through.
const SPONSOR = 'https://raw.githubusercontent.com/Lumovi/main-sponsor/'
const realFetch = globalThis.fetch
globalThis.fetch = (input, init) =>
  String(input instanceof Request ? input.url : input).startsWith(SPONSOR)
    ? Promise.reject(new TypeError('fetch failed'))
    : realFetch(input, init)

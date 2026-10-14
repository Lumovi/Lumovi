/**
 * What Lumovi hands the system to open in a browser: web links alone, plain HTTP only for a port
 * forwarded on this machine; never `file://` or another program's own protocol. The desktop app's
 * main process holds to it, and a page offers a link to open only where it would be opened.
 */
export const opensExternally = (url: unknown): url is string =>
  typeof url === 'string' &&
  (url.startsWith('https://') || /^http:\/\/localhost:\d+(\/|$)/.test(url))

/**
 * The organization's proxy for what Chromium fetches (the updater, in a session of its own),
 * which doesn't go through Node's. Only the policy's: otherwise Chromium keeps the system's
 * settings (a PAC file, say).
 */
import { isIP } from 'node:net'
import type { AuthInfo, Session } from 'electron'

/** Points these sessions at the proxy, but for what NO_PROXY leaves out. */
export async function chromiumProxy(
  proxy: string,
  noProxy: string,
  sessions: Session[],
): Promise<void> {
  const entries = noProxy.split(/[\s,]+/).filter(Boolean)
  if (entries.includes('*')) return
  const url = new URL(proxy)
  const config = {
    proxyRules: `${url.protocol}//${url.host}`,
    // Chromium takes a name as only itself: what's under it, as NO_PROXY has it, by a wildcard.
    proxyBypassRules: entries
      .flatMap((entry) => {
        const name = entry.replace(/^\*?\./, '')
        return isIP(name) || name.startsWith('[') ? [name] : [name, `*.${name}`]
      })
      .join(','),
  }
  await Promise.all(sessions.map((session) => session.setProxy(config)))
}

/**
 * Who goes through the proxy, as its URL says: for that proxy alone, when it asks; nothing
 * for anything else that does (a site, another proxy).
 */
export function proxyCredentials(proxy: string, auth: AuthInfo): [string, string] | undefined {
  const url = new URL(proxy)
  if (!url.username || !auth.isProxy) return undefined
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  if (auth.host.toLowerCase() !== url.hostname.toLowerCase() || auth.port !== port) {
    return undefined
  }
  return [decodeURIComponent(url.username), decodeURIComponent(url.password)]
}

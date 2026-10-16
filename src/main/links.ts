/**
 * `lumovi://` links handed to the desktop app: by the system (macOS's `open-url`), or as the one
 * argument after `--` that Lumovi is registered to be started with on Windows and Linux (so
 * nothing in a link can be read as one of Chromium's switches). Each is kept for the window in
 * front, whose page asks for it once its windows are back where they were, and asks the person
 * before going anywhere: a link never opens, reads or signs in to a cluster by itself.
 */
import { createHash, X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { BrowserWindow, WebContents } from 'electron'
import { IPC } from '@shared/api'
import {
  LINK_SCHEME,
  linkFor,
  LinkRefused,
  matchLink,
  parseLink,
  type LinkArrival,
} from '@shared/links'

/** After a prompt, links are let go, not kept for later: a page can't queue them up. */
const QUIET_MS = 2_000
/** How long keys to a window raised for a link from another app must stop before they count. */
export const KEYS_QUIET_MS = 500

/** Where a context's cluster is, and the authority its certificate is checked by. */
export interface ClusterAddress {
  server: string
  caData?: string
  caFile?: string
}

const PEM = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g

/** A cluster's own authority's certificates, as DER: none where it has none, or can't be read. */
function authorityOf({ caData, caFile }: ClusterAddress): Buffer[] {
  try {
    const text = caData
      ? Buffer.from(caData, 'base64').toString('latin1')
      : caFile
        ? readFileSync(caFile, 'latin1')
        : ''
    return (text.match(PEM) ?? []).map((pem) => new X509Certificate(pem).raw)
  } catch {
    return []
  }
}

/**
 * Which cluster a link means, the same on everyone's computer: its server's address (scheme,
 * host, a port other than the default, its path) and its authority's certificates (as DER, so
 * data and a file, CRLF or not, are alike; sorted, as a chain may come in any order). Without an
 * authority of its own, the address alone, which a list of addresses could be checked against:
 * it names the cluster, it doesn't hide where it is.
 */
export function clusterFingerprint(cluster: ClusterAddress): string {
  const url = new URL(cluster.server)
  const address = `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
  const authority = authorityOf(cluster)
    .map((der) => der.toString('hex'))
    .sort()
  return createHash('sha256')
    .update(['lumovi-link/1', address, ...authority].join('\n'))
    .digest('hex')
    .slice(0, 12)
}

/** The link in what Lumovi was started with: the one argument after `--`, and only that. */
export function linkIn(argv: readonly string[] = []): string | undefined {
  const at = argv.indexOf('--')
  if (at < 0 || argv.length !== at + 2) return undefined
  const text = argv[at + 1]!
  return text.toLowerCase().startsWith(`${LINK_SCHEME}:`) ? text : undefined
}

export interface LinksDeps {
  /** The window of Lumovi's own last in front, if there's one: never a window of one tab. */
  front(): BrowserWindow | undefined
  /**
   * A new window of Lumovi's own, made as New Window makes one: for a link where there are
   * windows, but only windows of one tab. (Where there are none, the first one's page takes it.)
   */
  newWindow?(): BrowserWindow
  /** Whether Lumovi has any window open now. */
  anyWindow?(): boolean
  /**
   * Keys to `win` are nothing until they stop for KEYS_QUIET_MS: it was raised for a link from
   * another app, where the person may still be typing. From the raise, card or not.
   */
  holdKeys?(win: BrowserWindow): void
  /** The window showing `context`'s cluster now, if one does: a link to it asks there. */
  showing(context: string): BrowserWindow | undefined
  /** Whether `win` is a window of one tab, which a link never asks in. */
  tabWindow?(win: BrowserWindow): boolean
  /** Whether the organization's policy turns links off. */
  off(): boolean
  /** Each context there is, and its cluster's address where it can be used. */
  here(): { name: string; cluster?: ClusterAddress }[]
  now?(): number
}

export class Links {
  /** The link handed over last, and the window it asks in, until that window's page takes it. */
  #waiting: { text: string; win?: BrowserWindow; elsewhere: boolean } | undefined
  /** When the last card was shown, or answered: links that come before QUIET_MS after are let go. */
  #quietFrom = Number.NEGATIVE_INFINITY
  /** Whether the last card was answered (not replaced by a newer), and a link let go since said. */
  #answered = false
  #told = false

  constructor(private readonly deps: LinksDeps) {}

  #now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** A link, read and matched with the clusters here as they are now. */
  #read(text: string): LinkArrival {
    let link
    try {
      link = parseLink(text)
    } catch (error) {
      if (error instanceof LinkRefused) return { refused: error.message }
      throw error
    }
    const here = this.deps.here().map(({ name, cluster }) => ({
      name,
      ...(cluster ? { at: fingerprintOf(cluster) } : {}),
    }))
    return { link, match: matchLink(link, here) }
  }

  /**
   * A link handed to Lumovi: kept for the window that shows its cluster, else the one in front (a
   * newer one in its place), which is raised once and told. Before there's a window, the first
   * one's page takes it. Within QUIET_MS of a card, let go; the first after an answered one said.
   */
  arrive(text: string): void {
    if (this.deps.off()) return
    if (this.#now() - this.#quietFrom < QUIET_MS) {
      // (Once: a page sending links in a loop is told one time, not a stream.)
      if (this.#answered && !this.#told) {
        this.#told = true
        this.deps.front()?.webContents.send(IPC.linkSkipped)
      }
      return
    }
    const arrival = this.#read(text)
    const context =
      'match' in arrival && arrival.match.found === 'one' ? arrival.match.context : undefined
    let win = (context !== undefined ? this.deps.showing(context) : undefined) ?? this.deps.front()
    // (Only windows of one tab left: a window of its own. Never on the way to saying a skip.)
    const made = win === undefined && this.deps.anyWindow?.() === true && !!this.deps.newWindow
    if (made) win = this.deps.newWindow!()
    const raise = this.#waiting?.win !== win || win === undefined
    // (Whether the person was in this window as it came, or in another app: there, the keys
    // they're typing aren't Lumovi's. A window made for the link they weren't in at all.)
    const elsewhere = made || !win?.isFocused() || this.#waiting?.elsewhere === true
    this.#waiting = { text, ...(win ? { win } : {}), elsewhere }
    if (!win) return
    if (raise) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
    if (elsewhere) this.deps.holdKeys?.(win)
    win.webContents.send(IPC.linkWaiting)
  }

  /**
   * The link waiting, for its window's page alone: read and matched again, once. (The policy too:
   * one that turned links off while it waited, for a dialog to close, wins.)
   */
  take(page: WebContents): LinkArrival | undefined {
    const waiting = this.#waiting
    const kept = waiting?.win && !this.deps.tabWindow?.(waiting.win) ? waiting.win : undefined
    const win = kept ?? this.deps.front()
    if (!waiting || !win || win.isDestroyed() || win.webContents !== page) return undefined
    this.#waiting = undefined
    if (this.deps.off()) return undefined
    this.#quietFrom = this.#now()
    this.#answered = false
    this.#told = false
    return { ...this.#read(waiting.text), ...(waiting.elsewhere ? { elsewhere: true } : {}) }
  }

  /** A card was answered (whatever the answer): links for QUIET_MS after are let go, one said. */
  answered(): void {
    this.#quietFrom = this.#now()
    this.#answered = true
    this.#told = false
  }

  /** The link to a view (the app's address of it, `/cluster/<context>/…`), for Copy link. */
  linkFor(address: string, tab?: string): string {
    const [, first, encoded] = address.split('?')[0]!.split('/')
    if (first !== 'cluster' || !encoded) throw new LinkRefused('it isn’t a cluster’s view.')
    const context = decodeURIComponent(encoded)
    const cluster = this.deps.here().find((each) => each.name === context)?.cluster
    const at = cluster ? fingerprintOf(cluster) : undefined
    return linkFor(address, { ...(at ? { at } : {}), ...(tab ? { tab } : {}) })
  }
}

/** A fingerprint, or none for an address that isn't a URL (a kubeconfig can say anything). */
function fingerprintOf(cluster: ClusterAddress): string | undefined {
  try {
    return clusterFingerprint(cluster)
  } catch {
    return undefined
  }
}

/**
 * Takes KubeStacks' screenshots, light and dark, into docs/screenshots, and
 * writes their catalog there (README.md, screenshots.json):
 *
 *   npm run screenshots                    all of them (after building the app)
 *   npm run screenshots -- overview pods   only these
 *   npm run screenshots -- --prune         and removes ones no longer taken
 *
 * They're taken of the mock clusters the tests use, with the clock stopped,
 * so a screen that hasn't changed comes out the same, and isn't rewritten.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { _electron as electron, chromium, type Browser, type Page } from '@playwright/test'
import { startMockOidc, type MockOidc } from '../../tests/mock-oidc/server.ts'
import { writeCatalog } from './catalog.ts'
import { EPOCH, stopAnimations, stopClock } from './still.ts'
import { CLUSTERS } from './clusters.ts'
import {
  HEIGHT,
  keep,
  kept,
  leftOver,
  pixelsOf,
  remove,
  same,
  sizeCheck,
  WIDTH,
  type Theme,
} from './images.ts'
import { SCREENS, type Screen } from './screens.ts'

const DIR = resolve('docs/screenshots')
const THEMES: Theme[] = ['light', 'dark']

const args = process.argv.slice(2)
const prune = args.includes('--prune')
const names = args.filter((arg) => !arg.startsWith('--'))
const unknown = names.filter((name) => !SCREENS.some((screen) => screen.name === name))
if (unknown.length > 0) {
  console.error(`No screenshot is called ${unknown.join(', ')}. There are:
  ${SCREENS.map((screen) => screen.name).join(', ')}`)
  process.exit(1)
}
const screens = names.length > 0 ? SCREENS.filter((s) => names.includes(s.name)) : SCREENS

/** The mock clusters, in a process of their own (see clusters.ts). */
async function startClusters() {
  const child = spawn(process.execPath, [resolve('scripts/screenshots/clusters.ts')], {
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const [line] = (await once(createInterface({ input: child.stdout }), 'line')) as [string]
  const { kubeconfig } = JSON.parse(line) as { kubeconfig: string }
  return {
    kubeconfig,
    async close() {
      const exited = once(child, 'exit')
      child.stdin.end()
      await exited
    },
  }
}

/** Artifact Hub, as far as searching it goes. */
async function startArtifactHub() {
  const repository = (name: string, url: string) => ({ name, url })
  const bitnami = repository('bitnami', 'https://charts.bitnami.com/bitnami')
  const packages = [
    {
      name: 'redis',
      version: '20.1.0',
      app_version: '7.4.1',
      description: 'Redis is an open source, advanced key-value store.',
      repository: bitnami,
    },
    {
      name: 'valkey',
      version: '2.4.7',
      app_version: '8.1.1',
      description: 'Valkey is an open source, high-performance key/value datastore.',
      repository: bitnami,
    },
    {
      name: 'redis-ha',
      version: '4.33.7',
      app_version: '7.4.2',
      description: 'A highly available Redis, with Sentinel for failover.',
      repository: repository('dandydev', 'https://dandydeveloper.github.io/charts'),
    },
  ]
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/v1/packages/search')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ packages }))
    } else {
      res.writeHead(404).end()
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise((done) => server.close(done)),
  }
}

/** The desktop app in a theme, against the mock clusters, in a home and profile of its own. */
async function launchDesktop(theme: Theme, kubeconfig: string, env: Record<string, string>) {
  const home = mkdtempSync(join(tmpdir(), 'kubestacks-screenshots-home-'))
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ theme }))
  // Started where the kubeconfig's .kube folder is, and pointed at it from there: the clusters
  // page shows the path, the same wherever that is.
  const cwd = dirname(dirname(kubeconfig))
  const app = await electron.launch({
    cwd,
    // Shown without a window on screen (see tests/e2e/harness.cjs).
    args: [
      '-r',
      resolve('tests/e2e/harness.cjs'),
      '-r',
      resolve('scripts/screenshots/harness.cjs'),
      resolve('.'),
      `--user-data-dir=${home}`,
      // Drawn in software: on the GPU, things come out a little differently from time to time.
      '--disable-gpu',
      '--lang=en-US',
    ],
    env: {
      ...process.env,
      ...env,
      KUBECONFIG: relative(cwd, kubeconfig),
      HOME: home,
      USERPROFILE: home,
      TZ: 'UTC',
      SHELL: '',
      // Only KubeStacks' own views.
      KUBESTACKS_VIEWS_DIR: '',
      // The e2e tests' stand-in, so no real helm runs against the mock cluster.
      KUBESTACKS_HELM: resolve('tests/e2e/helm/helm'),
    } as Record<string, string>,
    colorScheme: null,
  })
  await app.context().addInitScript(stopClock, EPOCH)
  await app.context().addInitScript(stopAnimations)
  const page = await app.firstWindow()
  // The page's size and density, set as Playwright sets a browser's: a window can't be bigger
  // than the screen it's on, and some are small (GitHub's Macs: 1024 × 681 at 2×).
  const cdp = await app.context().newCDPSession(page)
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 2,
    mobile: false,
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  return {
    page,
    /** What the page shows, at the density set above (Playwright's would be the screen's). */
    async screenshot() {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
      return Buffer.from(data, 'base64')
    },
    /** Opens `path` afresh, as if the app had just started there. */
    async open(path: string) {
      await page.evaluate((hash) => {
        // What earlier screens left behind, like custom resources added to the sidebar.
        localStorage.clear()
        sessionStorage.clear()
        location.hash = hash
      }, `#${path}`)
      await page.reload()
      // Screenshots don't show macOS's window controls, so lay out as full screen does.
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.emit('enter-full-screen'),
      )
    },
    async close() {
      await app.close()
      rmSync(home, { recursive: true, force: true })
    },
  }
}

const freePort = async () => {
  const server = http.createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  await new Promise((done) => server.close(done))
  return port
}

/** KubeStacks served from the production cluster, people signing in as `mode` says. */
async function startServer(mode: NonNullable<Screen['server']>, kubeconfig: string) {
  const port = await freePort()
  const url = `http://127.0.0.1:${port}/`
  let oidc: MockOidc | undefined
  const auth: Record<string, string> = {}
  if (mode === 'sso') {
    oidc = await startMockOidc({ clientId: 'kubestacks' })
    Object.assign(auth, {
      KUBESTACKS_AUTH: 'oidc',
      KUBESTACKS_URL: url,
      KUBESTACKS_OIDC_ISSUER: oidc.issuer,
      KUBESTACKS_OIDC_CLIENT_ID: 'kubestacks',
    })
  } else if (mode === 'proxy') {
    auth.KUBESTACKS_AUTH = 'proxy'
  }
  const child: ChildProcess = spawn(process.execPath, [resolve('out/server/index.js')], {
    env: {
      ...process.env,
      ...auth,
      KUBECONFIG: kubeconfig,
      KUBESTACKS_CONTEXT: CLUSTERS.production,
      KUBESTACKS_CLUSTER_NAME: CLUSTERS.production,
      KUBESTACKS_ADDRESS: '127.0.0.1',
      KUBESTACKS_PORT: String(port),
      KUBESTACKS_VIEWS_DIR: '',
      KUBESTACKS_HELM: resolve('tests/e2e/helm/helm'),
    },
    stdio: 'ignore',
  })
  for (let tries = 0; ; tries++) {
    const up = await fetch(`${url}healthz`).then(
      (res) => res.ok,
      () => false,
    )
    if (up) break
    if (tries === 100) throw new Error(`KubeStacks' server didn't start (${mode})`)
    await new Promise((done) => setTimeout(done, 100))
  }
  return {
    url,
    async close() {
      const exited = once(child, 'exit')
      child.kill()
      await exited
      await oidc?.close()
    },
  }
}

/** Who the proxy says is signed in, for `server: 'proxy'` screens. */
const PROXY_HEADERS = {
  'X-Forwarded-User': 'jane@example.com',
  'X-Forwarded-Groups': 'platform,on-call',
}

/** A screenshot of the page once it's settled: nothing loading, and nothing changing. */
async function capture(page: Page, screenshot: () => Promise<Buffer>): Promise<Buffer> {
  await page.waitForFunction(() => !document.querySelector('.animate-spin'), undefined, {
    timeout: 30_000,
  })
  await page.evaluate(async () => {
    // A native select places its text as the fonts were when it was first laid out: lay
    // them out again with every font loaded.
    await document.fonts.ready
    for (const select of document.querySelectorAll('select')) {
      const { display } = select.style
      select.style.display = 'none'
      void select.offsetWidth
      select.style.display = display
    }
  })
  // Out of the way of anything that shows on hover.
  await page.mouse.move(WIDTH / 2, 2)
  let shot = await screenshot()
  for (let tries = 0; tries < 40; tries++) {
    await page.waitForTimeout(250)
    const next = await screenshot()
    if (next.equals(shot)) return next
    shot = next
  }
  throw new Error('The screen kept changing')
}

const changed: string[] = []
const failed: string[] = []
let unchanged = 0

/** Opens a screen afresh, does its steps, and captures it. */
async function shoot(
  screen: Screen,
  page: Page,
  screenshot: () => Promise<Buffer> = () => page.screenshot(),
): Promise<Buffer> {
  try {
    await page.waitForTimeout(500)
    await screen.steps?.(page)
    const png = await capture(page, screenshot)
    await screen.after?.(page)
    await sizeCheck(png)
    return png
  } catch (error) {
    // What it was waiting for, and how the screen looked then.
    const [what, ...log] = (error as Error).message.split('\n')
    const waiting = log.find((line) => line.includes('waiting for'))?.trim()
    const file = join(tmpdir(), `kubestacks-screenshot-${screen.name}.png`)
    await page.screenshot({ path: file }).catch(() => undefined)
    throw new Error(`${what}${waiting ? ` (${waiting.replace(/^- /, '')})` : ''}; see ${file}`, {
      cause: error,
    })
  }
}

/**
 * Times a screen is taken, at most, before it's said to have changed: once in
 * a while, something on it is laid out a pixel off (it differs every time
 * when it really changed).
 */
const ATTEMPTS = 3

/** Takes a screenshot (`afresh()` opens the screen anew each time), and keeps it if it changed. */
async function take(screen: Screen, theme: Theme, afresh: () => Promise<Buffer>) {
  const label = `${screen.name}-${theme}`
  try {
    const before = await kept(DIR, screen.name, theme)
    const shots: { png: Buffer; pixels: Buffer; seen: number }[] = []
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const png = await afresh()
      const pixels = await pixelsOf(png)
      if (before && same(before, pixels)) {
        unchanged++
        console.log(`  ${label}: unchanged${attempt > 0 ? ` (taken ${attempt + 1} times)` : ''}`)
        return
      }
      const seen = shots.find((shot) => same(shot.pixels, pixels))
      if (seen && ++seen.seen === 2) break
      if (!seen) shots.push({ png, pixels, seen: 1 })
    }
    // As it came out most often.
    const { png } = shots.reduce((best, shot) => (shot.seen > best.seen ? shot : best))
    await keep(DIR, screen.name, theme, png)
    changed.push(label)
    console.log(`  ${label}: ${before ? 'changed' : 'new'}`)
  } catch (error) {
    failed.push(`${label}: ${(error as Error).message}`)
    console.log(`  ${label}: failed`)
  }
}

const clusters = await startClusters()
const hub = await startArtifactHub()
let browser: Browser | undefined
const servers = new Map<string, Awaited<ReturnType<typeof startServer>>>()
try {
  const desktop = screens.filter((screen) => screen.app === 'desktop')
  for (const theme of desktop.length > 0 ? THEMES : []) {
    const app = await launchDesktop(theme, clusters.kubeconfig, {
      KUBESTACKS_ARTIFACT_HUB_URL: hub.url,
    })
    try {
      for (const screen of desktop) {
        await take(screen, theme, async () => {
          await app.open(screen.path)
          return shoot(screen, app.page, app.screenshot)
        })
      }
    } finally {
      await app.close()
    }
  }

  const served = screens.filter((screen) => screen.app === 'server')
  for (const screen of served) {
    const mode = screen.server ?? 'token'
    if (!servers.has(mode)) servers.set(mode, await startServer(mode, clusters.kubeconfig))
    browser ??= await chromium.launch()
    const url = new URL(screen.path.slice(1), servers.get(mode)!.url).href
    for (const theme of THEMES) {
      await take(screen, theme, async () => {
        const context = await browser!.newContext({
          viewport: { width: WIDTH, height: HEIGHT },
          deviceScaleFactor: 2,
          colorScheme: theme,
          reducedMotion: 'reduce',
          locale: 'en-US',
          timezoneId: 'UTC',
          extraHTTPHeaders: mode === 'proxy' ? PROXY_HEADERS : undefined,
        })
        try {
          await context.addInitScript(stopClock, EPOCH)
          await context.addInitScript(stopAnimations)
          const page = await context.newPage()
          await page.goto(url)
          return await shoot(screen, page)
        } finally {
          await context.close()
        }
      })
    }
  }
} finally {
  await browser?.close()
  for (const server of servers.values()) await server.close()
  await hub.close()
  await clusters.close()
}

await writeCatalog(DIR, SCREENS)
const extra =
  screens === SCREENS
    ? leftOver(
        DIR,
        SCREENS.map((s) => s.name),
      )
    : []
if (prune) remove(DIR, extra)

console.log(`
${changed.length} changed, ${unchanged} unchanged${failed.length > 0 ? `, ${failed.length} failed` : ''}.`)
if (extra.length > 0) {
  console.log(
    prune
      ? `Removed screenshots no longer taken: ${extra.join(', ')}`
      : `Screenshots no longer taken (--prune removes them): ${extra.join(', ')}`,
  )
}
if (failed.length > 0) {
  console.error(`\nThese failed:\n${failed.map((f) => `  ${f}`).join('\n')}`)
  process.exitCode = 1
}

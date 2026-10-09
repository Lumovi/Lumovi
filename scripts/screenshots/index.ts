/**
 * Takes Lumovi's screenshots, light and dark, into docs/screenshots, and
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
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { _electron as electron, chromium, type Browser, type Page } from '@playwright/test'
import { parse, stringify } from 'yaml'
import { startMockOidc, type MockOidc } from '../../tests/mock-oidc/server.ts'
import { ACCESS_BASE, accessData, SIGN_INS } from './access.ts'
import { auditHistory } from './audit-history.ts'
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
import { ASSISTANTS_TOKEN, SCREENS, type Screen } from './screens.ts'

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
  // Its first line, or why there's none: it stopped (it says why).
  const line = await new Promise<string>((resolve, reject) => {
    createInterface({ input: child.stdout }).once('line', resolve)
    child.once('exit', (code) =>
      reject(new Error(`The mock clusters stopped before they started (exit code ${code}).`)),
    )
  })
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
  const home = mkdtempSync(join(tmpdir(), 'lumovi-screenshots-home-'))
  // AI assistants' token, the same each time (shown in part).
  writeFileSync(
    join(home, 'settings.json'),
    JSON.stringify({
      theme,
      assistants: { enabled: false, port: 47830, token: ASSISTANTS_TOKEN },
      // The clusters page as people keep it: each cluster in a color and a group, labelled (its
      // name as the kubeconfig's, which the screens find it by).
      clusters: CLUSTER_SETTINGS,
    }),
  )
  // Terminals' shells (zsh on macOS, bash elsewhere) with a prompt that's the same everywhere,
  // not one that names the computer: its folder icon one of the Nerd Font's.
  writeFileSync(join(home, '.zshrc'), "PROMPT=$'%F{blue}\\uf07c ~%f %F{green}❯%f '\n")
  writeFileSync(
    join(home, '.bashrc'),
    "PS1='\\[\\e[34m\\]\uf07c ~\\[\\e[0m\\] \\[\\e[32m\\]❯\\[\\e[0m\\] '\n",
  )
  // The kubeconfig where people keep theirs, ~/.kube/config: the clusters page shows it so, the
  // same each time (its certificates are in it, so it reads the same anywhere). Not KUBECONFIG.
  mkdirSync(join(home, '.kube'))
  copyFileSync(kubeconfig, join(home, '.kube', 'config'))
  const { KUBECONFIG: _theirs, ...inherited } = process.env
  const cwd = home
  const app = await electron.launch({
    cwd,
    // Shown without a window on screen (see tests/e2e/harness.cjs).
    args: [
      '-r',
      resolve('tests/e2e/harness.cjs'),
      '-r',
      resolve('scripts/screenshots/harness.cjs'),
      // Lumovi's own sponsor card, not what's live on GitHub that day.
      '-r',
      resolve('scripts/screenshots/own-card.cjs'),
      resolve('.'),
      `--user-data-dir=${home}`,
      // Drawn in software: on the GPU, things come out a little differently from time to time.
      '--disable-gpu',
      '--lang=en-US',
    ],
    env: {
      ...inherited,
      ...env,
      HOME: home,
      USERPROFILE: home,
      TZ: 'UTC',
      SHELL: '',
      // Only Lumovi's own views.
      LUMOVI_VIEWS_DIR: '',
      // The e2e tests' stand-in, so no real helm runs against the mock cluster.
      LUMOVI_HELM: resolve('tests/e2e/helm/helm'),
      // The page's stopped clock, for the time left to approve AI assistants' changes.
      LUMOVI_SCREENSHOT_EPOCH: String(EPOCH),
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

/** How each cluster shows on the clusters page: its color, its group, and its labels. */
const CLUSTER_SETTINGS = {
  [CLUSTERS.production]: {
    color: 2,
    group: 'Shop',
    labels: { env: 'production', region: 'eu-west' },
  },
  [CLUSTERS.staging]: { color: 4, group: 'Shop', labels: { env: 'staging', region: 'eu-west' } },
  [CLUSTERS.loadTest]: { color: 7, group: 'Platform', labels: { env: 'test', region: 'us-east' } },
  [CLUSTERS.edge]: {
    color: 3,
    group: 'Platform',
    labels: { env: 'production', region: 'ap-south' },
  },
}

/** What each cluster of the fleet is labelled with. */
const FLEET_LABELS: Record<string, Record<string, string>> = {
  [CLUSTERS.production]: { env: 'production', region: 'eu-west' },
  [CLUSTERS.staging]: { env: 'staging', region: 'eu-west' },
  [CLUSTERS.loadTest]: { env: 'test', region: 'us-east' },
  [CLUSTERS.edge]: { env: 'production', region: 'ap-south' },
}

/**
 * The mock clusters as a fleet's kubeconfig, beside theirs (its paths are
 * relative to it): each context labelled, and with the administrator's token
 * (the other clusters take any).
 */
function fleetKubeconfig(kubeconfig: string): string {
  const config = parse(readFileSync(kubeconfig, 'utf8')) as {
    contexts: { name: string; context: Record<string, unknown> }[]
  }
  for (const { name, context } of config.contexts) {
    context.user = 'admin'
    context.extensions = [{ name: 'lumovi.dev', extension: { labels: FLEET_LABELS[name] } }]
  }
  const file = join(dirname(kubeconfig), 'fleet')
  writeFileSync(file, stringify(config))
  return file
}

/** Lumovi served from the production cluster (or a fleet), people signing in as `mode` says. */
async function startServer(mode: NonNullable<Screen['server']>, kubeconfig: string) {
  const port = await freePort()
  const url = `http://127.0.0.1:${port}/`
  let oidc: MockOidc | undefined
  const auth: Record<string, string> = {}
  let shows: Record<string, string> = {
    KUBECONFIG: kubeconfig,
    LUMOVI_CONTEXT: CLUSTERS.production,
    LUMOVI_CLUSTER_NAME: CLUSTERS.production,
  }
  if (mode === 'fleet' || mode === 'access') {
    auth.LUMOVI_AUTH = 'proxy'
    shows = { LUMOVI_FLEET_KUBECONFIG_FILE: fleetKubeconfig(kubeconfig) }
  } else if (mode === 'sso') {
    oidc = await startMockOidc({ clientId: 'lumovi' })
    Object.assign(auth, {
      LUMOVI_AUTH: 'oidc',
      LUMOVI_URL: url,
      LUMOVI_OIDC_ISSUER: oidc.issuer,
      LUMOVI_OIDC_CLIENT_ID: 'lumovi',
    })
  } else if (mode === 'proxy') {
    auth.LUMOVI_AUTH = 'proxy'
  }
  // The audit log's: a day of it, kept as a volume would (its auditors see it all), recorded
  // by a clock that starts where the page's stopped.
  // Access's: the chart's, what the admins set, and who signed in that day.
  const day = new Date(EPOCH).toISOString().slice(0, 10)
  const audit =
    mode === 'audit' || mode === 'access'
      ? {
          LUMOVI_AUTH: 'proxy',
          LUMOVI_AUDITORS: 'platform',
          LUMOVI_AUDIT_DIR: auditHistory(day, mode === 'access' ? SIGN_INS : []),
          LUMOVI_AUDIT_STDOUT: 'false',
          LUMOVI_SCREENSHOT_EPOCH: String(EPOCH),
          ...(mode === 'access'
            ? {
                LUMOVI_ADMINS: 'platform',
                LUMOVI_ACCESS: ACCESS_BASE,
                LUMOVI_DATA_DIR: accessData(),
              }
            : {}),
        }
      : {}
  const node = [
    // Lumovi's own sponsor card, not what's live on GitHub that day.
    '-r',
    resolve('scripts/screenshots/own-card.cjs'),
    ...(mode === 'audit' || mode === 'access'
      ? ['-r', resolve('scripts/screenshots/shifted-clock.cjs')]
      : []),
  ]
  const child: ChildProcess = spawn(process.execPath, [...node, resolve('out/server/index.js')], {
    env: {
      ...audit,
      ...process.env,
      ...auth,
      ...shows,
      LUMOVI_ADDRESS: '127.0.0.1',
      LUMOVI_PORT: String(port),
      LUMOVI_VIEWS_DIR: '',
      LUMOVI_HELM: resolve('tests/e2e/helm/helm'),
    },
    stdio: 'ignore',
  })
  for (let tries = 0; ; tries++) {
    const up = await fetch(`${url}healthz`).then(
      (res) => res.ok,
      () => false,
    )
    if (up) break
    if (tries === 100) throw new Error(`Lumovi's server didn't start (${mode})`)
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
    await nothingOfThisComputer(page)
    const png = await capture(page, screenshot)
    await screen.after?.(page)
    await sizeCheck(png)
    return png
  } catch (error) {
    // What it was waiting for, and how the screen looked then.
    const [what, ...log] = (error as Error).message.split('\n')
    const waiting = log.find((line) => line.includes('waiting for'))?.trim()
    const file = join(tmpdir(), `lumovi-screenshot-${screen.name}.png`)
    await page.screenshot({ path: file }).catch(() => undefined)
    throw new Error(`${what}${waiting ? ` (${waiting.replace(/^- /, '')})` : ''}; see ${file}`, {
      cause: error,
    })
  }
}

/**
 * What a screenshot mustn't show: the temporary folders it's taken in, which
 * name this computer and differ each time.
 */
const OF_THIS_COMPUTER = [tmpdir(), 'lumovi-screenshots-home-', '/Users/runner', '/_temp/']

/**
 * Fails when the page shows one of the folders the screenshots are taken in: in its text, or in
 * what a field holds (or suggests). Not what's drawn on a canvas, like a terminal's lines.
 */
async function nothingOfThisComputer(page: Page) {
  const text = await page.evaluate(() =>
    [
      document.body.innerText,
      ...Array.from(document.querySelectorAll('input, textarea'), (field) => {
        const { value, placeholder } = field as HTMLInputElement | HTMLTextAreaElement
        return `${value}\n${placeholder}`
      }),
    ].join('\n'),
  )
  const shown = OF_THIS_COMPUTER.find((folder) => text.includes(folder))
  if (shown === undefined) return
  const line = text.split('\n').find((line) => line.includes(shown))
  throw new Error(`The page shows a folder of this computer's (${shown}): ${line?.trim()}`)
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
    // An app for the screens that show the kubeconfig's path as given, started with a relative one.
    for (const kubeconfig of [undefined, 'relative'] as const) {
      const these = desktop.filter((screen) => screen.kubeconfig === kubeconfig)
      if (these.length === 0) continue
      const app = await launchDesktop(theme, clusters.kubeconfig, {
        LUMOVI_ARTIFACT_HUB_URL: hub.url,
        ...(kubeconfig === 'relative' ? { KUBECONFIG: join('.kube', 'config') } : {}),
      })
      try {
        for (const screen of these) {
          await take(screen, theme, async () => {
            await app.open(screen.path)
            return shoot(screen, app.page, app.screenshot)
          })
        }
      } finally {
        await app.close()
      }
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
          extraHTTPHeaders:
            mode === 'proxy' || mode === 'fleet' || mode === 'audit' || mode === 'access'
              ? PROXY_HEADERS
              : undefined,
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

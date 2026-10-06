/**
 * Fixtures for Lumovi served from a cluster: every worker gets its own
 * mock clusters, every test the servers it starts (`serve`, as `node
 * out/server/index.js` runs in its image) and a browser page. With an
 * instrumented build, the server's and the page's coverage go to .nyc_output/.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test as base, type Page } from '@playwright/test'
import type { AuditEvent } from '../../src/shared/audit.ts'
import { startTestClusters, type TestClusters } from '../mock-cluster/kubeconfig.ts'

export { expect }
export { DEMO, DEMO_TOKEN, PEOPLE } from '../mock-cluster/kubeconfig.ts'

const COVERAGE_DIR = resolve('.nyc_output')
const SERVER = resolve('out/server/index.js')
const AGENT = resolve('out/agent/agent.js')
/** Only an instrumented build answers when asked for its coverage. */
const INSTRUMENTED = (() => {
  try {
    return readFileSync(SERVER, 'utf8').includes('lumovi:coverage')
  } catch {
    return false
  }
})()
const FAKE_HELM = resolve('tests/e2e/helm', process.platform === 'win32' ? 'helm.cmd' : 'helm')

/** Istanbul's coverage: each file's maps and counters (only the counters change). */
type Coverage = Record<string, Record<string, unknown>>
/** The renderer's maps, from the first page that had them (every page has the same). */
let maps: Coverage | undefined

function saveCoverage(data: unknown): void {
  if (!data) return
  mkdirSync(COVERAGE_DIR, { recursive: true })
  writeFileSync(join(COVERAGE_DIR, `${randomUUID()}.json`), JSON.stringify(data))
}

export interface ServeOptions {
  /** Added to (or, when undefined, removed from) the server's environment. */
  env?: Record<string, string | undefined>
  /** The port to listen on; any free one unless set (a restart takes its predecessor's). */
  port?: number
}

export interface Served {
  /** Where it listens, with its base path: http://127.0.0.1:12345/ */
  url: string
  port: number
  /** Where the stand-in helm records its runs. */
  helmDir: string
  /** What it wrote to stdout and stderr so far. */
  log(): string
  /** Stops it gracefully, as Kubernetes does (SIGTERM), keeping its coverage. */
  stop(): Promise<void>
}

/** Runs the server until it says where it listens; rejects with its output if it exits first. */
export function startServer(
  clusters: TestClusters,
  options: ServeOptions = {},
): Promise<Served & { process: ChildProcess }> {
  const helmDir = mkdtempSync(join(tmpdir(), 'lumovi-helm-'))
  const merged: Record<string, string | undefined> = {
    ...process.env,
    KUBECONFIG: clusters.kubeconfigPath,
    LUMOVI_CONTEXT: 'demo',
    LUMOVI_ADDRESS: '127.0.0.1',
    LUMOVI_PORT: String(options.port ?? 0),
    LUMOVI_COVERAGE_DIR: COVERAGE_DIR,
    LUMOVI_HELM: FAKE_HELM,
    FAKE_HELM_DIR: helmDir,
    // Never anyone's own: an empty folder unless a test makes one.
    LUMOVI_VIEWS_DIR: join(helmDir, 'views'),
    // The mock repositories and registries run here.
    LUMOVI_ALLOW_PRIVATE_CHARTS: 'true',
    ...options.env,
  }
  const env = Object.fromEntries(
    Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  const child = spawn(process.execPath, [SERVER], {
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let output = ''
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => (output += chunk))
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => (output += chunk))
  const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)))
  let stopping: Promise<void> | undefined
  return new Promise((resolve, reject) => {
    const listening = (chunk: string) => {
      const found = / at (http:\/\/[^\s;]+)/.exec(output)
      if (!found) return
      child.stdout!.off('data', listening)
      const url = found[1]!
      resolve({
        url,
        port: Number(new URL(url).port),
        helmDir,
        process: child,
        log: () => output,
        // Once: a test may stop it, and then the fixture does. (On Windows a killed process
        // has no exit code, so that can't tell.)
        stop() {
          stopping ??= (async () => {
            if (child.exitCode !== null) return
            if (INSTRUMENTED) {
              // Windows can't stop a process gracefully: its coverage is asked for first.
              await new Promise<void>((saved) => {
                child.once('message', () => saved())
                child.send('lumovi:coverage')
              })
            }
            child.kill('SIGTERM')
            await exited
          })()
          return stopping
        },
      })
      void chunk
    }
    child.stdout!.on('data', listening)
    void exited.then((code) => reject(new Error(`The server exited (${code}):\n${output}`)))
  })
}

/**
 * The audit events a server wrote on its output, in order (each a JSON line that says it's
 * one): of one action, if given.
 */
export function audited(served: Served, action?: string): AuditEvent[] {
  return (
    served
      .log()
      .split('\n')
      // The last may still be being written.
      .slice(0, -1)
      .filter((line) => line.startsWith('{"type":"lumovi.audit"'))
      .map((line) => JSON.parse(line) as AuditEvent)
      .filter((event) => action === undefined || event.action === action)
  )
}

export interface Agent {
  /** What it wrote to stdout and stderr so far. */
  log(): string
  /** Resolves with its exit code, once it exits (it stops by itself when refused). */
  exited: Promise<number | null>
  /** Stops it, as Kubernetes does (SIGTERM), keeping its coverage. */
  stop(): Promise<void>
}

/**
 * A fleet's agent (`node out/agent/agent.js`, as its image runs it), relaying to
 * the demo cluster as if it ran there, with the service account `serviceAccount`
 * says (see inCluster), unless `env` says otherwise.
 */
export function startAgent(env: Record<string, string | undefined>): Agent {
  const merged = {
    ...process.env,
    LUMOVI_COVERAGE_DIR: COVERAGE_DIR,
    LUMOVI_AGENT_HEALTH_PORT: '0',
    ...env,
  }
  const child = spawn(process.execPath, [AGENT], {
    env: Object.fromEntries(
      Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let output = ''
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => (output += chunk))
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => (output += chunk))
  const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)))
  let stopping: Promise<void> | undefined
  return {
    log: () => output,
    exited,
    stop() {
      stopping ??= (async () => {
        if (child.exitCode !== null) return
        if (INSTRUMENTED) {
          await new Promise<void>((saved) => {
            child.once('message', () => saved())
            child.send('lumovi:coverage')
          })
        }
        child.kill('SIGTERM')
        await exited
      })()
      return stopping
    },
  }
}

/**
 * What a process running in the demo cluster has (its service account's token,
 * CA and namespace, and where the API server is), as LUMOVI_SERVICE_ACCOUNT_DIR
 * and KUBERNETES_SERVICE_* let a test say.
 */
export function inCluster(
  clusters: TestClusters,
  { token = 'lumovi-demo-token', namespace = 'lumovi' } = {},
): { env: Record<string, string>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-serviceaccount-'))
  writeFileSync(join(dir, 'token'), token)
  writeFileSync(join(dir, 'ca.crt'), clusters.demo.caPem!)
  writeFileSync(join(dir, 'namespace'), namespace)
  return {
    dir,
    env: {
      KUBERNETES_SERVICE_HOST: '127.0.0.1',
      KUBERNETES_SERVICE_PORT: String(clusters.demo.port),
      LUMOVI_SERVICE_ACCOUNT_DIR: dir,
    },
  }
}

/** A port nothing listens on now (for a server whose address must be known before it starts). */
export async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  await new Promise((resolve) => server.close(resolve))
  return port
}

/** Runs the server with a configuration it refuses; resolves with what it said, once it exits. */
export async function refusedConfig(
  clusters: TestClusters,
  env: Record<string, string | undefined>,
): Promise<string> {
  const failed = await startServer(clusters, { env }).then(
    async (served) => {
      await served.stop()
      throw new Error(`The server started at ${served.url}`)
    },
    (error: Error) => error.message,
  )
  return failed
}

/** The kubeconfigs the stand-in helm was run with. */
export function helmKubeconfigs(served: Served): { args: string[]; kubeconfig: string }[] {
  try {
    return readFileSync(join(served.helmDir, 'kubeconfigs.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

/** Signs in with a token, on the sign-in page any address shows without a session. */
export async function signIn(page: Page, url: string, token: string): Promise<void> {
  await page.goto(url)
  await page.getByPlaceholder('Paste a token').fill(token)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('button', { name: /^Signed in as/ })).toBeVisible()
}

interface Fixtures {
  clusters: TestClusters
  serve: (options?: ServeOptions) => Promise<Served>
}

export const test = base.extend<Fixtures, { workerClusters: TestClusters }>({
  workerClusters: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const dir = mkdtempSync(join(tmpdir(), 'lumovi-clusters-'))
      const clusters = await startTestClusters(dir)
      await use(clusters)
      await clusters.close()
      rmSync(dir, { recursive: true, force: true })
    },
    { scope: 'worker' },
  ],
  clusters: async ({ workerClusters }, use) => {
    await use(workerClusters)
    workerClusters.demo.reset()
    workerClusters.sandbox.reset()
    workerClusters.large.reset()
  },
  serve: async ({ clusters }, use) => {
    const started: Served[] = []
    await use(async (options) => {
      const served = await startServer(clusters, options)
      started.push(served)
      return served
    })
    for (const served of started) await served.stop()
  },
  context: async ({ context }, use) => {
    // Pages that navigate (signing in reloads them) leave their counters in their
    // localStorage (see vite-coverage.ts); the maps they belong to are any page's.
    const coverageOf = (page: Page) =>
      page
        .evaluate(() => (window as { __coverage__?: Coverage }).__coverage__)
        .catch(() => undefined)
    context.on('page', (page) =>
      page.on('load', () => {
        if (!maps) void coverageOf(page).then((coverage) => (maps ??= coverage))
      }),
    )
    await use(context)
    for (const page of context.pages()) {
      const coverage = await coverageOf(page)
      maps ??= coverage
      saveCoverage(coverage)
    }
    for (const { localStorage } of (await context.storageState()).origins) {
      const kept = localStorage.find((item) => item.name === 'lumovi:coverage')
      if (!kept || !maps) continue
      const counts = JSON.parse(kept.value) as Coverage
      saveCoverage(
        Object.fromEntries(
          Object.entries(counts).map(([path, hits]) => [path, { ...maps![path], ...hits }]),
        ),
      )
    }
  },
})

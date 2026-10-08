/**
 * The mock clusters the screenshots are taken of, in a process of their own
 * with the clock stopped (see still.ts), so the screenshot script's own
 * timers keep running. Prints the kubeconfig's path (with the ports and its
 * pid), then runs until its input closes, its parent goes, or it's stopped.
 * The kubeconfig is .kube/config in a folder of its own (the app is started
 * there, so the clusters page names it the same way every time).
 *
 * Addresses are shown on screen, so they're fixed: 46443 to 46446. Another
 * run at the same time (a check, say) takes others: LUMOVI_MOCK_CLUSTER_PORTS,
 * the first of four in a row, or `free` for any; none takes another's. Each
 * run leaves a note of itself in RUNS while it runs (a folder of the user's
 * own); `npm run screenshots:stop -- <pid>` stops one, and with no pid, all.
 */
import { execFileSync } from 'node:child_process'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEMO_TOKEN,
  LARGE,
  startTestClusters,
  writeKubeconfig,
} from '../../tests/mock-cluster/kubeconfig.ts'
import { EPOCH, stopClock } from './still.ts'

/** The ports they answer on in the screenshots, and one where nothing does. */
const PORTS = { demo: 46443, sandbox: 46444, large: 46445, offline: 46446 }
type Ports = typeof PORTS

/**
 * Where each run leaves a note of itself while it runs, by its pid: a folder of this user's own
 * (the temporary folder is everyone's, on Linux).
 */
const RUNS = join(
  tmpdir(),
  process.getuid ? `lumovi-mock-clusters-${process.getuid()}` : 'lumovi-mock-clusters',
)

interface Run {
  pid: number
  ports: number[]
  kubeconfig: string
  started: string
  /** What started it (its parent's command), where that can be told. */
  by?: string
}

/** RUNS, made if it isn't there: only a folder of this user's own (not a link left there). */
function runsFolder(): string {
  mkdirSync(RUNS, { recursive: true, mode: 0o700 })
  const folder = lstatSync(RUNS)
  if (!folder.isDirectory() || (process.getuid && folder.uid !== process.getuid())) {
    throw new Error(
      `${RUNS} isn’t a folder of this user’s own, so the mock clusters can’t keep notes of their runs there. Remove it, or set TMPDIR to another folder.`,
    )
  }
  return RUNS
}

/** Whether `pid` is a run of these clusters (not another process given its pid since). */
function running(pid: number): boolean {
  try {
    const command =
      process.platform === 'win32'
        ? execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
            encoding: 'utf8',
          })
        : execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
    return process.platform === 'win32' ? /node/i.test(command) : command.includes('clusters.ts')
  } catch {
    return false
  }
}

/** The runs still running, by their notes (those of runs gone are cleared). */
export function runs(): Run[] {
  let names: string[]
  try {
    names = readdirSync(runsFolder()).filter((name) => name.endsWith('.json'))
  } catch {
    return []
  }
  return names.flatMap((name) => {
    const note = join(RUNS, name)
    try {
      const run = JSON.parse(readFileSync(note, 'utf8')) as Run
      if (running(run.pid)) return [run]
    } catch {
      // Not a note, or half written: cleared with the rest.
    }
    rmSync(note, { force: true })
    return []
  })
}

/** What started this process, where that can be told: its parent's command. */
function startedBy(): string | undefined {
  if (process.platform === 'win32') return undefined
  try {
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(process.ppid)], {
      encoding: 'utf8',
    }).trim()
    return command.length > 80 ? `${command.slice(0, 79)}…` : command
  } catch {
    return undefined
  }
}

/** The ports asked for: the screenshots' own, four from LUMOVI_MOCK_CLUSTER_PORTS, or any. */
function asked(value = process.env.LUMOVI_MOCK_CLUSTER_PORTS): Ports | undefined {
  if (!value) return PORTS
  if (value === 'free') return undefined
  const first = Number(value)
  if (!Number.isInteger(first) || first < 1024 || first > 65532) {
    console.error(
      `LUMOVI_MOCK_CLUSTER_PORTS is the first of four ports in a row (say 47443), or free: not ${value}.`,
    )
    process.exit(1)
  }
  return { demo: first, sandbox: first + 1, large: first + 2, offline: first + 3 }
}

/** The run that has any of `ports` (all four of each run count: nothing must answer on the last). */
const holderOf = (ports: number[]): Run | undefined =>
  runs().find((run) => run.ports.some((port) => ports.includes(port)))

/** Why they can't start on `ports`, and what to do. */
function taken(ports: number[], holder: Run | undefined, error?: Error): string {
  const others =
    'run this one on others: LUMOVI_MOCK_CLUSTER_PORTS=47443, say, or free (the addresses on screen then differ)'
  return holder
    ? `The mock clusters need ports ${ports.join(', ')}, and another run of them has ${holder.ports.join(', ')} (pid ${holder.pid}, since ${holder.started}${holder.by ? `, started by ${holder.by}` : ''}). If it’s yours, stop it (npm run screenshots:stop -- ${holder.pid}); or ${others}.`
    : `The mock clusters need ports ${ports.join(', ')} (${error?.message}). Free them, or ${others}.`
}

/** A run's ports, from its clusters' addresses. */
const portsOf = (clusters: Awaited<ReturnType<typeof startTestClusters>>): number[] =>
  [clusters.demo.url, clusters.sandbox.url, clusters.large.url, clusters.offlineUrl].map((url) =>
    Number(new URL(url).port),
  )

/** The names clusters go by in the screenshots. */
export const CLUSTERS = {
  /** The demo cluster: a small production one, with a few things wrong. */
  production: 'production',
  /** A nearly empty, older cluster. */
  staging: 'staging',
  /** Thousands of pods. */
  loadTest: 'load-test',
  /** Nothing answers. */
  edge: 'edge',
} as const

if (import.meta.main && process.argv[2] === 'stop') {
  // Those named, or all.
  const pids = process.argv.slice(3).map(Number)
  const found = runs().filter((run) => pids.length === 0 || pids.includes(run.pid))
  const stopped = found.filter((run) => {
    try {
      process.kill(run.pid, 'SIGTERM')
      return true
    } catch {
      // Gone meanwhile.
      return false
    }
  })
  console.log(
    stopped.length > 0
      ? `Stopped ${stopped.map((run) => `pid ${run.pid} (ports ${run.ports.join(', ')}, since ${run.started})`).join('; ')}.`
      : pids.length > 0
        ? `No run of the mock clusters is pid ${pids.join(' or ')}.`
        : 'No run of the mock clusters is left.',
  )
} else if (import.meta.main) {
  const started = new Date().toISOString()
  stopClock(EPOCH)
  let notes: string
  try {
    notes = runsFolder()
  } catch (error) {
    console.error((error as Error).message)
    process.exit(1)
  }
  const ports = asked()
  if (ports) {
    const holder = holderOf(Object.values(ports))
    if (holder) {
      console.error(taken(Object.values(ports), holder))
      process.exit(1)
    }
  }
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-screenshots-'))
  const start = () =>
    startTestClusters(dir, { jitter: true, ports }).catch((error: Error) => {
      rmSync(dir, { recursive: true, force: true })
      console.error(taken(Object.values(ports ?? {}), undefined, error))
      process.exit(1)
    })
  let clusters = await start()
  // Any free ports may be one where another run's last cluster is to answer nothing: again.
  for (let tries = 1; !ports && holderOf(portsOf(clusters)) && tries < 5; tries++) {
    await clusters.close()
    clusters = await start()
  }
  mkdirSync(join(dir, '.kube'))
  const kubeconfig = writeKubeconfig(
    join(dir, '.kube'),
    {
      currentContext: CLUSTERS.production,
      clusters: [
        { name: 'production', server: clusters.demo.url, caPem: clusters.demo.caPem },
        { name: 'staging', server: clusters.sandbox.url, insecure: true },
        { name: 'load-test', server: clusters.large.url, insecure: true },
        { name: 'edge', server: clusters.offlineUrl },
      ],
      users: [{ name: 'admin', token: DEMO_TOKEN }, { name: 'developer' }],
      contexts: [
        { name: CLUSTERS.production, cluster: 'production', user: 'admin' },
        { name: CLUSTERS.staging, cluster: 'staging', user: 'developer' },
        {
          name: CLUSTERS.loadTest,
          cluster: 'load-test',
          user: 'developer',
          namespace: LARGE.namespace,
        },
        { name: CLUSTERS.edge, cluster: 'edge', user: 'admin' },
      ],
    },
    'config',
  )
  const used = portsOf(clusters)
  // Its own, and only its own: never written through a link left in its place.
  const note = join(notes, `${process.pid}.json`)
  rmSync(note, { force: true })
  writeFileSync(
    note,
    JSON.stringify({
      pid: process.pid,
      ports: used,
      kubeconfig,
      started,
      by: startedBy(),
    } satisfies Run),
    { mode: 0o600, flag: 'wx' },
  )
  console.error(
    `The mock clusters answer on ports ${used.slice(0, 3).join(', ')} (and none on ${used[3]}), pid ${process.pid}.`,
  )
  console.log(JSON.stringify({ kubeconfig, ports: used, pid: process.pid }))

  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    void clusters.close().finally(() => {
      rmSync(dir, { recursive: true, force: true })
      rmSync(note, { force: true })
      process.exit(0)
    })
  }
  process.stdin.resume()
  process.stdin.on('end', stop)
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  // Its parent gone (it's handed to another, or was before it started), nothing's left to close
  // its input.
  const parent = process.ppid
  const orphaned = () => process.ppid !== parent || process.ppid === 1
  setInterval(() => orphaned() && stop(), 1_000).unref()
}

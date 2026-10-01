/**
 * Brings up (or tears down) the kind cluster the integration tests use:
 *
 *   node tests/integration/cluster.ts up     # create it if needed, install, preload
 *   node tests/integration/cluster.ts down   # delete it
 *
 * Everything goes through its own kubeconfig in .kind/, so the user's
 * ~/.kube/config (and the clusters in it) is never read or changed.
 */
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const NAME = 'kubestacks'
export const CONTEXT = `kind-${NAME}`
export const KUBECONFIG = resolve(HERE, '../../.kind/kubeconfig')

/** Images the tests run, loaded into the nodes ahead of time (no pulls during tests). */
export const IMAGES = {
  web: 'nginx:1.27-alpine',
  webNext: 'nginx:1.28-alpine',
  shell: 'busybox:1.37',
  noShell: 'registry.k8s.io/pause:3.10',
}

const CHARTS = {
  metricsServer: { repo: 'https://kubernetes-sigs.github.io/metrics-server/', version: '3.14.0' },
  prometheus: { repo: 'https://prometheus-community.github.io/helm-charts', version: '91.8.2' },
}

const env = { ...process.env, KUBECONFIG }

function run(command: string, args: string[], options: ExecFileSyncOptions = {}) {
  console.log(`$ ${command} ${args.join(' ')}`)
  return execFileSync(command, args, { stdio: 'inherit', env, ...options })
}

const quiet = (command: string, args: string[]) =>
  execFileSync(command, args, { env, encoding: 'utf8' }).trim()

function up() {
  mkdirSync(dirname(KUBECONFIG), { recursive: true })
  const clusters = quiet('kind', ['get', 'clusters']).split('\n')
  if (!clusters.includes(NAME) || !existsSync(KUBECONFIG)) {
    if (clusters.includes(NAME)) run('kind', ['delete', 'cluster', '--name', NAME])
    run('kind', [
      'create',
      'cluster',
      '--config',
      join(HERE, 'kind.yaml'),
      '--kubeconfig',
      KUBECONFIG,
    ])
  }
  // Each node pulls the images itself: `kind load` trips over images that
  // Docker holds for one platform only.
  for (const node of quiet('kind', ['get', 'nodes', '--name', NAME]).split('\n')) {
    for (const image of Object.values(IMAGES)) {
      run('docker', ['exec', node, 'crictl', 'pull', image], { stdio: 'ignore' })
    }
  }
  run('helm', [
    'upgrade',
    '--install',
    'metrics-server',
    'metrics-server',
    '--repo',
    CHARTS.metricsServer.repo,
    '--version',
    CHARTS.metricsServer.version,
    '--namespace',
    'kube-system',
    '--values',
    join(HERE, 'metrics-server-values.yaml'),
    '--wait',
    '--timeout',
    '5m',
  ])
  run('helm', [
    'upgrade',
    '--install',
    'kps',
    'kube-prometheus-stack',
    '--repo',
    CHARTS.prometheus.repo,
    '--version',
    CHARTS.prometheus.version,
    '--namespace',
    'monitoring',
    '--create-namespace',
    '--values',
    join(HERE, 'prometheus-values.yaml'),
    '--wait',
    '--timeout',
    '10m',
  ])
  run('kubectl', [
    '--context',
    CONTEXT,
    'wait',
    '--for=condition=Ready',
    'pods',
    '--all',
    '--namespace',
    'monitoring',
    '--timeout',
    '5m',
  ])
  console.log(`\nReady: ${CONTEXT} (kubeconfig ${KUBECONFIG})`)
}

function down() {
  run('kind', ['delete', 'cluster', '--name', NAME])
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2]
  if (command === 'up') up()
  else if (command === 'down') down()
  else {
    console.error('Usage: node tests/integration/cluster.ts up|down')
    process.exit(1)
  }
}

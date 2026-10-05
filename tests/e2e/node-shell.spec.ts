/**
 * Shells on nodes: a privileged pod Lumovi starts on the node, a shell in the
 * node's own namespaces (or in the pod, with the node's files under /host),
 * and the pod deleted once the shell ends.
 */
import type { Page } from '@playwright/test'
import type { MockCluster } from '../mock-cluster/server.ts'
import { open } from './action-helpers.ts'
import { DEMO, expect, openCluster, panel, test } from './fixtures.ts'

const NODE = DEMO.nodes.worker1

/** What the node's terminal shows. */
const screen = (page: Page, node: string = NODE) =>
  page.getByRole('region', { name: `Shell on ${node}` }).locator('.xterm-rows')

/** The node shells' pods Lumovi asked for. */
const podsCreated = (cluster: MockCluster) =>
  cluster.requests.filter(
    (r) => r.method === 'POST' && r.path === '/api/v1/namespaces/kube-system/pods',
  )

/** The pod a node shell started, once it's there. */
async function startedPod(cluster: MockCluster): Promise<string> {
  let name = ''
  await expect
    .poll(() => {
      const exec = cluster.requests.findLast(
        (r) =>
          r.path.startsWith('/api/v1/namespaces/kube-system/pods/') && r.path.endsWith('/exec'),
      )
      name = exec?.path.split('/')[6] ?? ''
      return name
    })
    .toMatch(/^lumovi-node-shell-/)
  return name
}

/** Opens a node's Shell tab, from its panel's Shell button. */
async function shellTab(page: Page, node: string = NODE) {
  await open(page, 'Nodes', node)
  const detail = panel(page, 'Node', node)
  await detail.getByRole('button', { name: 'Shell', exact: true }).click()
  await expect(detail.getByRole('tab', { name: 'Shell' })).toHaveAttribute('aria-selected', 'true')
  return detail
}

test.beforeEach(async ({ page }) => {
  await openCluster(page)
})

test('a shell on a node, through a pod that’s gone when it ends', async ({ page, clusters }) => {
  const detail = await shellTab(page)
  // Nothing starts until asked: what would, first.
  await expect(detail.getByRole('heading', { name: `A shell on ${NODE}` })).toBeVisible()
  await expect(detail).toContainText(
    `Lumovi starts a privileged pod on ${NODE} and opens a shell in the node’s own namespaces: you’re root on the node. The pod is deleted when the shell ends.`,
  )
  await expect(detail).toContainText('Podkube-system/lumovi-node-shell-…')
  await expect(detail).toContainText('Imagealpine:3.22')
  expect(podsCreated(clusters.demo)).toEqual([])

  await detail.getByRole('button', { name: 'Start shell' }).click()
  await expect(screen(page)).toContainText(
    `› Starting a pod on ${NODE} from alpine:3.22, in kube-system…`,
  )
  await expect(screen(page)).toContainText(`root@${NODE}:~#`)
  const pod = await startedPod(clusters.demo)
  await expect(screen(page)).toContainText(
    `› You’re root on ${NODE}. kube-system/${pod} is deleted when this shell ends.`,
  )
  // The pod: on the node, sharing its namespaces, privileged, with no API access of its own.
  const created = clusters.demo.requests.find(
    (r) => r.method === 'POST' && r.path === '/api/v1/namespaces/kube-system/pods',
  )!
  expect(created.body).toMatchObject({
    metadata: {
      generateName: 'lumovi-node-shell-',
      labels: { 'app.kubernetes.io/managed-by': 'lumovi' },
      annotations: { 'lumovi.dev/node': NODE },
    },
    spec: {
      nodeName: NODE,
      hostPID: true,
      hostNetwork: true,
      hostIPC: true,
      tolerations: [{ operator: 'Exists' }],
      automountServiceAccountToken: false,
      activeDeadlineSeconds: 43200,
      containers: [{ name: 'shell', image: 'alpine:3.22', securityContext: { privileged: true } }],
      volumes: [{ name: 'host', hostPath: { path: '/' } }],
    },
  })
  const exec = clusters.demo.requests.findLast((r) => r.path.endsWith(`/pods/${pod}/exec`))!
  expect(exec.search).toContain('container=shell')
  expect(new URLSearchParams(exec.search).getAll('command').slice(0, 4)).toEqual([
    'env',
    'TERM=xterm-256color',
    'nsenter',
    '--target',
  ])

  await page.keyboard.type('hostname')
  await page.keyboard.press('Enter')
  await expect(screen(page)).toContainText(new RegExp(`hostname\\s*${NODE}`))
  // While it runs, where it runs can't change.
  await expect(detail.getByRole('combobox', { name: 'Where' })).toBeDisabled()

  // Ending it deletes the pod, and says what starting does again.
  await detail.getByRole('button', { name: 'End' }).click()
  await expect
    .poll(() => clusters.demo.requests.some((r) => r.method === 'DELETE' && r.path.endsWith(pod)))
    .toBe(true)
  expect(clusters.demo.object('Pod', 'kube-system', pod)).toBeUndefined()
  await expect(detail.getByRole('button', { name: 'Start shell' })).toBeVisible()

  // In the pod instead: the node's files are under /host.
  await detail.getByRole('combobox', { name: 'Where' }).selectOption('pod')
  await expect(detail).toContainText('opens a shell in it, with the node’s files under /host')
  await detail.getByRole('button', { name: 'Start shell' }).click()
  await expect(screen(page)).toContainText('/host #')
  const second = await startedPod(clusters.demo)
  await expect(screen(page)).toContainText(
    `› You’re in kube-system/${second}, with ${NODE}’s files under /host. It’s deleted when this shell ends.`,
  )
  await page.keyboard.type('pwd')
  await page.keyboard.press('Enter')
  await expect(screen(page)).toContainText(/pwd\s*\/host/)
  // The shell exits by itself: the pod goes too, and it can start again.
  await page.keyboard.type('exit 3')
  await page.keyboard.press('Enter')
  const notice = detail.getByRole('status').filter({ hasText: 'The shell exited' })
  await expect(notice).toContainText('The shell exited with code 3.Its pod was deleted.')
  await expect.poll(() => clusters.demo.object('Pod', 'kube-system', second)).toBeUndefined()
  await notice.getByRole('button', { name: 'Start again' }).click()
  await expect(screen(page)).toContainText('/host #')

  // Its pod deleted meanwhile, by someone else: gone is gone.
  const third = await startedPod(clusters.demo)
  expect(third).not.toBe(second)
  clusters.demo.remove('Pod', 'kube-system', third)
  await page.keyboard.type('exit')
  await page.keyboard.press('Enter')
  await expect(detail.getByRole('status').filter({ hasText: 'The shell exited' })).toContainText(
    'The shell exited with code 0.Its pod was deleted.',
  )
})

test('where node shells run, and what stops them', async ({ page, clusters }) => {
  const detail = await shellTab(page)
  // The settings: where its pod is created, and what it runs, with the command that does the same.
  await detail.getByRole('button', { name: 'Settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Node shells' })
  await expect(settings).toContainText(
    `kubectl debug node/${NODE} -it --image alpine:3.22 --profile sysadmin -- nsenter --target 1 --mount --uts --ipc --net --pid -- sh -l -n kube-system --context demo`,
  )
  const namespace = settings.getByRole('textbox', { name: 'Namespace' })
  const image = settings.getByRole('textbox', { name: 'Image' })
  await namespace.fill('Not A Namespace')
  await expect(namespace).toHaveAttribute('aria-invalid', 'true')
  await expect(settings.getByRole('button', { name: 'Save' })).toBeDisabled()
  await namespace.fill('data')
  await image.fill('registry.example.com/alpine-does-not-exist:1')
  await expect(settings).toContainText('--image registry.example.com/alpine-does-not-exist:1')
  await settings.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText(
    'Node shell settings saved',
  )
  await expect(detail).toContainText('Poddata/lumovi-node-shell-…')

  // An image the node can't pull: it says so, and the pod goes.
  await detail.getByRole('button', { name: 'Start shell' }).click()
  const notice = detail.getByRole('status').filter({ hasText: 'couldn’t start' })
  await expect(notice).toContainText(
    `${NODE} couldn’t start registry.example.com/alpine-does-not-exist:1 (ErrImagePull): failed to pull and unpack image "docker.io/library/registry.example.com/alpine-does-not-exist:1": not found. Choose an image it can pull in the node shell’s settings.`,
  )
  await expect
    .poll(() =>
      clusters.demo.requests.some(
        (r) => r.method === 'DELETE' && r.path.startsWith('/api/v1/namespaces/data/pods/'),
      ),
    )
    .toBe(true)
  // Back to the defaults, from the notice's Settings.
  await notice.getByRole('button', { name: 'Settings' }).click()
  await settings.getByRole('button', { name: 'Use the defaults: kube-system, alpine:3.22' }).click()
  await expect(detail).toContainText('Podkube-system/lumovi-node-shell-…')

  // A namespace whose Pod Security doesn't allow privileged pods.
  const security = clusters.demo.fail('/api/v1/namespaces/kube-system/pods', {
    status: 403,
    body: JSON.stringify({
      kind: 'Status',
      status: 'Failure',
      reason: 'Forbidden',
      code: 403,
      message:
        'pods "lumovi-node-shell-x" is forbidden: violates PodSecurity "baseline:latest": host namespaces (hostNetwork=true, hostPID=true, hostIPC=true), privileged (container "shell" must not set securityContext.privileged=true)',
    }),
  })
  await detail.getByRole('button', { name: 'Start shell' }).click()
  await expect(detail.getByRole('status')).toContainText(
    'kube-system doesn’t allow privileged pods: its Pod Security level is stricter than privileged. Choose a namespace that allows them in the node shell’s settings.',
  )
  // Refused otherwise: what Kubernetes said.
  security()
  const quota = clusters.demo.fail('/api/v1/namespaces/kube-system/pods', {
    status: 403,
    body: JSON.stringify({
      kind: 'Status',
      code: 403,
      message: 'pods "lumovi-node-shell-x" is forbidden: exceeded quota: pods',
    }),
  })
  await detail.getByRole('button', { name: 'Try again' }).click()
  await expect(detail.getByRole('status')).toContainText(
    'Lumovi couldn’t create the node shell’s pod: pods "lumovi-node-shell-x" is forbidden: exceeded quota: pods',
  )
  quota()

  // A node too full to take it.
  const node = clusters.demo.object('Node', undefined, NODE)!
  clusters.demo.upsert({
    ...node,
    metadata: { ...node.metadata, annotations: { 'lumovi.test/full': 'true' } },
  })
  await detail.getByRole('button', { name: 'Try again' }).click()
  await expect(detail.getByRole('status')).toContainText(
    `${NODE} refused the node shell’s pod (OutOfpods): Node didn’t have enough resource: pods, requested: 1, used: 110, capacity: 110`,
  )
})

test('nodes without a shell, and nodes that can’t have one', async ({ page, clusters }) => {
  // Talos: no shell on the node; the pod's is offered.
  const node = clusters.demo.object('Node', undefined, DEMO.nodes.worker2)!
  clusters.demo.upsert({
    ...node,
    status: { ...node.status, nodeInfo: { ...node.status.nodeInfo, osImage: 'Talos (v1.10.4)' } },
  })
  const detail = await shellTab(page, DEMO.nodes.worker2)
  await detail.getByRole('button', { name: 'Start shell' }).click()
  const notice = detail.getByRole('status').filter({ hasText: 'has no shell' })
  await expect(notice).toContainText(
    `${DEMO.nodes.worker2} has no shell of its own.Talos and Bottlerocket nodes, say, have none. The pod’s shell has the node’s files under /host.`,
  )
  await notice.getByRole('button', { name: 'Shell in the pod' }).click()
  await expect(screen(page, DEMO.nodes.worker2)).toContainText('/host #')
  await expect(detail.getByRole('combobox', { name: 'Where' })).toHaveValue('pod')

  // Its pod's process gone under it, the shell ends with the connection; and a pod that
  // can't be deleted is said to be left.
  const pod = await startedPod(clusters.demo)
  const deletable = clusters.demo.fail(`/api/v1/namespaces/kube-system/pods/${pod}`, {
    status: 503,
    body: 'etcd is down',
  })
  await page.keyboard.type('kill -9 1')
  await page.keyboard.press('Enter')
  const closed = detail.getByRole('status').filter({ hasText: 'closed' })
  await expect(closed).toContainText(
    `The connection to the container closed.Lumovi couldn’t delete its pod, kube-system/${pod}: `,
  )
  await expect(closed).toContainText('It stops by itself within 12 hours.')
  deletable()

  // An image without a shell (distroless, say): its settings choose another.
  await detail.getByRole('button', { name: 'Settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Node shells' })
  await settings.getByRole('textbox', { name: 'Image' }).fill('gcr.io/distroless/static-debian12')
  await settings.getByRole('button', { name: 'Save' }).click()
  await closed.getByRole('button', { name: 'Start again' }).click()
  const imageless = detail.getByRole('status').filter({ hasText: 'has no shell' })
  await expect(imageless).toContainText(
    'gcr.io/distroless/static-debian12 has no shell.A node shell’s image needs sh, and nsenter for shells on the node itself: alpine has both. Its pod was deleted.',
  )
  await imageless.getByRole('button', { name: 'Settings' }).click()
  await settings.getByRole('button', { name: /^Use the defaults/ }).click()
  await expect(detail.getByRole('button', { name: 'Start shell' })).toBeEnabled()

  // A node that isn't ready may not start it; Windows nodes can't have one.
  await open(page, 'Nodes', DEMO.nodes.worker3)
  const notReady = panel(page, 'Node', DEMO.nodes.worker3)
  await notReady.getByRole('tab', { name: 'Shell' }).click()
  await expect(notReady).toContainText(
    `${DEMO.nodes.worker3} isn’t ready: its kubelet may not start the pod.`,
  )
  const windows = clusters.demo.object('Node', undefined, DEMO.nodes.controlPlane)!
  clusters.demo.upsert({
    ...windows,
    status: {
      ...windows.status,
      nodeInfo: { ...windows.status.nodeInfo, operatingSystem: 'windows' },
    },
  })
  await open(page, 'Nodes', DEMO.nodes.controlPlane)
  const windowsNode = panel(page, 'Node', DEMO.nodes.controlPlane)
  await windowsNode.getByRole('tab', { name: 'Shell' }).click()
  await expect(windowsNode).toContainText('Node shells need a Linux node')
})

test('who may open node shells', async ({ page, clusters }) => {
  clusters.demo.deny({ verb: 'delete', resource: 'pods', namespace: 'kube-system' })
  const detail = await shellTab(page)
  await expect(detail).toContainText(
    'Your account can’t delete pods in kube-system: the pod stays until its 12-hour deadline.',
  )
  clusters.demo.deny({
    verb: 'create',
    resource: 'pods',
    subresource: 'exec',
    namespace: 'kube-system',
  })
  // (A reload asks again.)
  await page.reload()
  const denied = await shellTab(page)
  await expect(denied).toContainText('No node shell access')
  await expect(denied).toContainText(
    'Your account can’t create pods in kube-system, or open shells in them.',
  )
  clusters.demo.deny({ verb: 'create', resource: 'pods', namespace: 'kube-system' })
  await page.reload()
  await shellTab(page)
  await expect(denied).toContainText('No node shell access')
  // Its settings can still change, to a namespace where it may.
  await denied.getByRole('button', { name: 'Settings' }).click()
  await page
    .getByRole('dialog', { name: 'Node shells' })
    .getByRole('button', { name: 'Cancel' })
    .click()

  // On a read-only cluster, shells are off, on nodes too.
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('option', { name: 'Make demo read-only' }).click()
  await expect(denied).toContainText(
    'demo is read-only in Lumovi, and a node shell can change the node.',
  )
  const refused = await page.evaluate(() =>
    window.lumovi!.terminal.open('refused-node-shell', {
      target: 'node',
      context: 'demo',
      node: 'worker-1',
      mode: 'node',
    }),
  )
  expect(refused).toMatchObject({
    ok: false,
    error: {
      code: 'read-only',
      message: 'demo is read-only in Lumovi, so shells, which can change nodes, are turned off.',
    },
  })
})

test('a node shell closed while it starts, or open when the app quits, leaves no pod', async ({
  launch,
  clusters,
}) => {
  const lumovi = await launch()
  const { page } = lumovi
  await openCluster(page)
  const detail = await shellTab(page)
  // Ended while its pod is still starting.
  await detail.getByRole('button', { name: 'Start shell' }).click()
  await expect(screen(page)).toContainText('› Starting a pod')
  await detail.getByRole('button', { name: 'End' }).click()
  await expect
    .poll(() => clusters.demo.requests.filter((r) => r.method === 'DELETE').length)
    .toBe(1)

  // Open when the app quits: it waits for the pod to go.
  await detail.getByRole('button', { name: 'Start shell' }).click()
  await expect(screen(page)).toContainText(`root@${NODE}:~#`)
  const pod = await startedPod(clusters.demo)
  await lumovi.close()
  expect(clusters.demo.object('Pod', 'kube-system', pod)).toBeUndefined()
})

test('a node that never starts it', async ({ launch, clusters }) => {
  // Requests answer within half a second here, so starting gives up after three.
  const { page } = await launch({ env: { LUMOVI_REQUEST_TIMEOUT_MS: '500' } })
  await openCluster(page)
  const detail = await shellTab(page, DEMO.nodes.worker3)
  await detail.getByRole('button', { name: 'Start shell' }).click()
  await expect(detail.getByRole('status')).toContainText(
    `${DEMO.nodes.worker3} didn’t start the node shell’s pod in 3 seconds: its kubelet may not be running, or alpine:3.22 may take long to pull.`,
    { timeout: 15_000 },
  )
  await expect
    .poll(() => clusters.demo.requests.filter((r) => r.method === 'DELETE').length)
    .toBe(1)
})

/**
 * Shells on nodes, as `kubectl debug node` gives them: a short-lived
 * privileged pod on the node, sharing its process, network and IPC
 * namespaces, that a shell is opened in. In the node's own mount namespace
 * too (nsenter), it's a shell on the node, as root; in the pod itself, the
 * node's files are under /host. The pod is deleted when the shell ends.
 */
import type { KubeConfig } from '@kubernetes/client-node'
import type { KubeObject, NodeShellRequest, NodeShellSetting } from '@shared/api'
import { containerStatuses } from '@shared/health'
import { kubeRequest } from './client'
import { KubeRequestError, toKubeError } from './errors'

/** How long a node shell's pod lives at most, should Lumovi not be there to delete it. */
export const MAX_SECONDS = 12 * 60 * 60
/** How often a starting pod is looked at. */
const POLL_MS = 500

/** What the pod's container waits with when it won't start. */
const STUCK = new Set([
  'ErrImagePull',
  'ImagePullBackOff',
  'InvalidImageName',
  'ErrImageNeverPull',
  'CreateContainerConfigError',
  'CreateContainerError',
])

/** The pod a shell on `node` runs in (named by the API server). */
export function nodeShellPod(node: string, setting: NodeShellSetting) {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      generateName: 'lumovi-node-shell-',
      namespace: setting.namespace,
      labels: {
        'app.kubernetes.io/managed-by': 'lumovi',
        'app.kubernetes.io/component': 'node-shell',
      },
      // (Node names can be longer than a label's value.)
      annotations: { 'lumovi.dev/node': node },
    },
    spec: {
      // Not scheduled: placed there, so cordoned nodes and tainted ones get it too.
      nodeName: node,
      tolerations: [{ operator: 'Exists' }],
      hostPID: true,
      hostNetwork: true,
      hostIPC: true,
      restartPolicy: 'Never',
      terminationGracePeriodSeconds: 0,
      activeDeadlineSeconds: MAX_SECONDS,
      // It needs nothing of the API: no token in it.
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      containers: [
        {
          name: 'shell',
          image: setting.image,
          command: ['sleep', String(MAX_SECONDS)],
          securityContext: { privileged: true },
          volumeMounts: [{ name: 'host', mountPath: '/host' }],
        },
      ],
      volumes: [{ name: 'host', hostPath: { path: '/' } }],
    },
  }
}

/**
 * What runs in the pod: a login shell (bash where there is one) in the node's
 * own namespaces, or the image's shell in the pod, starting in /host.
 */
export function nodeShellCommand(mode: NodeShellRequest['mode']): string[] {
  const shell =
    mode === 'node'
      ? [
          // An image without nsenter says so (125), unlike a node without a shell (127).
          'sh',
          '-c',
          'command -v nsenter >/dev/null 2>&1 || exit 125; exec "$@"',
          'sh',
          'nsenter',
          '--target',
          '1',
          '--mount',
          '--uts',
          '--ipc',
          '--net',
          '--pid',
          '--',
          'sh',
          '-c',
          'cd ~ 2>/dev/null; command -v bash >/dev/null 2>&1 && exec bash -l || exec sh -l',
        ]
      : ['sh', '-c', 'cd /host && exec sh -l']
  return ['env', 'TERM=xterm-256color', ...shell]
}

/** The pod as Kubernetes refused it, in words that say what to do. */
function refused(error: unknown, setting: NodeShellSetting): KubeRequestError {
  const kubeError = toKubeError(error)
  if (/violates PodSecurity/.test(kubeError.message)) {
    return new KubeRequestError(
      'forbidden',
      `${setting.namespace} doesn’t allow privileged pods: its Pod Security level is stricter than privileged. Choose a namespace that allows them in the node shell’s settings.`,
    )
  }
  return new KubeRequestError(
    kubeError.code,
    `Lumovi couldn’t create the node shell’s pod: ${kubeError.message}`,
  )
}

/** Creates the pod; resolves with its name. */
export async function createNodeShell(
  kc: KubeConfig,
  node: string,
  setting: NodeShellSetting,
  timeoutMs: number,
): Promise<string> {
  try {
    const created = JSON.parse(
      await kubeRequest(kc, `/api/v1/namespaces/${encodeURIComponent(setting.namespace)}/pods`, {
        method: 'POST',
        body: nodeShellPod(node, setting),
        timeoutMs,
      }),
    ) as KubeObject
    return created.metadata.name
  } catch (error) {
    throw refused(error, setting)
  }
}

/**
 * Waits until the pod's container runs: for the node to pull the image and
 * start it, `timeoutMs` at most. `stop` says whether to give up (the shell
 * was closed meanwhile).
 */
export async function waitForNodeShell(
  kc: KubeConfig,
  request: { node: string; namespace: string; name: string; image: string },
  options: { timeoutMs: number; requestTimeoutMs: number; stop: () => boolean },
): Promise<boolean> {
  const { node, namespace, name, image } = request
  const path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(name)}`
  const deadline = Date.now() + options.timeoutMs
  for (;;) {
    if (options.stop()) return false
    const pod = JSON.parse(
      await kubeRequest(kc, path, { timeoutMs: options.requestTimeoutMs }),
    ) as KubeObject
    // Until the node takes the pod, it has no status of its container.
    const [status] = containerStatuses(pod)
    if (status?.state!.running) return true
    const waiting = status?.state!.waiting
    if (waiting && STUCK.has(waiting.reason!)) {
      throw new KubeRequestError(
        'invalid',
        `${node} couldn’t start ${image} (${waiting.reason}): ${waiting.message}. Choose an image it can pull in the node shell’s settings.`,
      )
    }
    if (pod.status?.phase === 'Failed') {
      throw new KubeRequestError(
        'invalid',
        `${node} refused the node shell’s pod (${pod.status.reason}): ${pod.status.message}`,
      )
    }
    if (Date.now() > deadline) {
      throw new KubeRequestError(
        'timeout',
        `${node} didn’t start the node shell’s pod in ${Math.round(options.timeoutMs / 1000)} seconds: its kubelet may not be running, or ${image} may take long to pull.`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

/**
 * Deletes the pod, at once; one that's gone already is fine. Resolves with
 * what to say if it's still there: why, and that it stops by itself.
 */
export async function deleteNodeShell(
  kc: KubeConfig,
  namespace: string,
  name: string,
  timeoutMs: number,
): Promise<string | undefined> {
  try {
    await kubeRequest(
      kc,
      `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(name)}`,
      { method: 'DELETE', body: { gracePeriodSeconds: 0 }, timeoutMs },
    )
  } catch (error) {
    const kubeError = toKubeError(error)
    if (kubeError.code === 'not-found') return undefined
    return `Lumovi couldn’t delete its pod, ${namespace}/${name}: ${kubeError.message.replace(/\.$/, '')}. It stops by itself within ${MAX_SECONDS / 3600} hours.`
  }
  return undefined
}

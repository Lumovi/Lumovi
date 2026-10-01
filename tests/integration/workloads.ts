/** The objects the integration tests run, built per namespace. */
import { IMAGES } from './cluster.ts'

const labels = (app: string) => ({ app })

// busybox ignores SIGTERM; don't wait 30 seconds for every pod to go.
const quick = { terminationGracePeriodSeconds: 1 }

/** nginx, spread over the workers, with requests and limits to chart against. */
export function web(replicas = 2) {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'web', annotations: { 'kubernetes.io/change-cause': 'first release' } },
    spec: {
      replicas,
      selector: { matchLabels: labels('web') },
      template: {
        metadata: { labels: labels('web') },
        spec: {
          topologySpreadConstraints: [
            {
              maxSkew: 1,
              topologyKey: 'kubernetes.io/hostname',
              whenUnsatisfiable: 'DoNotSchedule',
              // The control plane is tainted: it isn't a place to spread to.
              nodeTaintsPolicy: 'Honor',
              labelSelector: { matchLabels: labels('web') },
            },
          ],
          containers: [
            {
              name: 'web',
              image: IMAGES.web,
              ports: [{ name: 'http', containerPort: 80 }],
              readinessProbe: { httpGet: { path: '/', port: 80 }, periodSeconds: 2 },
              resources: {
                requests: { cpu: '50m', memory: '32Mi' },
                limits: { cpu: '200m', memory: '128Mi' },
              },
            },
          ],
        },
      },
    },
  }
}

export function webService() {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: 'web' },
    spec: { selector: labels('web'), ports: [{ name: 'http', port: 80, targetPort: 'http' }] },
  }
}

/** Keeps both web pods available: evicting either is refused. */
export function webBudget() {
  return {
    apiVersion: 'policy/v1',
    kind: 'PodDisruptionBudget',
    metadata: { name: 'web' },
    spec: { minAvailable: 2, selector: { matchLabels: labels('web') } },
  }
}

/** A pod with a shell, in a StatefulSet. */
export function db() {
  return [
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'db' },
      spec: { clusterIP: 'None', selector: labels('db'), ports: [{ port: 5432 }] },
    },
    {
      apiVersion: 'apps/v1',
      kind: 'StatefulSet',
      metadata: { name: 'db' },
      spec: {
        serviceName: 'db',
        replicas: 1,
        selector: { matchLabels: labels('db') },
        template: {
          metadata: { labels: labels('db') },
          spec: {
            ...quick,
            containers: [{ name: 'db', image: IMAGES.shell, command: ['sh', '-c', 'sleep 86400'] }],
          },
        },
      },
    },
  ]
}

/** A pod without a shell: the pause image is a single static binary. */
export function bare() {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'bare', labels: labels('bare') },
    spec: { ...quick, containers: [{ name: 'bare', image: IMAGES.noShell }] },
  }
}

/** A container that exits every few seconds, so it keeps restarting. */
export function crash() {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'crash' },
    spec: {
      replicas: 1,
      selector: { matchLabels: labels('crash') },
      template: {
        metadata: { labels: labels('crash') },
        spec: {
          ...quick,
          containers: [
            { name: 'crash', image: IMAGES.shell, command: ['sh', '-c', 'sleep 2; exit 1'] },
          ],
        },
      },
    },
  }
}

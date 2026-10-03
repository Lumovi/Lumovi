/**
 * "demo": a realistic small production-like cluster with a mix of healthy and
 * unhealthy resources. Everything is deterministic except timestamps, which
 * are relative to the moment the fixture is built.
 */
import {
  base64,
  clusterBuilder,
  DAY,
  generatedPodName,
  Gi,
  HOUR,
  Mi,
  MINUTE,
  replicaSetName,
  SECOND,
  uidFor,
  withState,
  type ContainerInput,
  type PodTemplate,
} from '../builders.ts'
import type { ClusterFixture, KubeObject } from '../types.ts'
import { CUSTOM, demoCustomResources } from './custom.ts'
import { demoHelmReleases } from './helm.ts'
import { demoLogs } from './demo-logs.ts'

const REVISION = {
  storefront: 4,
  checkout: 7,
  cart: 2,
  recommendations: 5,
  prometheus: 1,
  grafana: 3,
  coredns: 1,
  metricsServer: 1,
} as const

const rsPods = (namespace: string, deployment: string, revision: number, count: number) =>
  Array.from({ length: count }, (_, i) =>
    generatedPodName(replicaSetName(namespace, deployment, revision), i),
  )

const NODE_NAMES = ['control-plane-1', 'worker-1', 'worker-2', 'worker-3'] as const

/** Stable names tests can refer to. */
export const DEMO = {
  gitVersion: 'v1.34.1',
  nodes: {
    controlPlane: 'control-plane-1',
    worker1: 'worker-1',
    /** Ready, but under memory pressure. */
    worker2: 'worker-2',
    /** Not ready (kubelet stopped reporting) and cordoned. */
    worker3: 'worker-3',
  },
  namespaces: ['default', 'kube-system', 'shop', 'monitoring', 'data', 'batch', 'legacy'],
  terminatingNamespace: 'legacy',
  deployments: {
    storefront: 'storefront',
    checkout: 'checkout',
    cart: 'cart',
    recommendations: 'recommendations',
  },
  replicaSets: {
    storefront: replicaSetName('shop', 'storefront', REVISION.storefront),
    storefrontPrevious: replicaSetName('shop', 'storefront', REVISION.storefront - 1),
    checkout: replicaSetName('shop', 'checkout', REVISION.checkout),
    cart: replicaSetName('shop', 'cart', REVISION.cart),
    recommendations: replicaSetName('shop', 'recommendations', REVISION.recommendations),
  },
  pods: {
    storefront: rsPods('shop', 'storefront', REVISION.storefront, 3),
    /** The first two crash-loop; the third is healthy. */
    checkout: rsPods('shop', 'checkout', REVISION.checkout, 3),
    cart: rsPods('shop', 'cart', REVISION.cart, 2),
    /** Stuck in ImagePullBackOff. */
    recommendations: rsPods('shop', 'recommendations', REVISION.recommendations, 1),
    postgres: ['postgres-0', 'postgres-1', 'postgres-2'],
    /** `redis-1` is Pending (unschedulable). */
    redis: ['redis-0', 'redis-1'],
    /** One per node, in node order; the last one runs on worker-3 and is not ready. */
    nodeExporter: NODE_NAMES.map((_, i) => generatedPodName('node-exporter', i)),
    kubeProxy: NODE_NAMES.map((_, i) => generatedPodName('kube-proxy', i)),
    coredns: rsPods('kube-system', 'coredns', REVISION.coredns, 2),
    metricsServer: rsPods('kube-system', 'metrics-server', REVISION.metricsServer, 1),
    prometheus: rsPods('monitoring', 'prometheus', REVISION.prometheus, 1),
    grafana: rsPods('monitoring', 'grafana', REVISION.grafana, 1),
    etcd: 'etcd-control-plane-1',
    apiserver: 'kube-apiserver-control-plane-1',
    controllerManager: 'kube-controller-manager-control-plane-1',
    scheduler: 'kube-scheduler-control-plane-1',
    nightlyReport: generatedPodName('nightly-report-29310', 0),
    /** Both Failed (exit code 2). */
    dbMigrate: [generatedPodName('db-migrate', 0), generatedPodName('db-migrate', 1)],
    reindex: generatedPodName('reindex', 0),
    debugShell: 'debug-shell',
    oldTask: 'old-task',
    stuckTerminating: 'stuck-terminating',
  },
  statefulSets: { postgres: 'postgres', redis: 'redis' },
  daemonSets: { nodeExporter: 'node-exporter', kubeProxy: 'kube-proxy' },
  jobs: { nightlyReport: 'nightly-report-29310', dbMigrate: 'db-migrate', reindex: 'reindex' },
  cronJobs: { nightlyReport: 'nightly-report', cleanup: 'cleanup' },
  services: {
    storefront: 'storefront',
    legacyGateway: 'legacy-gateway',
    postgres: 'postgres',
    grafana: 'grafana',
    kubernetes: 'kubernetes',
  },
  secrets: {
    storefrontTls: 'storefront-tls',
    registryPull: 'registry-pull',
    postgresCredentials: 'postgres-credentials',
  },
  postgresPassword: 's3cr3t-p4ssw0rd',
  loadBalancerIp: '203.0.113.10',
} as const

const shopLabels = (name: string, component = 'backend') => ({
  'app.kubernetes.io/name': name,
  'app.kubernetes.io/part-of': 'shop',
  'app.kubernetes.io/component': component,
})

function kubeRootCa(
  b: ReturnType<typeof clusterBuilder>,
  namespace: string,
  age: number,
): KubeObject {
  return b.simple(
    'v1',
    'ConfigMap',
    'kube-root-ca.crt',
    namespace,
    age,
    {
      data: {
        'ca.crt':
          '-----BEGIN CERTIFICATE-----\nMIIDBTCCAe2gAwIBAgIIKubeStacksDemoCAwDQYJKoZIhvcNAQELBQAwFTETMBEG\nA1UEAxMKa3ViZXJuZXRlczAeFw0yNTA1MjgwOTAwMDBaFw0zNTA1MjYwOTA1MDBa\n-----END CERTIFICATE-----\n',
      },
    },
    {
      annotations: {
        'kubernetes.io/description':
          'Contains a CA bundle that can be used to verify the kube-apiserver when using internal endpoints such as the internal service IP or kubernetes.default.svc. No other usage is guaranteed across distributions of Kubernetes clusters.',
      },
    },
  )
}

/** What Karpenter labels the nodes it launches with (the workers are its, from one node pool). */
function karpenterLabels(capacity: 'on-demand' | 'spot'): Record<string, string> {
  return {
    'karpenter.sh/nodepool': CUSTOM.karpenter.nodePools.general,
    'karpenter.sh/capacity-type': capacity,
    'karpenter.sh/registered': 'true',
    'karpenter.sh/initialized': 'true',
    'karpenter.k8s.aws/ec2nodeclass': CUSTOM.karpenter.nodeClasses.default,
    'karpenter.k8s.aws/instance-family': 'm6i',
  }
}

export function demoCluster(now = Date.now()): ClusterFixture {
  const b = clusterBuilder(now)
  const clusterAge = 800 * DAY

  // ── Nodes ────────────────────────────────────────────────────────────────
  const nodes = {
    controlPlane: b.node({
      name: 'control-plane-1',
      age: clusterAge,
      ip: '10.0.1.10',
      zone: 'eu-west-1a',
      instanceType: 'm6i.xlarge',
      role: 'control-plane',
      cpu: 4,
      memoryGi: 16,
      usage: { cpu: 0.35, memory: 0.48 },
    }),
    worker1: b.node({
      name: 'worker-1',
      labels: karpenterLabels('on-demand'),
      age: clusterAge - HOUR,
      ip: '10.0.1.11',
      zone: 'eu-west-1a',
      instanceType: 'm6i.2xlarge',
      cpu: 8,
      memoryGi: 32,
      usage: { cpu: 0.82, memory: 0.61 },
    }),
    worker2: b.node({
      name: 'worker-2',
      labels: karpenterLabels('spot'),
      age: 96 * DAY,
      ip: '10.0.1.12',
      zone: 'eu-west-1b',
      instanceType: 'm6i.2xlarge',
      cpu: 8,
      memoryGi: 32,
      memoryPressure: true,
      usage: { cpu: 0.45, memory: 0.93 },
    }),
    worker3: b.node({
      name: 'worker-3',
      labels: karpenterLabels('spot'),
      age: 45 * DAY,
      ip: '10.0.1.13',
      zone: 'eu-west-1c',
      instanceType: 'm6i.2xlarge',
      cpu: 8,
      memoryGi: 32,
      ready: 'Unknown',
      unschedulable: true,
      lastHeartbeatAgo: 53 * MINUTE,
    }),
  }

  // ── Namespaces ───────────────────────────────────────────────────────────
  const namespaceAges: Record<string, number> = {
    default: clusterAge,
    'kube-system': clusterAge,
    shop: 88 * DAY,
    monitoring: 110 * DAY,
    data: 95 * DAY,
    batch: 60 * DAY,
  }
  for (const [name, age] of Object.entries(namespaceAges)) {
    b.namespace(name, age)
    kubeRootCa(b, name, age)
  }
  b.namespace('legacy', 118 * DAY, 3 * HOUR)
  b.simple(
    'v1',
    'ConfigMap',
    'legacy-settings',
    'legacy',
    118 * DAY,
    { data: { MODE: 'readonly' } },
    {
      finalizers: ['example.com/archive-before-delete'],
      deletionTimestamp: b.time(3 * HOUR),
    },
  )

  // ── kube-system ──────────────────────────────────────────────────────────
  const staticPod = (
    name: string,
    component: string,
    image: string,
    cpu: string,
    usage: [number, number],
    memory?: string,
  ) =>
    b.pod({
      namespace: 'kube-system',
      name: `${name}-control-plane-1`,
      age: 34 * DAY,
      node: 'control-plane-1',
      owner: nodes.controlPlane,
      labels: { component, tier: 'control-plane' },
      annotations: {
        'kubernetes.io/config.source': 'file',
        'kubernetes.io/config.hash': `${component}-${name.length}a7f3`,
        'kubernetes.io/config.mirror': `${component}-${name.length}a7f3`,
      },
      priorityClassName: 'system-node-critical',
      hostNetwork: true,
      tolerations: [{ operator: 'Exists', effect: 'NoExecute' }],
      containers: [
        {
          name: component,
          image,
          cpu: [cpu],
          ...(memory ? { memory: [memory] as [string] } : {}),
          usage,
        },
      ],
    })
  staticPod('etcd', 'etcd', 'registry.k8s.io/etcd:3.6.4-0', '100m', [0.089, 312 * Mi], '100Mi')
  staticPod('kube-apiserver', 'kube-apiserver', 'registry.k8s.io/kube-apiserver:v1.34.1', '250m', [
    0.21,
    890 * Mi,
  ])
  staticPod(
    'kube-controller-manager',
    'kube-controller-manager',
    'registry.k8s.io/kube-controller-manager:v1.34.1',
    '200m',
    [0.035, 120 * Mi],
  )
  staticPod('kube-scheduler', 'kube-scheduler', 'registry.k8s.io/kube-scheduler:v1.34.1', '100m', [
    0.009,
    48 * Mi,
  ])

  const corednsTemplate: PodTemplate = {
    labels: { 'k8s-app': 'kube-dns', 'app.kubernetes.io/name': 'coredns' },
    serviceAccount: 'coredns',
    priorityClassName: 'system-cluster-critical',
    containers: [
      {
        name: 'coredns',
        image: 'registry.k8s.io/coredns/coredns:v1.12.1',
        args: ['-conf', '/etc/coredns/Corefile'],
        cpu: ['100m'],
        memory: ['70Mi', '170Mi'],
        probe: { path: '/ready', port: 8181 },
        ports: [
          { name: 'dns', containerPort: 53, protocol: 'UDP' },
          { name: 'dns-tcp', containerPort: 53 },
          { name: 'metrics', containerPort: 9153 },
        ],
      },
    ],
  }
  const coredns = b.deployment({
    namespace: 'kube-system',
    name: 'coredns',
    age: clusterAge,
    replicas: 2,
    ready: 2,
    template: corednsTemplate,
    labels: { 'k8s-app': 'kube-dns' },
  })
  for (let i = 0; i < 2; i++) {
    b.pod({
      ...corednsTemplate,
      namespace: 'kube-system',
      name: coredns.podName(i),
      generateName: coredns.generateName,
      age: 34 * DAY,
      node: 'control-plane-1',
      owner: coredns.replicaSet,
      labels: coredns.podLabels,
      containers: withState(corednsTemplate.containers, {
        coredns: { usage: [0.006 + i * 0.002, (24 + i * 3) * Mi] },
      }),
      tolerations: [
        { key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' },
        { key: 'CriticalAddonsOnly', operator: 'Exists' },
      ],
    })
  }

  const metricsTemplate: PodTemplate = {
    labels: { 'k8s-app': 'metrics-server', 'app.kubernetes.io/name': 'metrics-server' },
    serviceAccount: 'metrics-server',
    priorityClassName: 'system-cluster-critical',
    containers: [
      {
        name: 'metrics-server',
        image: 'registry.k8s.io/metrics-server/metrics-server:v0.8.0',
        args: [
          '--cert-dir=/tmp',
          '--secure-port=10250',
          '--kubelet-preferred-address-types=InternalIP',
          '--metric-resolution=15s',
        ],
        cpu: ['100m'],
        memory: ['200Mi'],
        probe: { path: '/readyz', port: 10250 },
        ports: [{ name: 'https', containerPort: 10250 }],
      },
    ],
  }
  const metricsServer = b.deployment({
    namespace: 'kube-system',
    name: 'metrics-server',
    age: clusterAge - DAY,
    replicas: 1,
    ready: 1,
    template: metricsTemplate,
  })
  b.pod({
    ...metricsTemplate,
    namespace: 'kube-system',
    name: metricsServer.podName(0),
    generateName: metricsServer.generateName,
    age: 21 * DAY,
    node: 'worker-1',
    owner: metricsServer.replicaSet,
    labels: metricsServer.podLabels,
    containers: withState(metricsTemplate.containers, {
      'metrics-server': { usage: [0.011, 41 * Mi] },
    }),
  })

  const kubeProxyTemplate: PodTemplate = {
    labels: { 'k8s-app': 'kube-proxy', 'app.kubernetes.io/name': 'kube-proxy' },
    serviceAccount: 'kube-proxy',
    priorityClassName: 'system-node-critical',
    hostNetwork: true,
    tolerations: [{ operator: 'Exists' }],
    containers: [
      {
        name: 'kube-proxy',
        image: 'registry.k8s.io/kube-proxy:v1.34.1',
        command: ['/usr/local/bin/kube-proxy', '--config=/var/lib/kube-proxy/config.conf'],
      },
    ],
  }
  const kubeProxy = b.daemonSet({
    namespace: 'kube-system',
    name: 'kube-proxy',
    age: clusterAge,
    desired: 4,
    ready: 4,
    template: kubeProxyTemplate,
  })
  NODE_NAMES.forEach((node, i) =>
    b.pod({
      ...kubeProxyTemplate,
      namespace: 'kube-system',
      name: kubeProxy.podName(i),
      generateName: kubeProxy.generateName,
      age: i === 3 ? 45 * DAY : 34 * DAY,
      node,
      owner: kubeProxy.daemonSet,
      labels: kubeProxy.podLabels,
      containers: withState(kubeProxyTemplate.containers, {
        'kube-proxy': i === 3 ? {} : { usage: [0.003 + i * 0.001, (29 + i * 2) * Mi] },
      }),
    }),
  )
  b.service({
    namespace: 'kube-system',
    name: 'kube-dns',
    age: clusterAge,
    clusterIP: '10.96.0.10',
    selector: { 'k8s-app': 'kube-dns' },
    labels: { 'k8s-app': 'kube-dns', 'kubernetes.io/name': 'CoreDNS' },
    ports: [
      { name: 'dns', port: 53, protocol: 'UDP' },
      { name: 'dns-tcp', port: 53 },
      { name: 'metrics', port: 9153 },
    ],
  })
  b.service({
    namespace: 'kube-system',
    name: 'metrics-server',
    age: clusterAge - DAY,
    clusterIP: '10.96.12.77',
    selector: { 'k8s-app': 'metrics-server' },
    ports: [{ name: 'https', port: 443, targetPort: 'https' }],
  })
  b.simple('v1', 'ConfigMap', 'coredns', 'kube-system', clusterAge, {
    data: {
      Corefile:
        '.:53 {\n    errors\n    health {\n       lameduck 5s\n    }\n    ready\n    kubernetes cluster.local in-addr.arpa ip6.arpa {\n       pods insecure\n       fallthrough in-addr.arpa ip6.arpa\n       ttl 30\n    }\n    prometheus :9153\n    forward . /etc/resolv.conf\n    cache 30\n    loop\n    reload\n    loadbalance\n}\n',
    },
  })

  // ── shop ─────────────────────────────────────────────────────────────────
  const storefrontContainers: ContainerInput[] = [
    {
      name: 'app',
      image: 'ghcr.io/acme/storefront:v3.8.2',
      cpu: ['250m', '1'],
      memory: ['256Mi', '512Mi'],
      ports: [{ name: 'http', containerPort: 8080 }],
      probe: { path: '/healthz', port: 8080 },
      env: [
        { name: 'LOG_LEVEL', value: 'info' },
        { name: 'CART_URL', value: 'http://cart.shop:8080' },
      ],
      mounts: [{ name: 'config', mountPath: '/etc/storefront', readOnly: true }],
    },
    {
      name: 'envoy',
      image: 'envoyproxy/envoy:v1.35.1',
      cpu: ['100m', '500m'],
      memory: ['64Mi', '128Mi'],
      ports: [
        { name: 'https', containerPort: 8443 },
        { name: 'admin', containerPort: 9901 },
      ],
    },
  ]
  const storefrontTemplate: PodTemplate = {
    labels: shopLabels('storefront', 'frontend'),
    annotations: { 'prometheus.io/scrape': 'true', 'prometheus.io/port': '9901' },
    serviceAccount: 'storefront',
    containers: storefrontContainers,
    initContainers: [
      {
        name: 'migrate',
        image: 'ghcr.io/acme/storefront:v3.8.2',
        command: ['/app/migrate', '--up'],
        cpu: ['100m'],
        memory: ['64Mi'],
      },
    ],
    volumes: [
      { name: 'config', configMap: { name: 'storefront-config', defaultMode: 420 } },
      { name: 'cache', emptyDir: { sizeLimit: '256Mi' } },
    ],
  }
  const storefront = b.deployment({
    namespace: 'shop',
    name: 'storefront',
    age: 88 * DAY,
    replicas: 3,
    ready: 3,
    template: storefrontTemplate,
    revision: REVISION.storefront,
    previousRevisionAge: 12 * DAY,
    previousImages: { app: 'ghcr.io/acme/storefront:v3.7.4' },
  })
  const storefrontNodes = ['worker-1', 'worker-2', 'worker-1']
  const storefrontPods = storefrontNodes.map((node, i) =>
    b.pod({
      ...storefrontTemplate,
      namespace: 'shop',
      name: storefront.podName(i),
      generateName: storefront.generateName,
      age: 3 * DAY - i * 40 * SECOND,
      node,
      owner: storefront.replicaSet,
      labels: storefront.podLabels,
      containers: withState(storefrontContainers, {
        app: { usage: [0.182 + i * 0.031, (301 + i * 17) * Mi] },
        envoy: { usage: [0.021 + i * 0.004, (48 + i * 2) * Mi] },
      }),
    }),
  )
  b.simple(
    'autoscaling/v2',
    'HorizontalPodAutoscaler',
    'storefront',
    'shop',
    60 * DAY,
    {
      spec: {
        scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'storefront' },
        minReplicas: 2,
        maxReplicas: 10,
        metrics: [
          {
            type: 'Resource',
            resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 70 } },
          },
        ],
      },
      status: {
        currentReplicas: 3,
        desiredReplicas: 3,
        lastScaleTime: b.time(2 * HOUR),
        currentMetrics: [
          {
            type: 'Resource',
            resource: { name: 'cpu', current: { averageUtilization: 64, averageValue: '160m' } },
          },
        ],
        conditions: [
          {
            type: 'AbleToScale',
            status: 'True',
            lastTransitionTime: b.time(60 * DAY),
            reason: 'ReadyForNewScale',
            message: 'recommended size matches current size',
          },
          {
            type: 'ScalingActive',
            status: 'True',
            lastTransitionTime: b.time(60 * DAY),
            reason: 'ValidMetricFound',
            message:
              'the HPA was able to successfully calculate a replica count from cpu resource utilization (percentage of request)',
          },
          {
            type: 'ScalingLimited',
            status: 'False',
            lastTransitionTime: b.time(9 * DAY),
            reason: 'DesiredWithinRange',
            message: 'the desired count is within the acceptable range',
          },
        ],
      },
    },
    { labels: shopLabels('storefront', 'frontend') },
  )

  const checkoutContainer: ContainerInput = {
    name: 'app',
    image: 'ghcr.io/acme/checkout:v1.14.0',
    cpu: ['200m', '1'],
    memory: ['256Mi', '512Mi'],
    ports: [{ name: 'http', containerPort: 8080 }],
    probe: { path: '/readyz', port: 8080 },
    env: [{ name: 'DATABASE_HOST', value: 'postgres.data.svc.cluster.local' }],
  }
  const checkoutTemplate: PodTemplate = {
    labels: shopLabels('checkout'),
    serviceAccount: 'checkout',
    containers: [checkoutContainer],
  }
  const checkout = b.deployment({
    namespace: 'shop',
    name: 'checkout',
    age: 88 * DAY,
    replicas: 3,
    ready: 1,
    template: checkoutTemplate,
    revision: REVISION.checkout,
  })
  const checkoutPods = [0, 1, 2].map((i) => {
    const crashing = i < 2
    const podName = checkout.podName(i)
    return b.pod({
      ...checkoutTemplate,
      namespace: 'shop',
      name: podName,
      generateName: checkout.generateName,
      age: crashing ? 47 * MINUTE - i * 20 * SECOND : 2 * DAY,
      node: crashing ? 'worker-2' : 'worker-1',
      owner: checkout.replicaSet,
      labels: checkout.podLabels,
      containers: [
        crashing
          ? {
              ...checkoutContainer,
              state: {
                waiting: {
                  reason: 'CrashLoopBackOff',
                  message: `back-off 5m0s restarting failed container=app pod=${podName}_shop(${'uid'})`,
                },
              },
              ready: false,
              restarts: 14 - i,
              lastTerminated: {
                exitCode: 1,
                reason: 'Error',
                startedAgo: 3 * MINUTE + i * 10 * SECOND,
                finishedAgo: 2 * MINUTE + 50 * SECOND + i * 10 * SECOND,
              },
            }
          : {
              ...checkoutContainer,
              image: 'ghcr.io/acme/checkout:v1.14.0',
              usage: [0.095, 212 * Mi],
            },
      ],
    })
  })
  for (const pod of checkoutPods.slice(0, 2)) {
    const waiting = pod.status.containerStatuses[0].state.waiting
    waiting.message = waiting.message.replace('(uid)', `(${pod.metadata.uid})`)
  }

  const cartTemplate: PodTemplate = {
    labels: shopLabels('cart'),
    containers: [
      {
        name: 'app',
        image: 'ghcr.io/acme/cart:v2.3.1',
        cpu: ['100m', '500m'],
        memory: ['128Mi', '256Mi'],
        ports: [{ name: 'http', containerPort: 8080 }],
        probe: { path: '/healthz', port: 8080 },
      },
    ],
  }
  const cart = b.deployment({
    namespace: 'shop',
    name: 'cart',
    age: 88 * DAY,
    replicas: 2,
    ready: 2,
    template: cartTemplate,
    revision: REVISION.cart,
  })
  ;['worker-1', 'worker-2'].forEach((node, i) =>
    b.pod({
      ...cartTemplate,
      namespace: 'shop',
      name: cart.podName(i),
      generateName: cart.generateName,
      age: 6 * DAY,
      node,
      owner: cart.replicaSet,
      labels: cart.podLabels,
      containers: withState(cartTemplate.containers, {
        app: { usage: [0.043 + i * 0.012, (96 + i * 11) * Mi] },
      }),
    }),
  )

  const recommendationsTemplate: PodTemplate = {
    labels: shopLabels('recommendations'),
    containers: [
      {
        name: 'app',
        image: 'ghcr.io/acme/recommendations:v2.0.0-typo',
        cpu: ['500m', '2'],
        memory: ['1Gi', '2Gi'],
        ports: [{ name: 'grpc', containerPort: 9090 }],
      },
    ],
  }
  const recommendations = b.deployment({
    namespace: 'shop',
    name: 'recommendations',
    age: 30 * DAY,
    replicas: 1,
    ready: 0,
    template: recommendationsTemplate,
    revision: REVISION.recommendations,
    progressDeadlineExceeded: true,
  })
  const recommendationsPod = b.pod({
    ...recommendationsTemplate,
    namespace: 'shop',
    name: recommendations.podName(0),
    generateName: recommendations.generateName,
    age: 19 * MINUTE,
    node: 'worker-2',
    owner: recommendations.replicaSet,
    labels: recommendations.podLabels,
    containers: withState(recommendationsTemplate.containers, {
      app: {
        state: {
          waiting: {
            reason: 'ImagePullBackOff',
            message:
              'Back-off pulling image "ghcr.io/acme/recommendations:v2.0.0-typo": ErrImagePull: failed to pull and unpack image "ghcr.io/acme/recommendations:v2.0.0-typo": not found',
          },
        },
        ready: false,
      },
    }),
  })

  const storefrontSvc = b.service({
    namespace: 'shop',
    name: 'storefront',
    age: 88 * DAY,
    type: 'LoadBalancer',
    clusterIP: '10.96.112.14',
    selector: shopLabels('storefront', 'frontend'),
    labels: shopLabels('storefront', 'frontend'),
    loadBalancerIP: DEMO.loadBalancerIp,
    ports: [
      { name: 'http', port: 80, targetPort: 8080, nodePort: 31080 },
      { name: 'https', port: 443, targetPort: 8443, nodePort: 31443 },
    ],
  })
  b.service({
    namespace: 'shop',
    name: 'checkout',
    age: 88 * DAY,
    clusterIP: '10.96.44.201',
    selector: shopLabels('checkout'),
    ports: [{ name: 'http', port: 8080 }],
  })
  b.service({
    namespace: 'shop',
    name: 'cart',
    age: 88 * DAY,
    clusterIP: '10.96.87.3',
    selector: shopLabels('cart'),
    ports: [{ name: 'http', port: 8080 }],
  })
  const legacyGateway = b.service({
    namespace: 'shop',
    name: 'legacy-gateway',
    age: 2 * DAY,
    type: 'LoadBalancer',
    clusterIP: '10.96.201.77',
    selector: { 'app.kubernetes.io/name': 'legacy-gateway' },
    ports: [{ name: 'http', port: 80, targetPort: 8080 }],
  })
  b.simple(
    'networking.k8s.io/v1',
    'Ingress',
    'storefront',
    'shop',
    88 * DAY,
    {
      spec: {
        ingressClassName: 'nginx',
        tls: [{ hosts: ['shop.example.com'], secretName: 'storefront-tls' }],
        rules: [
          {
            host: 'shop.example.com',
            http: {
              paths: [
                {
                  path: '/',
                  pathType: 'Prefix',
                  backend: { service: { name: 'storefront', port: { number: 80 } } },
                },
              ],
            },
          },
        ],
      },
      status: { loadBalancer: { ingress: [{ ip: DEMO.loadBalancerIp }] } },
    },
    {
      labels: shopLabels('storefront', 'frontend'),
      annotations: {
        'cert-manager.io/cluster-issuer': 'letsencrypt',
        'nginx.ingress.kubernetes.io/ssl-redirect': 'true',
      },
    },
  )
  b.simple('networking.k8s.io/v1', 'NetworkPolicy', 'default-deny', 'shop', 88 * DAY, {
    spec: { podSelector: {}, policyTypes: ['Ingress'] },
  })
  b.simple('networking.k8s.io/v1', 'NetworkPolicy', 'allow-storefront', 'shop', 88 * DAY, {
    spec: {
      podSelector: { matchLabels: { 'app.kubernetes.io/name': 'storefront' } },
      policyTypes: ['Ingress'],
      ingress: [
        {
          from: [
            {
              namespaceSelector: {
                matchLabels: { 'kubernetes.io/metadata.name': 'ingress-nginx' },
              },
            },
          ],
          ports: [{ protocol: 'TCP', port: 8080 }],
        },
      ],
    },
  })
  b.simple(
    'v1',
    'ConfigMap',
    'storefront-config',
    'shop',
    12 * DAY,
    {
      data: {
        LOG_LEVEL: 'info',
        FEATURE_FLAGS: 'wishlist,one-click-checkout',
        'config.yaml':
          'server:\n  port: 8080\n  readTimeout: 5s\ncache:\n  addr: cart.shop.svc.cluster.local:6379\n  ttl: 10m\ncatalog:\n  pageSize: 24\n',
      },
    },
    { labels: shopLabels('storefront', 'frontend') },
  )
  b.simple(
    'v1',
    'Secret',
    'storefront-tls',
    'shop',
    40 * DAY,
    {
      type: 'kubernetes.io/tls',
      data: {
        'tls.crt': base64(
          '-----BEGIN CERTIFICATE-----\nMIIFakeStorefrontCertificateForKubeStacksDemo\n-----END CERTIFICATE-----\n',
        ),
        'tls.key': base64(
          '-----BEGIN PRIVATE KEY-----\nMIIFakeStorefrontKeyForKubeStacksDemo\n-----END PRIVATE KEY-----\n',
        ),
      },
    },
    {
      annotations: {
        'cert-manager.io/issuer-name': 'letsencrypt',
        'cert-manager.io/common-name': 'shop.example.com',
      },
    },
  )
  b.simple('v1', 'Secret', 'registry-pull', 'shop', 88 * DAY, {
    type: 'kubernetes.io/dockerconfigjson',
    data: {
      '.dockerconfigjson': base64(
        JSON.stringify({
          auths: {
            'ghcr.io': {
              username: 'acme-bot',
              password: 'ghp_demo',
              auth: base64('acme-bot:ghp_demo'),
            },
          },
        }),
      ),
    },
  })

  // ── data ─────────────────────────────────────────────────────────────────
  const postgresTemplate: PodTemplate = {
    labels: { 'app.kubernetes.io/name': 'postgres', 'app.kubernetes.io/component': 'database' },
    containers: [
      {
        name: 'postgres',
        image: 'postgres:17.6-alpine',
        cpu: ['500m', '2'],
        memory: ['1Gi', '2Gi'],
        ports: [{ name: 'postgres', containerPort: 5432 }],
        env: [{ name: 'PGDATA', value: '/var/lib/postgresql/data/pgdata' }],
        mounts: [{ name: 'data', mountPath: '/var/lib/postgresql/data' }],
      },
    ],
  }
  const postgres = b.statefulSet({
    namespace: 'data',
    name: 'postgres',
    age: 95 * DAY,
    replicas: 3,
    ready: 3,
    serviceName: 'postgres',
    template: postgresTemplate,
    storage: { size: '20Gi', storageClass: 'standard' },
    previousImages: { postgres: 'postgres:17.5-alpine' },
  })
  const postgresNodes = ['worker-1', 'worker-1', 'worker-2']
  postgresNodes.forEach((node, i) =>
    b.pod({
      ...postgresTemplate,
      namespace: 'data',
      name: postgres.podName(i),
      age: 29 * DAY - i * MINUTE,
      node,
      owner: postgres.statefulSet,
      labels: postgres.podLabels(i),
      volumes: [{ name: 'data', persistentVolumeClaim: { claimName: `data-postgres-${i}` } }],
      containers: withState(postgresTemplate.containers, {
        postgres: { usage: [0.31 - i * 0.08, (1.2 - i * 0.2) * Gi] },
      }),
    }),
  )
  const redisTemplate: PodTemplate = {
    labels: { 'app.kubernetes.io/name': 'redis', 'app.kubernetes.io/component': 'cache' },
    containers: [
      {
        name: 'redis',
        image: 'redis:8.2-alpine',
        cpu: ['100m', '500m'],
        memory: ['6Gi', '8Gi'],
        ports: [{ name: 'redis', containerPort: 6379 }],
        mounts: [{ name: 'data', mountPath: '/data' }],
      },
    ],
  }
  const redis = b.statefulSet({
    namespace: 'data',
    name: 'redis',
    age: 20 * DAY,
    replicas: 2,
    ready: 1,
    serviceName: 'redis',
    template: redisTemplate,
    storage: { size: '5Gi', storageClass: 'fast-ssd' },
  })
  b.pod({
    ...redisTemplate,
    namespace: 'data',
    name: 'redis-0',
    age: 20 * DAY,
    node: 'worker-2',
    owner: redis.statefulSet,
    labels: redis.podLabels(0),
    volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'data-redis-0' } }],
    containers: withState(redisTemplate.containers, { redis: { usage: [0.024, 3.1 * Gi] } }),
  })
  const redisPending = b.pod({
    ...redisTemplate,
    namespace: 'data',
    name: 'redis-1',
    age: 38 * MINUTE,
    owner: redis.statefulSet,
    labels: redis.podLabels(1),
    volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'data-redis-1' } }],
    unschedulable:
      '0/4 nodes are available: 1 Insufficient memory, 1 node(s) had untolerated taint {node-role.kubernetes.io/control-plane: }, 1 node(s) had untolerated taint {node.kubernetes.io/memory-pressure: }, 1 node(s) had untolerated taint {node.kubernetes.io/unreachable: }. preemption: 0/4 nodes are available: 1 No preemption victims found for incoming pod, 3 Preemption is not helpful for scheduling.',
  })
  b.service({
    namespace: 'data',
    name: 'postgres',
    age: 95 * DAY,
    clusterIP: 'None',
    selector: postgresTemplate.labels,
    ports: [{ name: 'postgres', port: 5432 }],
  })
  b.service({
    namespace: 'data',
    name: 'redis',
    age: 20 * DAY,
    clusterIP: 'None',
    selector: redisTemplate.labels,
    ports: [{ name: 'redis', port: 6379 }],
  })
  b.simple(
    'v1',
    'Secret',
    'postgres-credentials',
    'data',
    95 * DAY,
    {
      type: 'Opaque',
      data: {
        username: base64('app'),
        password: base64(DEMO.postgresPassword),
        database: base64('storefront'),
      },
    },
    {
      labels: postgresTemplate.labels,
      // Created with `kubectl apply`, which keeps the values it applied in plain text.
      annotations: {
        'kubectl.kubernetes.io/last-applied-configuration': JSON.stringify({
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: { name: 'postgres-credentials', namespace: 'data' },
          stringData: { username: 'app', password: DEMO.postgresPassword, database: 'storefront' },
          type: 'Opaque',
        }),
      },
    },
  )

  // ── monitoring ───────────────────────────────────────────────────────────
  const exporterTemplate: PodTemplate = {
    labels: {
      'app.kubernetes.io/name': 'node-exporter',
      'app.kubernetes.io/part-of': 'monitoring',
    },
    hostNetwork: true,
    tolerations: [{ operator: 'Exists' }],
    containers: [
      {
        name: 'node-exporter',
        image: 'quay.io/prometheus/node-exporter:v1.9.1',
        args: ['--path.rootfs=/host'],
        cpu: ['50m', '250m'],
        memory: ['32Mi', '64Mi'],
        ports: [{ name: 'metrics', containerPort: 9100 }],
        probe: { path: '/', port: 9100 },
      },
    ],
  }
  const exporter = b.daemonSet({
    namespace: 'monitoring',
    name: 'node-exporter',
    age: 110 * DAY,
    desired: 4,
    ready: 3,
    template: exporterTemplate,
    previousImages: { 'node-exporter': 'quay.io/prometheus/node-exporter:v1.8.2' },
  })
  const exporterPods = NODE_NAMES.map((node, i) =>
    b.pod({
      ...exporterTemplate,
      namespace: 'monitoring',
      name: exporter.podName(i),
      generateName: exporter.generateName,
      age: i === 3 ? 45 * DAY : 34 * DAY,
      node,
      owner: exporter.daemonSet,
      labels: exporter.podLabels,
      containers: withState(exporterTemplate.containers, {
        'node-exporter': i === 3 ? { ready: false } : { usage: [0.008 + i * 0.002, (22 + i) * Mi] },
      }),
    }),
  )
  // The Prometheus operator's labels: its Prometheus "k8s" relates the pods to itself by them.
  const prometheusTemplate: PodTemplate = {
    labels: {
      'app.kubernetes.io/name': 'prometheus',
      'app.kubernetes.io/part-of': 'monitoring',
      'app.kubernetes.io/instance': 'k8s',
      'app.kubernetes.io/managed-by': 'prometheus-operator',
    },
    serviceAccount: 'prometheus',
    containers: [
      {
        name: 'prometheus',
        image: 'quay.io/prometheus/prometheus:v3.6.0',
        args: ['--config.file=/etc/prometheus/prometheus.yml', '--storage.tsdb.retention.time=15d'],
        cpu: ['500m', '2'],
        memory: ['2Gi', '4Gi'],
        ports: [{ name: 'web', containerPort: 9090 }],
        probe: { path: '/-/ready', port: 9090 },
      },
    ],
  }
  const prometheus = b.deployment({
    namespace: 'monitoring',
    name: 'prometheus',
    age: 110 * DAY,
    replicas: 1,
    ready: 1,
    template: prometheusTemplate,
  })
  b.pod({
    ...prometheusTemplate,
    namespace: 'monitoring',
    name: prometheus.podName(0),
    generateName: prometheus.generateName,
    age: 16 * DAY,
    node: 'worker-1',
    owner: prometheus.replicaSet,
    labels: prometheus.podLabels,
    containers: withState(prometheusTemplate.containers, {
      // Its memory limit killed it two days ago (right-sizing raises it).
      prometheus: {
        usage: [0.42, 2.6 * Gi],
        restarts: 1,
        state: { running: { sinceAgo: 2 * DAY } },
        lastTerminated: {
          exitCode: 137,
          reason: 'OOMKilled',
          startedAgo: 16 * DAY,
          finishedAgo: 2 * DAY,
        },
      },
    }),
  })
  const grafanaTemplate: PodTemplate = {
    labels: { 'app.kubernetes.io/name': 'grafana', 'app.kubernetes.io/part-of': 'monitoring' },
    containers: [
      {
        name: 'grafana',
        image: 'grafana/grafana:12.2.0',
        // Its limit throttles it in bursts (right-sizing raises it).
        cpu: ['100m', '100m'],
        memory: ['256Mi', '512Mi'],
        ports: [{ name: 'http', containerPort: 3000 }],
        probe: { path: '/api/health', port: 3000 },
        mounts: [{ name: 'storage', mountPath: '/var/lib/grafana' }],
      },
    ],
    volumes: [{ name: 'storage', persistentVolumeClaim: { claimName: 'grafana-storage' } }],
  }
  const grafana = b.deployment({
    namespace: 'monitoring',
    name: 'grafana',
    age: 110 * DAY,
    replicas: 1,
    ready: 1,
    template: grafanaTemplate,
    revision: REVISION.grafana,
    previousRevisionAge: 41 * DAY,
  })
  b.pod({
    ...grafanaTemplate,
    namespace: 'monitoring',
    name: grafana.podName(0),
    generateName: grafana.generateName,
    age: 9 * DAY,
    node: 'worker-2',
    owner: grafana.replicaSet,
    labels: grafana.podLabels,
    containers: withState(grafanaTemplate.containers, { grafana: { usage: [0.05, 180 * Mi] } }),
  })
  b.service({
    namespace: 'monitoring',
    name: 'prometheus',
    age: 110 * DAY,
    clusterIP: '10.96.9.90',
    selector: prometheusTemplate.labels,
    ports: [{ name: 'web', port: 9090 }],
  })
  b.service({
    namespace: 'monitoring',
    name: 'grafana',
    age: 110 * DAY,
    type: 'NodePort',
    clusterIP: '10.96.30.0',
    selector: grafanaTemplate.labels,
    ports: [{ name: 'http', port: 3000, nodePort: 30300 }],
  })
  b.simple('networking.k8s.io/v1', 'Ingress', 'grafana', 'monitoring', 110 * DAY, {
    spec: {
      ingressClassName: 'nginx',
      rules: [
        {
          host: 'grafana.example.com',
          http: {
            paths: [
              {
                path: '/',
                pathType: 'Prefix',
                backend: { service: { name: 'grafana', port: { number: 3000 } } },
              },
            ],
          },
        },
      ],
    },
    status: { loadBalancer: { ingress: [{ ip: DEMO.loadBalancerIp }] } },
  })
  b.simple('v1', 'ConfigMap', 'grafana-dashboards', 'monitoring', 41 * DAY, {
    data: {
      'cluster-overview.json': JSON.stringify(
        {
          title: 'Cluster overview',
          panels: [
            { type: 'timeseries', title: 'CPU' },
            { type: 'timeseries', title: 'Memory' },
          ],
        },
        null,
        2,
      ),
    },
  })

  // ── batch ────────────────────────────────────────────────────────────────
  const reportTemplate: PodTemplate = {
    labels: { 'app.kubernetes.io/name': 'nightly-report' },
    restartPolicy: 'OnFailure',
    containers: [
      {
        name: 'reporter',
        image: 'ghcr.io/acme/reporter:v0.9.4',
        cpu: ['250m', '1'],
        memory: ['512Mi', '1Gi'],
      },
    ],
  }
  const nightly = b.cronJob({
    namespace: 'batch',
    name: 'nightly-report',
    age: 60 * DAY,
    schedule: '0 2 * * *',
    template: reportTemplate,
    lastScheduleAgo: 20 * HOUR,
    lastSuccessAgo: 20 * HOUR - 42 * SECOND,
  })
  const cleanup = b.cronJob({
    namespace: 'batch',
    name: 'cleanup',
    age: 60 * DAY,
    schedule: '*/30 * * * *',
    suspend: true,
    lastScheduleAgo: 9 * DAY,
    template: {
      labels: { 'app.kubernetes.io/name': 'cleanup' },
      restartPolicy: 'Never',
      containers: [
        {
          name: 'kubectl',
          image: 'bitnami/kubectl:1.34',
          command: ['kubectl', 'delete', 'pods', '--field-selector=status.phase==Succeeded'],
        },
      ],
    },
  })
  const nightlyJob = b.job({
    namespace: 'batch',
    name: 'nightly-report-29310',
    age: 20 * HOUR,
    template: reportTemplate,
    owner: nightly,
    outcome: 'complete',
    durationMs: 41 * SECOND,
  })
  b.pod({
    ...reportTemplate,
    namespace: 'batch',
    name: nightlyJob.podName(0),
    generateName: nightlyJob.generateName,
    age: 20 * HOUR,
    node: 'worker-2',
    owner: nightlyJob.job,
    labels: nightlyJob.podLabels,
    phase: 'Succeeded',
    containers: withState(reportTemplate.containers, {
      reporter: {
        state: {
          terminated: {
            exitCode: 0,
            reason: 'Completed',
            startedAgo: 20 * HOUR - 3 * SECOND,
            finishedAgo: 20 * HOUR - 44 * SECOND,
          },
        },
      },
    }),
  })
  const migrateTemplate: PodTemplate = {
    labels: { 'app.kubernetes.io/name': 'db-migrate' },
    restartPolicy: 'Never',
    containers: [
      { name: 'migrator', image: 'ghcr.io/acme/migrator:v1.2.0', cpu: ['100m'], memory: ['128Mi'] },
    ],
  }
  const dbMigrate = b.job({
    namespace: 'batch',
    name: 'db-migrate',
    age: 31 * MINUTE,
    template: migrateTemplate,
    outcome: 'failed',
    failed: 4,
    backoffLimit: 3,
    durationMs: 6 * MINUTE,
  })
  const dbMigratePods = [0, 1].map((i) =>
    b.pod({
      ...migrateTemplate,
      namespace: 'batch',
      name: dbMigrate.podName(i),
      generateName: dbMigrate.generateName,
      age: 31 * MINUTE - i * 2 * MINUTE,
      node: 'worker-1',
      owner: dbMigrate.job,
      labels: dbMigrate.podLabels,
      phase: 'Failed',
      containers: withState(migrateTemplate.containers, {
        migrator: {
          state: {
            terminated: {
              exitCode: 2,
              reason: 'Error',
              startedAgo: 31 * MINUTE - i * 2 * MINUTE - 4 * SECOND,
              finishedAgo: 31 * MINUTE - i * 2 * MINUTE - 9 * SECOND,
            },
          },
        },
      }),
    }),
  )
  const reindexTemplate: PodTemplate = {
    labels: { 'app.kubernetes.io/name': 'search-indexer' },
    restartPolicy: 'Never',
    containers: [
      {
        name: 'indexer',
        image: 'ghcr.io/acme/search-indexer:v4.1.0',
        cpu: ['1', '2'],
        memory: ['2Gi', '2Gi'],
      },
    ],
  }
  const reindex = b.job({
    namespace: 'batch',
    name: 'reindex',
    age: 14 * MINUTE,
    template: reindexTemplate,
    outcome: 'running',
  })
  const reindexPod = b.pod({
    ...reindexTemplate,
    namespace: 'batch',
    name: reindex.podName(0),
    generateName: reindex.generateName,
    age: 14 * MINUTE,
    node: 'worker-1',
    owner: reindex.job,
    labels: reindex.podLabels,
    containers: withState(reindexTemplate.containers, { indexer: { usage: [0.96, 1.7 * Gi] } }),
  })

  // ── default ──────────────────────────────────────────────────────────────
  b.service({
    namespace: 'default',
    name: 'kubernetes',
    age: clusterAge,
    clusterIP: '10.96.0.1',
    labels: { component: 'apiserver', provider: 'kubernetes' },
    ports: [{ name: 'https', port: 443, targetPort: 6443 }],
  })
  b.pod({
    namespace: 'default',
    name: 'debug-shell',
    age: 5 * HOUR,
    node: 'worker-1',
    labels: { run: 'debug-shell', 'app.kubernetes.io/name': 'debug-shell' },
    containers: [
      {
        name: 'shell',
        image: 'nicolaka/netshoot:v0.14',
        command: ['sleep', 'infinity'],
        usage: [0.001, 5 * Mi],
      },
    ],
  })
  b.pod({
    namespace: 'default',
    name: 'old-task',
    age: 9 * DAY,
    node: 'worker-1',
    phase: 'Succeeded',
    restartPolicy: 'Never',
    labels: { run: 'old-task', 'app.kubernetes.io/name': 'old-task' },
    containers: [
      {
        name: 'task',
        image: 'busybox:1.37',
        command: ['sh', '-c', 'echo done'],
        state: {
          terminated: {
            exitCode: 0,
            reason: 'Completed',
            startedAgo: 9 * DAY - 5 * SECOND,
            finishedAgo: 9 * DAY - 7 * SECOND,
          },
        },
      },
    ],
  })
  const stuck = b.pod({
    namespace: 'default',
    name: 'stuck-terminating',
    age: 4 * DAY,
    node: 'worker-2',
    deletingAgo: 6 * MINUTE,
    labels: { run: 'stuck-terminating', 'app.kubernetes.io/name': 'stuck-terminating' },
    containers: [
      {
        name: 'nginx',
        image: 'nginx:1.29-alpine',
        cpu: ['50m'],
        memory: ['64Mi'],
        usage: [0.0004, 3 * Mi],
      },
    ],
  })

  // ── Storage ──────────────────────────────────────────────────────────────
  b.simple(
    'storage.k8s.io/v1',
    'StorageClass',
    'standard',
    undefined,
    clusterAge,
    {
      provisioner: 'rancher.io/local-path',
      reclaimPolicy: 'Delete',
      volumeBindingMode: 'WaitForFirstConsumer',
      allowVolumeExpansion: false,
    },
    { annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' } },
  )
  b.simple('storage.k8s.io/v1', 'StorageClass', 'fast-ssd', undefined, 80 * DAY, {
    provisioner: 'ebs.csi.aws.com',
    reclaimPolicy: 'Retain',
    volumeBindingMode: 'WaitForFirstConsumer',
    allowVolumeExpansion: true,
    parameters: { type: 'gp3', iops: '6000', throughput: '250', encrypted: 'true' },
  })
  const claim = (
    namespace: string,
    name: string,
    age: number,
    size: string,
    storageClass: string,
    bound: boolean,
    labels?: Record<string, string>,
  ) => {
    const pvName = `pvc-${uidFor(`PersistentVolumeClaim/${namespace}/${name}`)}`
    const pvc = b.simple(
      'v1',
      'PersistentVolumeClaim',
      name,
      namespace,
      age,
      {
        spec: {
          accessModes: ['ReadWriteOnce'],
          resources: { requests: { storage: size } },
          storageClassName: storageClass,
          volumeMode: 'Filesystem',
          ...(bound ? { volumeName: pvName } : {}),
        },
        status: bound
          ? { phase: 'Bound', accessModes: ['ReadWriteOnce'], capacity: { storage: size } }
          : { phase: 'Pending' },
      },
      {
        ...(labels ? { labels } : {}),
        annotations: bound
          ? {
              'pv.kubernetes.io/bind-completed': 'yes',
              'pv.kubernetes.io/bound-by-controller': 'yes',
              'volume.kubernetes.io/storage-provisioner':
                storageClass === 'standard' ? 'rancher.io/local-path' : 'ebs.csi.aws.com',
            }
          : { 'volume.kubernetes.io/selected-node': 'worker-2' },
        finalizers: ['kubernetes.io/pvc-protection'],
      },
    )
    if (bound) {
      b.simple(
        'v1',
        'PersistentVolume',
        pvName,
        undefined,
        age - 5 * SECOND,
        {
          spec: {
            capacity: { storage: size },
            accessModes: ['ReadWriteOnce'],
            persistentVolumeReclaimPolicy: storageClass === 'standard' ? 'Delete' : 'Retain',
            storageClassName: storageClass,
            volumeMode: 'Filesystem',
            claimRef: {
              kind: 'PersistentVolumeClaim',
              namespace,
              name,
              uid: pvc.metadata.uid,
              apiVersion: 'v1',
              resourceVersion: pvc.metadata.resourceVersion,
            },
            ...(storageClass === 'standard'
              ? {
                  hostPath: {
                    path: `/var/local-path-provisioner/${pvName}_${namespace}_${name}`,
                    type: 'DirectoryOrCreate',
                  },
                }
              : {
                  csi: {
                    driver: 'ebs.csi.aws.com',
                    volumeHandle: `vol-0${pvName.slice(4, 20)}`,
                    fsType: 'ext4',
                  },
                }),
          },
          status: { phase: 'Bound', lastPhaseTransitionTime: b.time(age - 5 * SECOND) },
        },
        {
          finalizers: ['kubernetes.io/pv-protection'],
          annotations: {
            'pv.kubernetes.io/provisioned-by':
              storageClass === 'standard' ? 'rancher.io/local-path' : 'ebs.csi.aws.com',
          },
        },
      )
    }
    return pvc
  }
  for (let i = 0; i < 3; i++)
    claim(
      'data',
      `data-postgres-${i}`,
      95 * DAY - i * MINUTE,
      '20Gi',
      'standard',
      true,
      postgresTemplate.labels,
    )
  claim('data', 'data-redis-0', 20 * DAY, '5Gi', 'fast-ssd', true, redisTemplate.labels)
  const pendingClaim = claim(
    'data',
    'data-redis-1',
    38 * MINUTE,
    '5Gi',
    'fast-ssd',
    false,
    redisTemplate.labels,
  )
  claim('monitoring', 'grafana-storage', 110 * DAY, '10Gi', 'standard', true)
  b.simple('v1', 'PersistentVolume', 'pv-legacy-archive', undefined, 118 * DAY, {
    spec: {
      capacity: { storage: '50Gi' },
      accessModes: ['ReadWriteOnce'],
      persistentVolumeReclaimPolicy: 'Retain',
      storageClassName: 'fast-ssd',
      volumeMode: 'Filesystem',
      claimRef: {
        kind: 'PersistentVolumeClaim',
        namespace: 'legacy',
        name: 'archive',
        uid: '6c1d2e3f-0000-4000-a000-legacyarchive',
        apiVersion: 'v1',
      },
      csi: { driver: 'ebs.csi.aws.com', volumeHandle: 'vol-0legacyarchive01', fsType: 'ext4' },
    },
    status: { phase: 'Released', lastPhaseTransitionTime: b.time(3 * HOUR) },
  })

  // ── Events ───────────────────────────────────────────────────────────────
  checkoutPods.slice(0, 2).forEach((pod, i) => {
    b.event(pod, {
      type: 'Warning',
      reason: 'BackOff',
      component: 'kubelet',
      host: 'worker-2',
      fieldPath: 'spec.containers{app}',
      message: `Back-off restarting failed container app in pod ${pod.metadata.name}_shop(${pod.metadata.uid})`,
      count: 58 - i * 3,
      firstAgo: 44 * MINUTE,
      lastAgo: 40 * SECOND + i * 15 * SECOND,
    })
    b.event(pod, {
      type: 'Normal',
      reason: 'Pulled',
      component: 'kubelet',
      host: 'worker-2',
      fieldPath: 'spec.containers{app}',
      message: 'Container image "ghcr.io/acme/checkout:v1.14.0" already present on machine',
      count: 14 - i,
      firstAgo: 46 * MINUTE,
      lastAgo: 3 * MINUTE,
    })
    b.event(pod, {
      type: 'Normal',
      reason: 'Scheduled',
      component: 'default-scheduler',
      message: `Successfully assigned shop/${pod.metadata.name} to worker-2`,
      firstAgo: 47 * MINUTE,
    })
  })
  b.event(checkout.replicaSet, {
    type: 'Normal',
    reason: 'SuccessfulCreate',
    component: 'replicaset-controller',
    message: `Created pod: ${checkoutPods[0]!.metadata.name}`,
    firstAgo: 47 * MINUTE,
  })
  b.event(checkout.deployment, {
    type: 'Normal',
    reason: 'ScalingReplicaSet',
    component: 'deployment-controller',
    message: `Scaled up replica set ${checkout.replicaSet.metadata.name} from 1 to 3`,
    firstAgo: 47 * MINUTE,
  })
  b.event(recommendationsPod, {
    type: 'Warning',
    reason: 'Failed',
    component: 'kubelet',
    host: 'worker-2',
    fieldPath: 'spec.containers{app}',
    message:
      'Failed to pull image "ghcr.io/acme/recommendations:v2.0.0-typo": rpc error: code = NotFound desc = failed to pull and unpack image "ghcr.io/acme/recommendations:v2.0.0-typo": failed to resolve reference "ghcr.io/acme/recommendations:v2.0.0-typo": ghcr.io/acme/recommendations:v2.0.0-typo: not found',
    count: 9,
    firstAgo: 19 * MINUTE,
    lastAgo: 2 * MINUTE,
  })
  b.event(recommendationsPod, {
    type: 'Warning',
    reason: 'Failed',
    component: 'kubelet',
    host: 'worker-2',
    fieldPath: 'spec.containers{app}',
    message: 'Error: ErrImagePull',
    count: 9,
    firstAgo: 19 * MINUTE,
    lastAgo: 2 * MINUTE,
  })
  b.event(recommendationsPod, {
    type: 'Normal',
    reason: 'BackOff',
    component: 'kubelet',
    host: 'worker-2',
    fieldPath: 'spec.containers{app}',
    message: 'Back-off pulling image "ghcr.io/acme/recommendations:v2.0.0-typo"',
    count: 71,
    firstAgo: 18 * MINUTE,
    lastAgo: 25 * SECOND,
  })
  b.event(recommendationsPod, {
    type: 'Warning',
    reason: 'Failed',
    component: 'kubelet',
    host: 'worker-2',
    fieldPath: 'spec.containers{app}',
    message: 'Error: ImagePullBackOff',
    count: 71,
    firstAgo: 18 * MINUTE,
    lastAgo: 25 * SECOND,
  })
  b.event(recommendations.deployment, {
    type: 'Normal',
    reason: 'ScalingReplicaSet',
    component: 'deployment-controller',
    message: `Scaled up replica set ${recommendations.replicaSet.metadata.name} from 0 to 1`,
    firstAgo: 19 * MINUTE,
  })
  b.event(redisPending, {
    type: 'Warning',
    reason: 'FailedScheduling',
    component: 'default-scheduler',
    message: redisPending.status.conditions[0].message,
    count: 12,
    firstAgo: 38 * MINUTE,
    lastAgo: 3 * MINUTE,
  })
  b.event(pendingClaim, {
    type: 'Normal',
    reason: 'WaitForFirstConsumer',
    component: 'persistentvolume-controller',
    message: 'waiting for first consumer to be created before binding',
    count: 153,
    firstAgo: 38 * MINUTE,
    lastAgo: 20 * SECOND,
  })
  b.event(nodes.worker3, {
    type: 'Warning',
    reason: 'NodeNotReady',
    component: 'node-controller',
    message: 'Node worker-3 status is now: NodeNotReady',
    firstAgo: 52 * MINUTE,
  })
  b.event(nodes.worker2, {
    type: 'Warning',
    reason: 'EvictionThresholdMet',
    component: 'kubelet',
    host: 'worker-2',
    message: 'Attempting to reclaim memory',
    count: 4,
    firstAgo: 23 * MINUTE,
    lastAgo: 4 * MINUTE,
  })
  b.event(nodes.worker2, {
    type: 'Normal',
    reason: 'NodeHasInsufficientMemory',
    component: 'kubelet',
    host: 'worker-2',
    message: 'Node worker-2 status is now: NodeHasInsufficientMemory',
    firstAgo: 23 * MINUTE,
  })
  b.event(exporterPods[3]!, {
    type: 'Warning',
    reason: 'Unhealthy',
    component: 'kubelet',
    host: 'worker-3',
    fieldPath: 'spec.containers{node-exporter}',
    message:
      'Readiness probe failed: Get "http://10.0.1.13:9100/": dial tcp 10.0.1.13:9100: connect: connection refused',
    count: 31,
    firstAgo: 55 * MINUTE,
    lastAgo: 53 * MINUTE,
  })
  b.event(exporterPods[3]!, {
    type: 'Warning',
    reason: 'NodeNotReady',
    component: 'node-controller',
    message: 'Node is not ready',
    firstAgo: 52 * MINUTE,
  })
  b.event(dbMigrate.job, {
    type: 'Warning',
    reason: 'BackoffLimitExceeded',
    component: 'job-controller',
    message: 'Job has reached the specified backoff limit',
    firstAgo: 25 * MINUTE,
  })
  b.event(dbMigrate.job, {
    type: 'Normal',
    reason: 'SuccessfulCreate',
    component: 'job-controller',
    message: `Created pod: ${dbMigratePods[0]!.metadata.name}`,
    firstAgo: 31 * MINUTE,
  })
  b.event(legacyGateway, {
    type: 'Warning',
    reason: 'SyncLoadBalancerFailed',
    component: 'service-controller',
    message:
      'Error syncing load balancer: failed to ensure load balancer: no available IPs in pool "public"',
    count: 14,
    firstAgo: 50 * MINUTE,
    lastAgo: 5 * MINUTE,
  })
  b.event(storefront.deployment, {
    type: 'Normal',
    reason: 'ScalingReplicaSet',
    component: 'deployment-controller',
    message: `Scaled up replica set ${storefront.replicaSet.metadata.name} from 0 to 3`,
    firstAgo: 3 * DAY,
  })
  b.event(storefront.deployment, {
    type: 'Normal',
    reason: 'ScalingReplicaSet',
    component: 'deployment-controller',
    message: `Scaled down replica set ${DEMO.replicaSets.storefrontPrevious} from 3 to 0`,
    firstAgo: 3 * DAY - 2 * MINUTE,
  })
  storefrontPods.forEach((pod) => {
    const node = pod.spec.nodeName as string
    b.event(pod, {
      type: 'Normal',
      reason: 'Scheduled',
      component: 'default-scheduler',
      message: `Successfully assigned shop/${pod.metadata.name} to ${node}`,
      firstAgo: 3 * DAY,
    })
    b.event(pod, {
      type: 'Normal',
      reason: 'Pulled',
      component: 'kubelet',
      host: node,
      fieldPath: 'spec.containers{app}',
      message:
        'Successfully pulled image "ghcr.io/acme/storefront:v3.8.2" in 2.143s (2.143s including waiting). Image size: 48213771 bytes.',
      firstAgo: 3 * DAY - 3 * SECOND,
    })
    b.event(pod, {
      type: 'Normal',
      reason: 'Created',
      component: 'kubelet',
      host: node,
      fieldPath: 'spec.containers{app}',
      message: 'Created container: app',
      firstAgo: 3 * DAY - 4 * SECOND,
    })
    b.event(pod, {
      type: 'Normal',
      reason: 'Started',
      component: 'kubelet',
      host: node,
      fieldPath: 'spec.containers{app}',
      message: 'Started container app',
      firstAgo: 3 * DAY - 5 * SECOND,
    })
  })
  b.event(storefrontSvc, {
    type: 'Normal',
    reason: 'EnsuredLoadBalancer',
    component: 'service-controller',
    message: 'Ensured load balancer',
    firstAgo: 88 * DAY,
  })
  b.event(nightly, {
    type: 'Normal',
    reason: 'SuccessfulCreate',
    component: 'cronjob-controller',
    message: 'Created job nightly-report-29310',
    firstAgo: 20 * HOUR,
  })
  b.event(nightly, {
    type: 'Normal',
    reason: 'SawCompletedJob',
    component: 'cronjob-controller',
    message: 'Saw completed job: nightly-report-29310, condition: Complete',
    firstAgo: 20 * HOUR - 45 * SECOND,
  })
  b.event(nightlyJob.job, {
    type: 'Normal',
    reason: 'Completed',
    component: 'job-controller',
    message: 'Job completed',
    firstAgo: 20 * HOUR - 44 * SECOND,
  })
  b.event(reindex.job, {
    type: 'Normal',
    reason: 'SuccessfulCreate',
    component: 'job-controller',
    message: `Created pod: ${reindexPod.metadata.name}`,
    firstAgo: 14 * MINUTE,
  })
  b.event(reindexPod, {
    type: 'Normal',
    reason: 'Scheduled',
    component: 'default-scheduler',
    message: `Successfully assigned batch/${reindexPod.metadata.name} to worker-1`,
    firstAgo: 14 * MINUTE,
  })
  b.event(reindexPod, {
    type: 'Normal',
    reason: 'Started',
    component: 'kubelet',
    host: 'worker-1',
    fieldPath: 'spec.containers{indexer}',
    message: 'Started container indexer',
    firstAgo: 14 * MINUTE - 6 * SECOND,
  })
  b.event(stuck, {
    type: 'Normal',
    reason: 'Killing',
    component: 'kubelet',
    host: 'worker-2',
    fieldPath: 'spec.containers{nginx}',
    message: 'Stopping container nginx',
    firstAgo: 6 * MINUTE,
  })
  b.event(cleanup, {
    type: 'Normal',
    reason: 'SuccessfulDelete',
    component: 'cronjob-controller',
    message: 'Deleted job cleanup-29302740',
    firstAgo: 9 * DAY,
  })
  b.event(
    b.objects.find((o) => o.kind === 'HorizontalPodAutoscaler')!,
    {
      type: 'Normal',
      reason: 'SuccessfulRescale',
      component: 'horizontal-pod-autoscaler',
      message: 'New size: 3; reason: cpu resource utilization (percentage of request) above target',
      firstAgo: 2 * HOUR,
    },
  )

  // Rollout history: why the current storefront rollout happened, and a revision
  // left behind by a StatefulSet that no longer exists.
  const storefrontRs = b.objects.find(
    (o) => o.kind === 'ReplicaSet' && o.metadata.name === DEMO.replicaSets.storefront,
  )!
  storefrontRs.metadata.annotations!['kubernetes.io/change-cause'] =
    'Release v3.8.2: faster product search'
  b.objects.find(
    (o) => o.kind === 'ReplicaSet' && o.metadata.name === DEMO.replicaSets.storefrontPrevious,
  )!.metadata.annotations!['kubernetes.io/change-cause'] = 'Release v3.7.4'
  b.simple(
    'apps/v1',
    'ControllerRevision',
    'old-cache-7d9f8c6b5c',
    'data',
    300 * DAY,
    {
      data: { spec: { template: { $patch: 'replace', spec: { containers: [] } } } },
      revision: 3,
    },
    { labels: { app: 'old-cache' } },
  )

  // Binary data (a PKCS #12 keystore) next to text: the YAML editor keeps it encoded.
  b.simple('v1', 'Secret', 'java-keystore', 'shop', 30 * DAY, {
    type: 'Opaque',
    data: {
      'keystore.p12': Buffer.from([
        0x30, 0x82, 0x0a, 0x4b, 0x02, 0x01, 0x03, 0xff, 0xfe, 0x80,
      ]).toString('base64'),
      password: Buffer.from('changeit').toString('base64'),
    },
  })

  // Created suspended: it waits to be resumed and has never started.
  b.simple('batch/v1', 'Job', 'backfill', 'batch', 2 * HOUR, {
    spec: {
      suspend: true,
      completions: 1,
      parallelism: 1,
      backoffLimit: 6,
      selector: { matchLabels: { 'batch.kubernetes.io/job-name': 'backfill' } },
      template: {
        metadata: { labels: { 'batch.kubernetes.io/job-name': 'backfill' } },
        spec: {
          restartPolicy: 'Never',
          containers: [
            {
              name: 'backfill',
              image: 'ghcr.io/acme/tools:2.4.0',
              args: ['backfill', '--since=2026-01-01'],
            },
          ],
        },
      },
    },
    status: {
      conditions: [
        {
          type: 'Suspended',
          status: 'True',
          reason: 'JobSuspended',
          message: 'Job suspended',
          lastTransitionTime: b.time(2 * HOUR),
        },
      ],
    },
  })

  // ── Less common shapes, so every view has something realistic to show ───
  // Dedicated nodes carry taints with values.
  nodes.worker1.spec.taints = [{ key: 'dedicated', value: 'shop', effect: 'PreferNoSchedule' }]
  // An alias for an external API: no cluster IP, no ports, no selector.
  b.simple('v1', 'Service', 'payments-gateway', 'shop', 30 * DAY, {
    spec: {
      type: 'ExternalName',
      externalName: 'api.payments.example.com',
      sessionAffinity: 'None',
    },
    status: { loadBalancer: {} },
  })
  // Cloud load balancers often hand out hostnames rather than IPs.
  b.simple('v1', 'Service', 'edge', 'shop', 20 * DAY, {
    spec: {
      type: 'LoadBalancer',
      clusterIP: '10.96.88.20',
      clusterIPs: ['10.96.88.20'],
      ports: [{ port: 443, targetPort: 8443, protocol: 'TCP', nodePort: 31443 }],
      selector: { 'app.kubernetes.io/name': 'storefront' },
      sessionAffinity: 'None',
    },
    status: {
      loadBalancer: { ingress: [{ hostname: 'k8s-shop-edge-4f1c2a.elb.eu-west-1.amazonaws.com' }] },
    },
  })
  // A default backend: no host, no path, a port by name, and no address yet.
  b.simple('networking.k8s.io/v1', 'Ingress', 'status-page', 'monitoring', 12 * MINUTE, {
    spec: {
      ingressClassName: 'nginx',
      rules: [
        {
          http: {
            paths: [
              {
                pathType: 'ImplementationSpecific',
                backend: { service: { name: 'grafana', port: { name: 'http' } } },
              },
            ],
          },
        },
      ],
    },
    status: { loadBalancer: {} },
  })
  b.cronJob({
    namespace: 'batch',
    name: 'quarterly-audit',
    age: 5 * DAY,
    schedule: '0 3 1 */3 *',
    template: reportTemplate,
  })
  b.simple('v1', 'PersistentVolume', 'pv-spare', undefined, 20 * DAY, {
    spec: {
      capacity: { storage: '100Gi' },
      accessModes: ['ReadWriteOnce'],
      persistentVolumeReclaimPolicy: 'Delete',
      storageClassName: 'fast-ssd',
      volumeMode: 'Filesystem',
      csi: { driver: 'ebs.csi.aws.com', volumeHandle: 'vol-0spare0000000001', fsType: 'ext4' },
    },
    status: { phase: 'Available' },
  })
  // Created by a controller before it had anything to store.
  b.simple('v1', 'Secret', 'feature-flags', 'shop', 3 * DAY, { type: 'Opaque' })
  // Just created: no metrics have been collected for it yet.
  b.simple('autoscaling/v2', 'HorizontalPodAutoscaler', 'checkout', 'shop', 2 * HOUR, {
    spec: {
      scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'checkout' },
      minReplicas: 3,
      maxReplicas: 6,
      metrics: [
        {
          type: 'Resource',
          resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 80 } },
        },
      ],
    },
    status: {
      currentReplicas: 3,
      desiredReplicas: 3,
      conditions: [
        {
          type: 'ScalingActive',
          status: 'False',
          lastTransitionTime: b.time(2 * HOUR),
          reason: 'FailedGetResourceMetric',
          message:
            'the HPA was unable to compute the replica count: failed to get cpu utilization: did not receive metrics for targeted pods (pods might be unready)',
        },
      ],
    },
  })
  // events.k8s.io-style events set eventTime instead of lastTimestamp and count.
  b.simple('v1', 'Event', 'storefront.scaling-replicaset-v2', 'shop', 4 * MINUTE, {
    involvedObject: {
      kind: 'Deployment',
      namespace: 'shop',
      name: 'storefront',
      uid: b.objects.find((o) => o.kind === 'Deployment' && o.metadata.name === 'storefront')!
        .metadata.uid,
      apiVersion: 'apps/v1',
    },
    reason: 'ScalingReplicaSet',
    message: 'Scaled up replica set storefront-6lghmbsjgn from 2 to 3',
    type: 'Normal',
    action: 'Scale',
    eventTime: b.time(4 * MINUTE).replace('Z', '.412305Z'),
    firstTimestamp: null,
    lastTimestamp: null,
    reportingComponent: 'deployment-controller',
    reportingInstance: 'kube-controller-manager-control-plane-1',
    source: {},
  })
  // Some older controllers only leave the creation time behind.
  b.simple('v1', 'Event', 'legacy.finalizers-remaining', 'legacy', 3 * HOUR, {
    involvedObject: { kind: 'Namespace', name: 'legacy', apiVersion: 'v1' },
    reason: 'NamespaceFinalizersRemaining',
    message:
      'Some content in the namespace has finalizers remaining: kubernetes.io/pvc-protection in 1 resource instances',
    type: 'Normal',
    firstTimestamp: null,
    lastTimestamp: null,
    eventTime: null,
    source: { component: 'namespace-controller' },
  })

  // A second, older Prometheus that only answers when the first one can't.
  b.service({
    namespace: 'data',
    name: 'prometheus-archive',
    age: 400 * DAY,
    clusterIP: '10.96.9.91',
    labels: { 'app.kubernetes.io/name': 'prometheus' },
    // An unnamed port, picked by its number.
    ports: [{ port: 9090 }],
  })

  demoCustomResources(b, now)
  demoHelmReleases(b, now)

  return {
    ...b.build(demoLogs),
    prometheus: [
      { namespace: 'monitoring', service: 'prometheus', flavor: 'prometheus' },
      { namespace: 'data', service: 'prometheus-archive', flavor: 'prometheus' },
    ],
  }
}

/**
 * "long": the demo cluster, and beside it a namespace of everything as long as Kubernetes lets it
 * be: names of 63 characters (and more, where a name may be a DNS subdomain), labels and
 * annotations at their limits, long images, commands, messages and values. For the UI's check
 * that nothing long spills out of its place (tests/e2e/long-text.spec.ts).
 */
import { base64, clusterBuilder, DAY, HOUR, MINUTE, type ContainerInput } from '../builders.ts'
import type { ClusterFixture } from '../types.ts'
import { demoCluster } from './demo.ts'
import { release } from './helm.ts'

const FILL = 'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(8)
/** A DNS label as long as one may be (63), from a start. */
const label = (start: string) => `${start}-${FILL}`.slice(0, 63).replace(/-+$/, '')
/** A DNS subdomain of `length` (at most 253): labels joined by dots. */
const subdomain = (start: string, length: number) =>
  Array.from({ length: 5 }, (_, i) => label(`${start}-${i}`))
    .join('.')
    .slice(0, length)
    .replace(/[.-]+$/, '')
/** Words, as a message has them, to `length` characters. */
const words = (start: string, length: number) =>
  `${start} ${'and then it went on to say a great deal more about what happened and why it matters '.repeat(20)}`
    .slice(0, length)
    .trim()

export const LONG = {
  namespace: label('a-namespace-as-long-as-kubernetes-allows'),
  node: subdomain('a-node-whose-name-is-a-long-dns-subdomain', 120),
  deployment: label('a-deployment-whose-name-goes-on-and-on'),
  statefulSet: label('a-stateful-set-whose-name-goes-on'),
  daemonSet: label('a-daemon-set-whose-name-goes-on'),
  job: label('a-job-whose-name-goes-on-and-on'),
  // CronJobs' names are at most 52 characters.
  cronJob: label('a-cron-job-whose-name-goes-on').slice(0, 52).replace(/-+$/, ''),
  service: label('a-service-whose-name-goes-on-and-on'),
  configMap: subdomain('a-config-map-whose-name-is-a-dns-subdomain', 200),
  secret: subdomain('a-secret-whose-name-is-a-dns-subdomain', 200),
  ingress: label('an-ingress-whose-name-goes-on'),
  claim: label('a-volume-claim-whose-name-goes-on'),
  certificate: label('a-certificate-whose-name-goes-on'),
  // Helm's release names are at most 53 characters.
  release: label('a-helm-release-whose-name-goes-on').slice(0, 53).replace(/-+$/, ''),
  container: label('a-container-whose-name-goes-on-and-on'),
  image: `registry.a-very-long-registry-host-name.example.com:5000/an-organization-with-a-long-name/a-team/an-image-with-a-long-name:v1.23.456-build.20261007.123456-abcdef0123456789`,
  message: words('Back-off pulling image: the registry answered that', 600),
} as const

/** Labels and annotations at their limits: a long prefix and name, a long value. */
const LABELS = {
  [`${subdomain('labels.example', 200)}/${label('a-label-key')}`]: label('a-label-value'),
  'app.kubernetes.io/name': label('an-app-name'),
  'app.kubernetes.io/part-of': label('a-system'),
}
const ANNOTATIONS = {
  [`${subdomain('annotations.example', 120)}/${label('an-annotation-key')}`]: words(
    'An annotation that says',
    2000,
  ),
  'kubectl.kubernetes.io/last-applied-configuration': JSON.stringify({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: LONG.deployment, namespace: LONG.namespace, labels: LABELS },
    spec: { template: { spec: { containers: [{ name: LONG.container, image: LONG.image }] } } },
  }),
}

const container = (overrides: Partial<ContainerInput> = {}): ContainerInput => ({
  name: LONG.container,
  image: LONG.image,
  cpu: ['250m', '1'],
  memory: ['256Mi', '1Gi'],
  ports: [
    { name: 'a-long-port-nm', containerPort: 8080 },
    { name: 'metrics-port-nm', containerPort: 9090 },
  ],
  command: ['/usr/local/bin/a-program-with-a-very-long-name-that-does-things'],
  args: [
    `--a-flag-with-a-very-long-name=${words('a value', 160)}`,
    '--another-flag-that-goes-on-and-on-and-on=true',
  ],
  env: [
    {
      name: 'AN_ENVIRONMENT_VARIABLE_WITH_A_VERY_LONG_NAME_THAT_GOES_ON_AND_ON_AND_ON',
      value: words('A value that', 300),
    },
  ],
  mounts: [
    { name: label('a-volume'), mountPath: `/var/lib/${label('a-folder')}/${label('another')}` },
  ],
  usage: [0.12, 180 * 1024 * 1024],
  ...overrides,
})

const template = (name: string, overrides: Partial<ContainerInput> = {}) => ({
  labels: { ...LABELS, 'app.kubernetes.io/instance': name },
  annotations: ANNOTATIONS,
  containers: [container(overrides)],
  volumes: [{ name: label('a-volume'), emptyDir: {} }],
  nodeSelector: {
    [`${subdomain('nodes.example', 100)}/${label('a-node-label')}`]: label('a-value'),
  },
})

export function longCluster(now = Date.now()): ClusterFixture {
  const demo = demoCluster(now)
  const b = clusterBuilder(now)
  const age = 40 * DAY
  b.node({
    name: LONG.node,
    age,
    ip: '10.123.234.45',
    zone: label('a-zone-with-a-long-name'),
    instanceType: label('an-instance-type-with-a-long-name'),
    cpu: 96,
    memoryGi: 384,
    usage: { cpu: 0.41, memory: 0.63 },
    labels: LABELS,
  })
  const namespace = b.namespace(LONG.namespace, age)
  namespace.metadata.labels = { ...namespace.metadata.labels, ...LABELS }
  namespace.metadata.annotations = ANNOTATIONS
  const { deployment } = b.deployment({
    namespace: LONG.namespace,
    name: LONG.deployment,
    age,
    replicas: 2,
    ready: 1,
    revision: 3,
    previousRevisionAge: 5 * DAY,
    labels: LABELS,
    template: template(LONG.deployment),
  })
  b.statefulSet({
    namespace: LONG.namespace,
    name: LONG.statefulSet,
    age,
    replicas: 1,
    ready: 1,
    serviceName: LONG.service,
    template: template(LONG.statefulSet),
    storage: { size: '10Gi', storageClass: label('a-storage-class') },
  })
  b.daemonSet({
    namespace: LONG.namespace,
    name: LONG.daemonSet,
    age,
    desired: 1,
    ready: 1,
    template: template(LONG.daemonSet),
  })
  b.job({
    namespace: LONG.namespace,
    name: LONG.job,
    age: 2 * HOUR,
    outcome: 'failed',
    failed: 3,
    template: {
      ...template(LONG.job, {
        state: {
          terminated: {
            exitCode: 137,
            reason: 'OOMKilledBecauseItWantedMoreMemoryThanItWasGiven',
            startedAgo: HOUR,
            finishedAgo: 50 * MINUTE,
            message: LONG.message,
          },
        },
      }),
      restartPolicy: 'Never',
    },
  })
  b.cronJob({
    namespace: LONG.namespace,
    name: LONG.cronJob,
    age,
    schedule: '*/15 3-5,17-19 1-7,15-21 1,4,7,10 MON-FRI',
    template: { ...template(LONG.cronJob), restartPolicy: 'OnFailure' },
    lastScheduleAgo: 15 * MINUTE,
    lastSuccessAgo: 15 * MINUTE,
  })
  // A pod that can't start: its image can't be pulled, which it says at length.
  b.pod({
    namespace: LONG.namespace,
    name: label('a-pod-that-cannot-pull-its-image'),
    age: 3 * HOUR,
    node: LONG.node,
    ...template(label('a-pod'), {
      state: { waiting: { reason: 'ImagePullBackOff', message: LONG.message } },
      ready: false,
      restarts: 0,
    }),
  })
  const pending = b.pod({
    namespace: LONG.namespace,
    name: label('a-pod-that-cannot-be-placed-anywhere'),
    age: 2 * HOUR,
    ...template(label('a-pending-pod')),
    unschedulable: words('0/5 nodes are available: 5 Insufficient memory, and', 400),
  })
  b.service({
    namespace: LONG.namespace,
    name: LONG.service,
    age,
    type: 'LoadBalancer',
    clusterIP: '10.96.123.234',
    loadBalancerIP: '203.0.113.123',
    labels: LABELS,
    selector: { 'app.kubernetes.io/instance': LONG.deployment },
    ports: [
      { name: 'a-long-port-nm', port: 8080, targetPort: 'a-long-port-nm', nodePort: 31234 },
      { name: 'metrics-port-nm', port: 9090, targetPort: 9090, nodePort: 31235 },
    ],
  })
  b.simple(
    'v1',
    'ConfigMap',
    LONG.configMap,
    LONG.namespace,
    age,
    {
      data: {
        [subdomain('a-key', 200)]: words('A value that', 3000),
        'config.yaml': Array.from(
          { length: 40 },
          (_, i) => `${label(`setting-${i}`)}: ${words('a value', 240)}`,
        ).join('\n'),
      },
    },
    { labels: LABELS, annotations: ANNOTATIONS },
  )
  b.simple(
    'v1',
    'Secret',
    LONG.secret,
    LONG.namespace,
    age,
    {
      type: 'kubernetes.io/a-type-of-secret-with-a-very-long-name-indeed',
      data: {
        [subdomain('a-secret-key', 200)]: base64(words('A secret that', 800)),
        'password-with-a-long-key-name-that-goes-on-and-on': base64('s3cr3t'),
      },
    },
    { labels: LABELS, annotations: ANNOTATIONS },
  )
  b.simple(
    'networking.k8s.io/v1',
    'Ingress',
    LONG.ingress,
    LONG.namespace,
    age,
    {
      spec: {
        ingressClassName: label('an-ingress-class'),
        tls: [{ hosts: [subdomain('tls', 200)], secretName: LONG.secret }],
        rules: [
          {
            host: subdomain('host', 200),
            http: {
              paths: [
                {
                  path: `/${label('a-path')}/${label('and-more')}/${label('and-more-again')}`,
                  pathType: 'Prefix',
                  backend: { service: { name: LONG.service, port: { number: 8080 } } },
                },
              ],
            },
          },
        ],
      },
      status: { loadBalancer: { ingress: [{ hostname: subdomain('lb', 180) }] } },
    },
    { labels: LABELS, annotations: ANNOTATIONS },
  )
  b.simple(
    'v1',
    'PersistentVolumeClaim',
    LONG.claim,
    LONG.namespace,
    age,
    {
      spec: {
        accessModes: ['ReadWriteOnce', 'ReadWriteOncePod'],
        storageClassName: label('a-storage-class'),
        resources: { requests: { storage: '10Gi' } },
        volumeName: label('pvc-0123456789abcdef'),
      },
      status: { phase: 'Bound', capacity: { storage: '10Gi' } },
    },
    { labels: LABELS },
  )
  b.simple(
    'cert-manager.io/v1',
    'Certificate',
    LONG.certificate,
    LONG.namespace,
    age,
    {
      spec: {
        secretName: LONG.secret,
        dnsNames: [subdomain('cert', 200), subdomain('cert-two', 120)],
        issuerRef: { name: label('an-issuer'), kind: 'ClusterIssuer', group: 'cert-manager.io' },
        // Fields of its own, named at length, as a CRD may have them: the field tree's.
        [label('aFieldWhoseNameGoesOnAndOnAndOn').replace(/-/g, '')]: words('A value that', 200),
        [label('anObjectWhoseNameGoesOn').replace(/-/g, '')]: {
          [label('aNestedFieldWhoseNameGoesOnAndOn').replace(/-/g, '')]: LONG.image,
          [label('aListOfLongValues').replace(/-/g, '')]: [subdomain('a', 120), subdomain('b', 90)],
          [label('anotherObjectNestedDeeper').replace(/-/g, '')]: {
            [label('theDeepestFieldWhoseNameGoesOn').replace(/-/g, '')]: true,
          },
        },
      },
      status: {
        conditions: [
          {
            type: 'Ready',
            status: 'False',
            reason: 'DoesNotExistAndHasALongReasonToSayWhy',
            message: LONG.message,
            lastTransitionTime: b.time(HOUR),
          },
        ],
      },
    },
    { labels: LABELS },
  )
  for (const [target, reason] of [
    [deployment, 'ScalingReplicaSetWithAVeryLongReasonIndeed'],
    [pending, 'FailedSchedulingBecauseNothingFitsAnywhere'],
  ] as const) {
    b.event(target, {
      type: 'Warning',
      reason,
      message: LONG.message,
      firstAgo: 2 * HOUR,
      lastAgo: 5 * MINUTE,
      count: 12345,
      component: label('a-component-that-reported-it'),
      host: LONG.node,
    })
  }
  release(b, now, {
    name: LONG.release,
    namespace: LONG.namespace,
    chart: {
      name: label('a-chart-whose-name-goes-on'),
      description: words('A chart that', 400),
      home: `https://${subdomain('charts', 120)}/${label('a-chart')}`,
      values: { image: { repository: LONG.image }, [label('a-value')]: words('A value', 300) },
    },
    revisions: [
      {
        revision: 1,
        status: 'superseded',
        ago: 9 * DAY,
        chartVersion: '1.2.3-alpha.20261007.123456+build.abcdef0123456789',
        appVersion: 'v1.23.456-build.20261007.123456-abcdef0123456789',
        description: words('Install complete, and then', 300),
        values: { image: { repository: LONG.image } },
        manifest: `---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${LONG.configMap}\n`,
      },
      {
        revision: 2,
        status: 'deployed',
        ago: 2 * DAY,
        chartVersion: '1.2.4-alpha.20261007.123456+build.abcdef0123456789',
        appVersion: 'v1.23.457-build.20261007.123456-abcdef0123456789',
        description: words('Upgrade complete, and then', 300),
        values: { image: { repository: LONG.image }, [label('a-value')]: words('A value', 300) },
        manifest: `---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${LONG.configMap}\n`,
        notes: words('Thank you for installing it. To use it,', 1200),
      },
    ],
  })
  const long = b.build()
  return {
    ...demo,
    objects: [...demo.objects, ...long.objects],
    metrics: {
      nodes: [...(demo.metrics?.nodes ?? []), ...(long.metrics?.nodes ?? [])],
      pods: [...(demo.metrics?.pods ?? []), ...(long.metrics?.pods ?? [])],
    },
    logs: (pod, container, previous) =>
      pod.metadata.namespace === LONG.namespace
        ? Array.from({ length: 30 }, (_, i) => `${i} ${words(`A log line that`, 400)}`)
        : (demo.logs?.(pod, container, previous) ?? []),
  }
}

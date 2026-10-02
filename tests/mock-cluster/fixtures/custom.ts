/**
 * Custom resources for the mock clusters: the CRDs of tools people run
 * (cert-manager, Argo CD and Rollouts, Flux, Gateway API, Istio, the
 * Prometheus operator) as their projects publish them, trimmed to what
 * matters here, with objects in every state their views show.
 */
import { DAY, HOUR, MINUTE, type clusterBuilder } from '../builders.ts'
import type { Json } from '../types.ts'

type Builder = ReturnType<typeof clusterBuilder>

export const CUSTOM = {
  namespaces: { argocd: 'argocd', flux: 'flux-system' },
  certificates: { ready: 'storefront-tls', failing: 'api-tls', issuing: 'checkout-tls' },
  clusterIssuers: { production: 'letsencrypt-prod', staging: 'letsencrypt-staging' },
  issuer: 'selfsigned',
  applications: { healthy: 'storefront', progressing: 'payments', degraded: 'legacy-batch' },
  rollout: 'checkout-canary',
  kustomizations: { ready: 'apps', suspended: 'infra', failing: 'monitoring' },
  gitRepository: 'flux-system',
  gateway: 'public',
  istioGateway: 'istio-ingress',
  httpRoute: 'storefront',
  gatewayClass: 'envoy',
  widget: 'blue-widget',
  prometheus: 'k8s',
  serviceMonitor: 'storefront',
  karpenter: {
    nodePools: { general: 'general', gpu: 'gpu', arm: 'arm' },
    nodeClasses: { default: 'default', arm: 'arm' },
    /** The demo's workers, in order, and a node still launching for redis-1. */
    nodeClaims: {
      worker1: 'general-4fk8x',
      worker2: 'general-p7n2c',
      worker3: 'general-r6t9d',
      launching: 'general-x2w5m',
    },
  },
} as const

const AGE = { name: 'Age', type: 'date', jsonPath: '.metadata.creationTimestamp' }
const READY = (path = '.status.conditions[?(@.type=="Ready")]') => [
  { name: 'Ready', type: 'string', jsonPath: `${path}.status` },
  { name: 'Status', type: 'string', jsonPath: `${path}.message`, priority: 1 },
]

const conditionsSchema = {
  type: 'array',
  description: 'List of status conditions to indicate the status of the resource.',
  items: {
    type: 'object',
    required: ['status', 'type'],
    properties: {
      type: { type: 'string', description: 'Type of the condition.' },
      status: { type: 'string', enum: ['True', 'False', 'Unknown'] },
      reason: { type: 'string' },
      message: { type: 'string' },
      lastTransitionTime: { type: 'string', format: 'date-time' },
      observedGeneration: { type: 'integer', format: 'int64' },
    },
  },
}

/** A CRD as `kubectl get crd -o yaml` shows it. */
function crd(
  b: Builder,
  age: number,
  def: {
    group: string
    kind: string
    plural: string
    scope?: 'Namespaced' | 'Cluster'
    shortNames?: string[]
    versions?: string[]
    columns?: Json[]
    spec?: Json
    status?: Json
    subresources?: Json
  },
) {
  const { group, kind, plural } = def
  const versions = def.versions ?? ['v1']
  b.simple(
    'apiextensions.k8s.io/v1',
    'CustomResourceDefinition',
    `${plural}.${group}`,
    undefined,
    age,
    {
      spec: {
        group,
        names: {
          kind,
          listKind: `${kind}List`,
          plural,
          singular: kind.toLowerCase(),
          ...(def.shortNames ? { shortNames: def.shortNames } : {}),
        },
        scope: def.scope ?? 'Namespaced',
        versions: versions.map((name, i) => ({
          name,
          served: true,
          storage: i === 0,
          ...(def.columns ? { additionalPrinterColumns: def.columns } : {}),
          schema: {
            openAPIV3Schema: {
              type: 'object',
              description: `${kind} is a ${group} resource.`,
              properties: {
                spec: def.spec ?? { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
                ...(def.status !== undefined ? { status: def.status } : {}),
              },
            },
          },
          ...(def.subresources ? { subresources: def.subresources } : {}),
        })),
      },
      status: {
        acceptedNames: { kind, plural },
        conditions: [
          {
            type: 'Established',
            status: 'True',
            reason: 'InitialNamesAccepted',
            message: 'the initial names have been accepted',
          },
        ],
        storedVersions: [versions[0]],
      },
    },
    { labels: { 'app.kubernetes.io/part-of': group.split('.')[0]! } },
  )
}

const condition = (
  type: string,
  status: 'True' | 'False' | 'Unknown',
  reason: string,
  message: string,
  ago: number,
  now: number,
  generation = 1,
) => ({
  type,
  status,
  reason,
  message,
  lastTransitionTime: new Date(now - ago).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  observedGeneration: generation,
})

const at = (now: number, offset: number) =>
  new Date(now + offset).toISOString().replace(/\.\d{3}Z$/, 'Z')

/** The demo cluster's custom resources. */
export function demoCustomResources(b: Builder, now: number): void {
  const c = (
    type: string,
    status: 'True' | 'False' | 'Unknown',
    reason: string,
    message: string,
    ago: number,
    generation = 1,
  ) => condition(type, status, reason, message, ago, now, generation)

  // ── cert-manager ─────────────────────────────────────────────────────────
  crd(b, 80 * DAY, {
    group: 'cert-manager.io',
    kind: 'Certificate',
    plural: 'certificates',
    shortNames: ['cert', 'certs'],
    columns: [
      ...READY(),
      { name: 'Secret', type: 'string', jsonPath: '.spec.secretName' },
      { name: 'Issuer', type: 'string', jsonPath: '.spec.issuerRef.name', priority: 1 },
      AGE,
    ],
    spec: {
      type: 'object',
      description: 'Specification of the desired state of the Certificate resource.',
      required: ['issuerRef', 'secretName'],
      properties: {
        secretName: {
          type: 'string',
          description:
            'Name of the Secret resource that will be automatically created and managed by this Certificate resource.',
        },
        dnsNames: {
          type: 'array',
          description: 'Requested DNS subject alternative names.',
          items: { type: 'string' },
        },
        duration: { type: 'string', description: 'Requested lifetime of the Certificate.' },
        renewBefore: {
          type: 'string',
          description:
            'How long before the currently issued certificate’s expiry cert-manager should renew the certificate.',
        },
        issuerRef: {
          type: 'object',
          description: 'Reference to the issuer responsible for issuing the certificate.',
          required: ['name'],
          properties: {
            name: { type: 'string', description: 'Name of the resource being referred to.' },
            kind: { type: 'string', description: 'Kind of the resource being referred to.' },
            group: { type: 'string', description: 'Group of the resource being referred to.' },
          },
        },
      },
    },
    status: {
      type: 'object',
      description: 'Status of the Certificate.',
      properties: {
        conditions: conditionsSchema,
        notAfter: {
          type: 'string',
          format: 'date-time',
          description:
            'The expiration time of the certificate stored in the secret named by this resource in `spec.secretName`.',
        },
        notBefore: { type: 'string', format: 'date-time' },
        renewalTime: {
          type: 'string',
          format: 'date-time',
          description: 'RenewalTime is the time at which the certificate will be next renewed.',
        },
        revision: { type: 'integer' },
      },
    },
    subresources: { status: {} },
  })
  const issuerSpec = {
    type: 'object',
    properties: {
      acme: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
      selfSigned: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
    },
  }
  for (const [kind, plural, scope] of [
    ['ClusterIssuer', 'clusterissuers', 'Cluster'],
    ['Issuer', 'issuers', 'Namespaced'],
  ] as const) {
    crd(b, 80 * DAY, {
      group: 'cert-manager.io',
      kind,
      plural,
      scope,
      columns: [...READY(), AGE],
      spec: issuerSpec,
      status: { type: 'object', properties: { conditions: conditionsSchema } },
      subresources: { status: {} },
    })
  }
  const acme = (server: string) => ({
    acme: {
      server,
      email: 'platform@example.com',
      privateKeySecretRef: { name: 'letsencrypt-account' },
      solvers: [{ http01: { ingress: { ingressClassName: 'nginx' } } }],
    },
  })
  b.simple(
    'cert-manager.io/v1',
    'ClusterIssuer',
    CUSTOM.clusterIssuers.production,
    undefined,
    79 * DAY,
    {
      spec: acme('https://acme-v02.api.letsencrypt.org/directory'),
      status: {
        conditions: [
          c(
            'Ready',
            'True',
            'ACMEAccountRegistered',
            'The ACME account was registered with the ACME server',
            79 * DAY,
          ),
        ],
      },
    },
  )
  b.simple(
    'cert-manager.io/v1',
    'ClusterIssuer',
    CUSTOM.clusterIssuers.staging,
    undefined,
    79 * DAY,
    {
      spec: acme('https://acme-staging-v02.api.letsencrypt.org/directory'),
      status: {
        conditions: [
          c(
            'Ready',
            'True',
            'ACMEAccountRegistered',
            'The ACME account was registered with the ACME server',
            79 * DAY,
          ),
        ],
      },
    },
  )
  b.simple('cert-manager.io/v1', 'Issuer', CUSTOM.issuer, 'shop', 40 * DAY, {
    spec: { selfSigned: {} },
    status: { conditions: [c('Ready', 'True', 'IsReady', '', 40 * DAY)] },
  })
  const certificate = (name: string, hosts: string[], age: number, status: Json) =>
    b.simple(
      'cert-manager.io/v1',
      'Certificate',
      name,
      'shop',
      age,
      {
        spec: {
          secretName: name,
          dnsNames: hosts,
          duration: '2160h0m0s',
          renewBefore: '720h0m0s',
          issuerRef: {
            name: CUSTOM.clusterIssuers.production,
            kind: 'ClusterIssuer',
            group: 'cert-manager.io',
          },
        },
        status,
      },
      { generation: 1, labels: { 'app.kubernetes.io/name': name.replace(/-tls$/, '') } },
    )
  certificate(CUSTOM.certificates.ready, ['shop.example.com', 'www.shop.example.com'], 70 * DAY, {
    conditions: [
      c('Ready', 'True', 'Ready', 'Certificate is up to date and has not expired', 10 * DAY),
    ],
    notBefore: at(now, -10 * DAY),
    notAfter: at(now, 80 * DAY),
    renewalTime: at(now, 50 * DAY),
    revision: 3,
  })
  certificate(CUSTOM.certificates.failing, ['api.shop.example.com'], 12 * DAY, {
    conditions: [
      c(
        'Ready',
        'False',
        'Failed',
        'The certificate request has failed to complete and will be retried: Failed to wait for order resource "api-tls-1-3047882241" to become ready: order is in "invalid" state: 403 urn:ietf:params:acme:error:unauthorized',
        2 * HOUR,
      ),
      c(
        'Issuing',
        'False',
        'Failed',
        'The certificate request has failed to complete and will be retried',
        2 * HOUR,
      ),
    ],
    lastFailureTime: at(now, -2 * HOUR),
    failedIssuanceAttempts: 4,
  })
  const issuing = certificate(
    CUSTOM.certificates.issuing,
    ['checkout.shop.example.com'],
    3 * MINUTE,
    {
      conditions: [
        c(
          'Ready',
          'False',
          'DoesNotExist',
          'Issuing certificate as Secret does not exist',
          3 * MINUTE,
        ),
        c(
          'Issuing',
          'True',
          'DoesNotExist',
          'Issuing certificate as Secret does not exist',
          3 * MINUTE,
        ),
      ],
    },
  )
  b.event(issuing, {
    type: 'Normal',
    reason: 'Issuing',
    message: 'Issuing certificate as Secret does not exist',
    firstAgo: 3 * MINUTE,
    component: 'cert-manager-certificates-trigger',
  })

  // ── Argo CD and Argo Rollouts ───────────────────────────────────────────
  b.namespace(CUSTOM.namespaces.argocd, 75 * DAY)
  crd(b, 75 * DAY, {
    group: 'argoproj.io',
    kind: 'Application',
    plural: 'applications',
    shortNames: ['app', 'apps'],
    versions: ['v1alpha1'],
    columns: [
      { name: 'Sync Status', type: 'string', jsonPath: '.status.sync.status' },
      { name: 'Health Status', type: 'string', jsonPath: '.status.health.status' },
      { name: 'Revision', type: 'string', jsonPath: '.status.sync.revision', priority: 10 },
      { name: 'Project', type: 'string', jsonPath: '.spec.project', priority: 10 },
    ],
  })
  const application = (name: string, path: string, sync: string, health: Json, age: number) =>
    b.simple('argoproj.io/v1alpha1', 'Application', name, CUSTOM.namespaces.argocd, age, {
      spec: {
        project: 'default',
        source: { repoURL: 'https://github.com/example/deploy.git', path, targetRevision: 'main' },
        destination: { server: 'https://kubernetes.default.svc', namespace: path.split('/')[1] },
        syncPolicy: { automated: { prune: true, selfHeal: true } },
      },
      status: {
        sync: { status: sync, revision: '9f3c2a1d8b7e6f5a4c3b2a1908f7e6d5c4b3a291' },
        health,
        reconciledAt: at(now, -2 * MINUTE),
        operationState: { phase: 'Succeeded', finishedAt: at(now, -HOUR) },
      },
    })
  application(CUSTOM.applications.healthy, 'apps/shop', 'Synced', { status: 'Healthy' }, 70 * DAY)
  application(
    CUSTOM.applications.progressing,
    'apps/payments',
    'OutOfSync',
    {
      status: 'Progressing',
      message: 'Waiting for rollout to finish: 1 out of 2 new replicas are available',
    },
    20 * DAY,
  )
  application(
    CUSTOM.applications.degraded,
    'apps/batch',
    'Synced',
    { status: 'Degraded', message: 'Job has reached the specified backoff limit' },
    30 * DAY,
  )

  crd(b, 50 * DAY, {
    group: 'argoproj.io',
    kind: 'Rollout',
    plural: 'rollouts',
    shortNames: ['ro'],
    versions: ['v1alpha1'],
    columns: [
      { name: 'Desired', type: 'integer', jsonPath: '.spec.replicas' },
      { name: 'Current', type: 'integer', jsonPath: '.status.replicas' },
      { name: 'Up-to-date', type: 'integer', jsonPath: '.status.updatedReplicas' },
      { name: 'Available', type: 'integer', jsonPath: '.status.availableReplicas' },
      AGE,
    ],
    spec: {
      type: 'object',
      properties: {
        replicas: { type: 'integer', minimum: 0, description: 'Number of desired pods.' },
        paused: { type: 'boolean' },
        selector: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
        strategy: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
        template: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
      },
    },
    status: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
    subresources: {
      status: {},
      scale: {
        specReplicasPath: '.spec.replicas',
        statusReplicasPath: '.status.HPAReplicas',
        labelSelectorPath: '.status.selector',
      },
    },
  })
  b.simple(
    'argoproj.io/v1alpha1',
    'Rollout',
    CUSTOM.rollout,
    'shop',
    14 * DAY,
    {
      spec: {
        replicas: 4,
        selector: { matchLabels: { 'app.kubernetes.io/name': 'storefront' } },
        strategy: {
          canary: { steps: [{ setWeight: 20 }, { pause: { duration: '10m' } }, { setWeight: 60 }] },
        },
        template: {
          metadata: { labels: { 'app.kubernetes.io/name': 'storefront' } },
          spec: { containers: [{ name: 'app', image: 'ghcr.io/example/storefront:2.4.1' }] },
        },
      },
      status: {
        phase: 'Healthy',
        replicas: 4,
        HPAReplicas: 4,
        updatedReplicas: 4,
        readyReplicas: 4,
        availableReplicas: 4,
        selector: 'app.kubernetes.io/name=storefront',
        observedGeneration: '1',
      },
    },
    { generation: 1 },
  )

  // ── Flux ─────────────────────────────────────────────────────────────────
  b.namespace(CUSTOM.namespaces.flux, 90 * DAY)
  crd(b, 90 * DAY, {
    group: 'kustomize.toolkit.fluxcd.io',
    kind: 'Kustomization',
    plural: 'kustomizations',
    shortNames: ['ks'],
    columns: [AGE, ...READY().map((col) => ({ ...col, priority: 0 }))],
    spec: {
      type: 'object',
      required: ['interval', 'prune', 'sourceRef'],
      properties: {
        interval: {
          type: 'string',
          description: 'The interval at which to reconcile the Kustomization.',
        },
        path: {
          type: 'string',
          description: 'Path to the directory containing the kustomization.yaml file.',
        },
        prune: { type: 'boolean', description: 'Prune enables garbage collection.' },
        suspend: {
          type: 'boolean',
          description: 'This flag tells the controller to suspend subsequent kustomize executions.',
        },
        sourceRef: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
      },
    },
    status: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
    subresources: { status: {} },
  })
  const kustomization = (name: string, path: string, suspend: boolean, ready: Json, age: number) =>
    b.simple(
      'kustomize.toolkit.fluxcd.io/v1',
      'Kustomization',
      name,
      CUSTOM.namespaces.flux,
      age,
      {
        spec: {
          interval: '10m0s',
          path,
          prune: true,
          ...(suspend ? { suspend: true } : {}),
          sourceRef: { kind: 'GitRepository', name: CUSTOM.gitRepository },
        },
        status: {
          observedGeneration: 1,
          lastAppliedRevision: 'main@sha1:4b8e2f1a',
          conditions: [ready],
        },
      },
      { generation: 1 },
    )
  kustomization(
    CUSTOM.kustomizations.ready,
    './apps',
    false,
    c(
      'Ready',
      'True',
      'ReconciliationSucceeded',
      'Applied revision: main@sha1:4b8e2f1a',
      4 * MINUTE,
    ),
    88 * DAY,
  )
  kustomization(
    CUSTOM.kustomizations.suspended,
    './infrastructure',
    true,
    c('Ready', 'True', 'ReconciliationSucceeded', 'Applied revision: main@sha1:1c9d7e3b', 6 * DAY),
    88 * DAY,
  )
  kustomization(
    CUSTOM.kustomizations.failing,
    './monitoring',
    false,
    c(
      'Ready',
      'False',
      'BuildFailed',
      "kustomize build failed: accumulating resources: accumulation err='accumulating resources from 'grafana': evalsymlink failure on '/tmp/kustomization/monitoring/grafana' : lstat /tmp/kustomization/monitoring/grafana: no such file or directory'",
      12 * MINUTE,
    ),
    40 * DAY,
  )
  crd(b, 90 * DAY, {
    group: 'helm.toolkit.fluxcd.io',
    kind: 'HelmRelease',
    plural: 'helmreleases',
    shortNames: ['hr'],
    versions: ['v2'],
    columns: [AGE, ...READY().map((col) => ({ ...col, priority: 0 }))],
    subresources: { status: {} },
  })
  b.simple(
    'helm.toolkit.fluxcd.io/v2',
    'HelmRelease',
    'podinfo',
    CUSTOM.namespaces.flux,
    30 * DAY,
    {
      spec: {
        interval: '10m',
        chart: {
          spec: {
            chart: 'podinfo',
            version: '6.7.x',
            sourceRef: { kind: 'HelmRepository', name: 'podinfo' },
          },
        },
        values: { replicaCount: 2 },
      },
      status: {
        conditions: [
          c(
            'Ready',
            'True',
            'InstallSucceeded',
            'Helm install succeeded for release flux-system/podinfo.v1 with chart podinfo@6.7.1',
            30 * DAY,
          ),
        ],
        history: [{ chartVersion: '6.7.1', status: 'deployed', version: 1 }],
      },
    },
    { generation: 1 },
  )
  crd(b, 90 * DAY, {
    group: 'source.toolkit.fluxcd.io',
    kind: 'GitRepository',
    plural: 'gitrepositories',
    shortNames: ['gitrepo'],
    columns: [{ name: 'URL', type: 'string', jsonPath: '.spec.url' }, AGE, ...READY()],
    subresources: { status: {} },
  })
  b.simple(
    'source.toolkit.fluxcd.io/v1',
    'GitRepository',
    CUSTOM.gitRepository,
    CUSTOM.namespaces.flux,
    90 * DAY,
    {
      spec: {
        interval: '1m0s',
        url: 'ssh://git@github.com/example/fleet',
        ref: { branch: 'main' },
      },
      status: {
        artifact: { revision: 'main@sha1:4b8e2f1a', lastUpdateTime: at(now, -4 * MINUTE) },
        conditions: [
          c(
            'Ready',
            'True',
            'Succeeded',
            "stored artifact for revision 'main@sha1:4b8e2f1a'",
            4 * MINUTE,
          ),
        ],
      },
    },
  )

  // ── Gateway API, and Istio's own Gateway ──────────────────────────────────
  crd(b, 60 * DAY, {
    group: 'gateway.networking.k8s.io',
    kind: 'GatewayClass',
    plural: 'gatewayclasses',
    scope: 'Cluster',
    shortNames: ['gc'],
    columns: [
      { name: 'Controller', type: 'string', jsonPath: '.spec.controllerName' },
      {
        name: 'Accepted',
        type: 'string',
        jsonPath: '.status.conditions[?(@.type=="Accepted")].status',
      },
      AGE,
    ],
    subresources: { status: {} },
  })
  crd(b, 60 * DAY, {
    group: 'gateway.networking.k8s.io',
    kind: 'Gateway',
    plural: 'gateways',
    shortNames: ['gtw'],
    columns: [
      { name: 'Class', type: 'string', jsonPath: '.spec.gatewayClassName' },
      { name: 'Address', type: 'string', jsonPath: '.status.addresses[*].value' },
      {
        name: 'Programmed',
        type: 'string',
        jsonPath: '.status.conditions[?(@.type=="Programmed")].status',
      },
      AGE,
    ],
    subresources: { status: {} },
  })
  crd(b, 60 * DAY, {
    group: 'gateway.networking.k8s.io',
    kind: 'HTTPRoute',
    plural: 'httproutes',
    columns: [{ name: 'Hostnames', type: 'string', jsonPath: '.spec.hostnames' }, AGE],
    subresources: { status: {} },
  })
  b.simple(
    'gateway.networking.k8s.io/v1',
    'GatewayClass',
    CUSTOM.gatewayClass,
    undefined,
    60 * DAY,
    {
      spec: { controllerName: 'gateway.envoyproxy.io/gatewayclass-controller' },
      status: { conditions: [c('Accepted', 'True', 'Accepted', 'Valid GatewayClass', 60 * DAY)] },
    },
  )
  b.simple('gateway.networking.k8s.io/v1', 'Gateway', CUSTOM.gateway, 'shop', 59 * DAY, {
    spec: {
      gatewayClassName: CUSTOM.gatewayClass,
      listeners: [{ name: 'https', protocol: 'HTTPS', port: 443, hostname: '*.shop.example.com' }],
    },
    status: {
      addresses: [{ type: 'IPAddress', value: '203.0.113.24' }],
      conditions: [
        c(
          'Accepted',
          'True',
          'Accepted',
          'The Gateway has been scheduled by Envoy Gateway',
          59 * DAY,
        ),
        c(
          'Programmed',
          'True',
          'Programmed',
          'Address assigned to the Gateway, 1/1 envoy Deployment replicas available',
          59 * DAY,
        ),
      ],
    },
  })
  b.simple('gateway.networking.k8s.io/v1', 'HTTPRoute', CUSTOM.httpRoute, 'shop', 59 * DAY, {
    spec: {
      parentRefs: [{ name: CUSTOM.gateway }],
      hostnames: ['shop.example.com'],
      rules: [{ backendRefs: [{ name: 'storefront', port: 80 }] }],
    },
    status: {
      parents: [
        {
          parentRef: { name: CUSTOM.gateway },
          controllerName: 'gateway.envoyproxy.io/gatewayclass-controller',
          conditions: [c('Accepted', 'True', 'Accepted', 'Route is accepted', 59 * DAY)],
        },
      ],
    },
  })
  crd(b, 45 * DAY, {
    group: 'networking.istio.io',
    kind: 'Gateway',
    plural: 'gateways',
    shortNames: ['gw'],
    columns: [AGE],
  })
  b.simple('networking.istio.io/v1', 'Gateway', CUSTOM.istioGateway, 'shop', 44 * DAY, {
    spec: {
      selector: { istio: 'ingressgateway' },
      servers: [{ port: { number: 80, name: 'http', protocol: 'HTTP' }, hosts: ['*'] }],
    },
  })

  // ── Prometheus operator ──────────────────────────────────────────────────
  crd(b, 110 * DAY, {
    group: 'monitoring.coreos.com',
    kind: 'Prometheus',
    plural: 'prometheuses',
    shortNames: ['prom'],
    columns: [
      { name: 'Version', type: 'string', jsonPath: '.spec.version' },
      { name: 'Desired', type: 'integer', jsonPath: '.spec.replicas' },
      { name: 'Ready', type: 'integer', jsonPath: '.status.availableReplicas' },
      {
        name: 'Reconciled',
        type: 'string',
        jsonPath: ".status.conditions[?(@.type == 'Reconciled')].status",
      },
      {
        name: 'Available',
        type: 'string',
        jsonPath: ".status.conditions[?(@.type == 'Available')].status",
      },
      AGE,
    ],
    subresources: {
      status: {},
      scale: {
        specReplicasPath: '.spec.shards',
        statusReplicasPath: '.status.shards',
        labelSelectorPath: '.status.selector',
      },
    },
  })
  b.simple('monitoring.coreos.com/v1', 'Prometheus', CUSTOM.prometheus, 'monitoring', 110 * DAY, {
    spec: { version: 'v3.5.0', replicas: 1, shards: 1, retention: '15d' },
    status: {
      availableReplicas: 1,
      replicas: 1,
      shards: 1,
      selector: 'app.kubernetes.io/name=prometheus',
      conditions: [
        c('Available', 'True', '', '', 6 * DAY),
        c('Reconciled', 'True', '', '', 6 * DAY),
      ],
    },
  })
  crd(b, 110 * DAY, {
    group: 'monitoring.coreos.com',
    kind: 'ServiceMonitor',
    plural: 'servicemonitors',
    shortNames: ['smon'],
  })
  b.simple('monitoring.coreos.com/v1', 'ServiceMonitor', CUSTOM.serviceMonitor, 'shop', 60 * DAY, {
    spec: {
      selector: { matchLabels: { app: 'storefront' } },
      endpoints: [
        { port: 'metrics', interval: '30s' },
        { port: 'admin', path: '/stats' },
      ],
    },
  })

  karpenter(b, now)
  widgets(b)
  databases(b, now)
  for (const namespace of ['default', 'shop']) {
    b.simple('v1', 'ServiceAccount', 'default', namespace, 88 * DAY, {})
  }
  b.simple('v1', 'ServiceAccount', 'storefront', 'shop', 70 * DAY, {
    automountServiceAccountToken: false,
  })
  b.simple('rbac.authorization.k8s.io/v1', 'ClusterRole', 'view', undefined, 800 * DAY, {
    rules: [{ apiGroups: [''], resources: ['pods', 'services'], verbs: ['get', 'list', 'watch'] }],
  })
}

/** Karpenter's CRDs, as it installs them on AWS. */
export function karpenterKinds(b: Builder): void {
  const cluster = { scope: 'Cluster' as const, subresources: { status: {} } }
  crd(b, 200 * DAY, {
    ...cluster,
    group: 'karpenter.sh',
    kind: 'NodePool',
    plural: 'nodepools',
    columns: [
      { name: 'NodeClass', type: 'string', jsonPath: '.spec.template.spec.nodeClassRef.name' },
      { name: 'Nodes', type: 'string', jsonPath: '.status.resources.nodes' },
      { name: 'Ready', type: 'string', jsonPath: '.status.conditions[?(@.type=="Ready")].status' },
      AGE,
      { name: 'Weight', type: 'integer', jsonPath: '.spec.weight', priority: 1 },
      { name: 'CPU', type: 'string', jsonPath: '.status.resources.cpu', priority: 1 },
      { name: 'Memory', type: 'string', jsonPath: '.status.resources.memory', priority: 1 },
    ],
  })
  crd(b, 200 * DAY, {
    ...cluster,
    group: 'karpenter.sh',
    kind: 'NodeClaim',
    plural: 'nodeclaims',
    columns: [
      {
        name: 'Type',
        type: 'string',
        jsonPath: '.metadata.labels.node\\.kubernetes\\.io/instance-type',
      },
      {
        name: 'Capacity',
        type: 'string',
        jsonPath: '.metadata.labels.karpenter\\.sh/capacity-type',
      },
      {
        name: 'Zone',
        type: 'string',
        jsonPath: '.metadata.labels.topology\\.kubernetes\\.io/zone',
      },
      { name: 'Node', type: 'string', jsonPath: '.status.nodeName' },
      { name: 'Ready', type: 'string', jsonPath: '.status.conditions[?(@.type=="Ready")].status' },
      AGE,
    ],
  })
  crd(b, 200 * DAY, {
    ...cluster,
    group: 'karpenter.k8s.aws',
    kind: 'EC2NodeClass',
    plural: 'ec2nodeclasses',
    shortNames: ['ec2nc', 'ec2ncs'],
    columns: [
      { name: 'Ready', type: 'string', jsonPath: '.status.conditions[?(@.type=="Ready")].status' },
      AGE,
      { name: 'Role', type: 'string', jsonPath: '.spec.role', priority: 1 },
    ],
  })
}

/**
 * Karpenter, on AWS: the node pools the demo's workers come from (one of them
 * drifted), one scaled to zero, one whose node class is broken, and a node
 * being launched for the pod that can't be scheduled.
 */
function karpenter(b: Builder, now: number): void {
  const { nodePools, nodeClasses, nodeClaims } = CUSTOM.karpenter
  karpenterKinds(b)

  const nodeClass = (name: string, ready: boolean, age: number) =>
    b.simple('karpenter.k8s.aws/v1', 'EC2NodeClass', name, undefined, age, {
      spec: {
        role: 'KarpenterNodeRole-production',
        amiSelectorTerms: [{ alias: 'al2023@latest' }],
        subnetSelectorTerms: [{ tags: { 'karpenter.sh/discovery': `production-${name}` } }],
        securityGroupSelectorTerms: [{ tags: { 'karpenter.sh/discovery': 'production' } }],
      },
      status: {
        conditions: ready
          ? [
              condition('SubnetsReady', 'True', 'SubnetsReady', '', age, now),
              condition('Ready', 'True', 'Ready', '', age, now),
            ]
          : [
              condition(
                'SubnetsReady',
                'False',
                'SubnetsNotFound',
                'SubnetSelector did not match any Subnets',
                age,
                now,
              ),
              condition('Ready', 'False', 'SubnetsNotReady', 'SubnetsReady=False', age, now),
            ],
      },
    })
  nodeClass(nodeClasses.default, true, 200 * DAY)
  nodeClass(nodeClasses.arm, false, 3 * DAY)

  const nodePool = (
    name: string,
    age: number,
    spec: { nodeClass: string; weight?: number; limits?: Json; requirements: Json[] },
    status: { resources?: Record<string, string>; ready: boolean },
  ) =>
    b.simple('karpenter.sh/v1', 'NodePool', name, undefined, age, {
      spec: {
        ...(spec.weight === undefined ? {} : { weight: spec.weight }),
        template: {
          spec: {
            nodeClassRef: {
              group: 'karpenter.k8s.aws',
              kind: 'EC2NodeClass',
              name: spec.nodeClass,
            },
            requirements: spec.requirements,
            expireAfter: 'Never',
          },
        },
        ...(spec.limits ? { limits: spec.limits } : {}),
        disruption: { consolidationPolicy: 'WhenEmptyOrUnderutilized', consolidateAfter: '1m' },
      },
      status: {
        ...(status.resources ? { resources: status.resources } : {}),
        conditions: status.ready
          ? [
              condition('ValidationSucceeded', 'True', 'ValidationSucceeded', '', age, now),
              condition('NodeClassReady', 'True', 'NodeClassReady', '', age, now),
              condition('Ready', 'True', 'Ready', '', age, now),
            ]
          : [
              condition('ValidationSucceeded', 'True', 'ValidationSucceeded', '', age, now),
              condition(
                'NodeClassReady',
                'False',
                'NodeClassNotReady',
                `EC2NodeClass "${spec.nodeClass}" is not ready`,
                age,
                now,
              ),
              condition(
                'Ready',
                'False',
                'NodeClassNotReady',
                `EC2NodeClass "${spec.nodeClass}" is not ready`,
                age,
                now,
              ),
            ],
      },
    })
  const capacityTypes = (values: string[]) => ({
    key: 'karpenter.sh/capacity-type',
    operator: 'In',
    values,
  })
  nodePool(
    nodePools.general,
    200 * DAY,
    {
      nodeClass: nodeClasses.default,
      weight: 10,
      limits: { cpu: '64', memory: '256Gi' },
      requirements: [
        capacityTypes(['spot', 'on-demand']),
        { key: 'karpenter.k8s.aws/instance-family', operator: 'In', values: ['m6i', 'c6i'] },
        { key: 'kubernetes.io/arch', operator: 'In', values: ['amd64'] },
      ],
    },
    { resources: { cpu: '24', memory: '96Gi', pods: '330', nodes: '3' }, ready: true },
  )
  nodePool(
    nodePools.gpu,
    90 * DAY,
    {
      nodeClass: nodeClasses.default,
      limits: { cpu: '64', 'nvidia.com/gpu': '4' },
      // Without a capacity type, Karpenter launches on-demand nodes: any with a GPU, but an old one.
      requirements: [
        { key: 'karpenter.k8s.aws/instance-gpu-count', operator: 'Gt', values: ['0'] },
        { key: 'node.kubernetes.io/instance-type', operator: 'NotIn', values: ['g4dn.xlarge'] },
      ],
    },
    { resources: { cpu: '0', memory: '0', nodes: '0' }, ready: true },
  )
  nodePool(
    nodePools.arm,
    3 * DAY,
    {
      nodeClass: nodeClasses.arm,
      // New, without limits, and never ready: nothing it has launched to count.
      requirements: [
        capacityTypes(['spot']),
        { key: 'kubernetes.io/arch', operator: 'In', values: ['arm64'] },
      ],
    },
    { ready: false },
  )

  const nodeClaim = (
    name: string,
    age: number,
    node: { name?: string; capacity: 'spot' | 'on-demand'; type: string; zone: string },
    conditions: ReturnType<typeof condition>[],
  ) =>
    b.simple(
      'karpenter.sh/v1',
      'NodeClaim',
      name,
      undefined,
      age,
      {
        spec: {
          nodeClassRef: {
            group: 'karpenter.k8s.aws',
            kind: 'EC2NodeClass',
            name: nodeClasses.default,
          },
          requirements: [capacityTypes([node.capacity])],
          resources: { requests: { cpu: '2150m', memory: '6Gi', pods: '9' } },
          expireAfter: 'Never',
        },
        status: {
          ...(node.name
            ? { nodeName: node.name, providerID: `kubestacks://eu-west-1/${node.name}` }
            : { providerID: 'aws:///eu-west-1b/i-0c2f7a91d3e5b8604' }),
          imageID: 'ami-0e4b2cfa1d78e3f05',
          capacity: { cpu: '8', memory: '32Gi', pods: '110' },
          allocatable: { cpu: '7910m', memory: '31130Mi', pods: '110' },
          conditions,
        },
      },
      {
        labels: {
          'karpenter.sh/nodepool': nodePools.general,
          'karpenter.sh/capacity-type': node.capacity,
          'node.kubernetes.io/instance-type': node.type,
          'topology.kubernetes.io/zone': node.zone,
          'kubernetes.io/arch': 'amd64',
        },
        ownerReferences: [
          {
            apiVersion: 'karpenter.sh/v1',
            kind: 'NodePool',
            name: nodePools.general,
            uid: `nodepool-${nodePools.general}`,
            blockOwnerDeletion: true,
          },
        ],
        finalizers: ['karpenter.sh/termination'],
      },
    )
  const running = (age: number) => [
    condition('Launched', 'True', 'Launched', '', age, now),
    condition('Registered', 'True', 'Registered', '', age - 40 * 1000, now),
    condition('Initialized', 'True', 'Initialized', '', age - 70 * 1000, now),
  ]
  nodeClaim(
    nodeClaims.worker1,
    800 * DAY - HOUR,
    { name: 'worker-1', capacity: 'on-demand', type: 'm6i.2xlarge', zone: 'eu-west-1a' },
    [...running(800 * DAY - HOUR), condition('Ready', 'True', 'Ready', '', 800 * DAY, now)],
  )
  nodeClaim(
    nodeClaims.worker2,
    96 * DAY,
    { name: 'worker-2', capacity: 'spot', type: 'm6i.2xlarge', zone: 'eu-west-1b' },
    [
      ...running(96 * DAY),
      condition(
        'Drifted',
        'True',
        'NodeClassDrift',
        'EC2NodeClass default changed: amiSelectorTerms',
        2 * HOUR,
        now,
      ),
      condition('Ready', 'True', 'Ready', '', 96 * DAY, now),
    ],
  )
  nodeClaim(
    nodeClaims.worker3,
    45 * DAY,
    { name: 'worker-3', capacity: 'spot', type: 'm6i.2xlarge', zone: 'eu-west-1c' },
    [
      ...running(45 * DAY),
      condition('Ready', 'Unknown', 'NodeNotReady', 'Node status is NotReady', 53 * MINUTE, now),
    ],
  )
  nodeClaim(
    nodeClaims.launching,
    40 * 1000,
    { capacity: 'spot', type: 'c6i.2xlarge', zone: 'eu-west-1b' },
    [
      condition('Launched', 'True', 'Launched', '', 30 * 1000, now),
      condition(
        'Registered',
        'Unknown',
        'AwaitingReconciliation',
        'Node not registered with cluster',
        30 * 1000,
        now,
      ),
      condition(
        'Initialized',
        'Unknown',
        'AwaitingReconciliation',
        'Node not initialized',
        30 * 1000,
        now,
      ),
      condition(
        'Ready',
        'Unknown',
        'AwaitingReconciliation',
        'Node not registered with cluster',
        30 * 1000,
        now,
      ),
    ],
  )
}

/**
 * A CRD without a view: the server's printer columns, and objects in every
 * state the usual conventions describe (conditions, kstatus, suspension,
 * generations, phases, Argo-style health).
 */
function databases(b: Builder, now: number): void {
  crd(b, 30 * DAY, {
    group: 'example.com',
    kind: 'Database',
    plural: 'databases',
    shortNames: ['db'],
    columns: [
      { name: 'Engine', type: 'string', jsonPath: '.spec.engine' },
      {
        name: 'Storage',
        type: 'integer',
        jsonPath: '.spec.storageGB',
        description: 'Disk size, in GiB.',
      },
      { name: 'CPU', type: 'number', jsonPath: '.spec.cpu' },
      { name: 'HA', type: 'boolean', jsonPath: '.spec.highAvailability' },
      { name: 'Backed up', type: 'date', jsonPath: '.status.lastBackup' },
      { name: 'Ready', type: 'string', jsonPath: '.status.conditions[?(@.type=="Ready")].status' },
      { name: 'Endpoint', type: 'string', jsonPath: '.status.endpoint', priority: 1 },
      AGE,
    ],
    spec: {
      type: 'object',
      properties: {
        engine: { type: 'string', enum: ['postgres', 'mysql'] },
        storageGB: {
          type: 'integer',
          minimum: 1,
          description:
            'How much disk the database gets, in GiB. Storage can grow but never shrink: the operator expands the volume online when the storage class allows it, and otherwise creates a larger volume, copies the data over during the next maintenance window, and switches to it. Backups are taken before every resize, and kept for as long as the backup retention says.',
        },
        port: {
          'x-kubernetes-int-or-string': true,
          description: 'The port to listen on, by number or by name.',
        },
        cpu: { type: 'number' },
        highAvailability: { type: 'boolean' },
        suspend: { type: 'boolean' },
        paused: { type: 'boolean' },
      },
    },
    status: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
    subresources: { status: {} },
  })
  const c = (type: string, status: 'True' | 'False' | 'Unknown', reason = '', message = '') =>
    condition(type, status, reason, message, HOUR, now)
  const database = (name: string, age: number, spec: Json, status: Json, meta: Json = {}) =>
    b.simple(
      'example.com/v1',
      'Database',
      name,
      'data',
      age,
      {
        spec: { engine: 'postgres', storageGB: 20, cpu: 1, highAvailability: false, ...spec },
        status,
      },
      { generation: 1, ...meta },
    )
  database(
    'orders',
    30 * DAY,
    {
      storageGB: 200,
      cpu: 4,
      highAvailability: true,
      tags: [],
      options: {},
      backupWindow: null,
    },
    {
      conditions: [c('Ready', 'True', 'Available')],
      lastBackup: at(now, -2 * HOUR),
      endpoint: 'orders.data.svc:5432',
    },
  )
  database(
    'analytics',
    9 * DAY,
    { engine: 'mysql', storageGB: 500, cpu: 2.5 },
    {
      conditions: [
        c(
          'Ready',
          'False',
          'ProvisioningFailed',
          'Quota exceeded for resource disks: 500 GiB requested, 300 GiB available',
        ),
      ],
    },
  )
  database(
    'search',
    2 * HOUR,
    {},
    {
      conditions: [
        c('Reconciling', 'True', 'Progressing', 'Creating replicas: 1 of 2 ready'),
        c('Ready', 'False', 'Progressing'),
      ],
    },
  )
  database(
    'legacy',
    300 * DAY,
    { engine: 'mysql' },
    {
      conditions: [
        c('Stalled', 'True', 'UpgradeBlocked', 'mysql 5.7 can’t be upgraded in place'),
        c('Ready', 'False'),
      ],
    },
  )
  database('cache', 40 * DAY, { suspend: true, storageGB: 5 }, { conditions: [c('Ready', 'True')] })
  database(
    'archive',
    100 * DAY,
    { storageGB: 1000 },
    {
      observedGeneration: 2,
      conditions: [c('Ready', 'True')],
      // A backup scheduled ahead of time: the API server prints future dates as <invalid>.
      lastBackup: at(now, 3 * DAY),
    },
    { generation: 3 },
  )
  database(
    'reports',
    12 * DAY,
    {},
    { conditions: [c('Ready', 'True')] },
    {
      deletionTimestamp: at(now, -MINUTE),
      finalizers: ['databases.example.com/backup'],
    },
  )
  database('staging', 3 * DAY, {}, { phase: 'Provisioning' })
  database(
    'metrics',
    20 * DAY,
    {},
    {
      health: { status: 'Degraded', message: '1 of 3 replicas lagging' },
    },
  )
  database('sandbox', 5 * DAY, { paused: true }, {})
  database(
    'warehouse',
    6 * HOUR,
    {},
    {
      conditions: [c('Ready', 'Unknown', '', 'Waiting for the first health check')],
    },
  )
  database('scratch', HOUR, { engine: undefined, storageGB: undefined, cpu: undefined }, {})
  database('frozen', 50 * DAY, {}, { conditions: [c('Stalled', 'True')] })
  database('broken', 4 * DAY, {}, { conditions: [c('Ready', 'False')] })
  database('odd', 7 * DAY, {}, { phase: 'Gibberish' })
}

/** A CRD of one's own: no columns, no status, two versions, and a schema to validate. */
export function widgets(b: Builder): void {
  crd(b, 20 * DAY, {
    group: 'example.com',
    kind: 'Widget',
    plural: 'widgets',
    versions: ['v1', 'v1beta1'],
    spec: {
      type: 'object',
      required: ['size'],
      properties: {
        size: {
          type: 'integer',
          minimum: 1,
          description: 'How big the widget is, in widget units.',
        },
        color: {
          type: 'string',
          enum: ['red', 'green', 'blue'],
          description: 'What the widget looks like.',
        },
        aliases: { type: 'array', items: { type: 'string' } },
        parts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              count: { type: 'integer' },
              spare: { type: 'boolean' },
            },
          },
        },
      },
    },
  })
  b.simple(
    'example.com/v1',
    'Widget',
    CUSTOM.widget,
    'default',
    19 * DAY,
    {
      spec: {
        size: 3,
        color: 'blue',
        aliases: ['bw', 'blu'],
        parts: [
          { name: 'bolt', count: 4, spare: false },
          { name: 'gear', count: 2, spare: true },
        ],
      },
    },
    { labels: { 'app.kubernetes.io/name': 'widgets', tier: 'toys' } },
  )
}

/** Many CRDs and few objects, like a cluster with Crossplane providers installed. */
export function manyCustomResources(b: Builder): void {
  const services = [
    'ec2',
    'rds',
    's3',
    'iam',
    'eks',
    'elasticache',
    'sqs',
    'sns',
    'route53',
    'lambda',
  ]
  for (const service of services) {
    for (let i = 0; i < 40; i++) {
      crd(b, 30 * DAY, {
        group: `${service}.aws.upbound.io`,
        kind: `Resource${String(i).padStart(2, '0')}`,
        plural: `resource${String(i).padStart(2, '0')}s`,
        scope: 'Cluster',
        versions: ['v1beta1'],
        columns: [...READY(), AGE],
      })
    }
  }
}

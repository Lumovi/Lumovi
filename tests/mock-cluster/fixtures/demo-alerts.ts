/**
 * The demo cluster's Prometheus alerting rules, as `/api/v1/rules?type=alert` answers them: a
 * monitoring stack's usual rules on a cluster with an incident in shop. Seven alerts are active
 * (five firing, two pending, Watchdog's "none" among them), and the rest of the rules are quiet.
 */
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const RUNBOOKS = 'https://runbooks.prometheus-operator.dev/runbooks'

interface Active {
  labels: Record<string, string>
  annotations: Record<string, string>
  state: 'firing' | 'pending'
  /** How long ago its condition began to hold. */
  ago: number
  value: string
}

interface Rule {
  name: string
  severity: string
  /** How long its condition must hold before it fires, in seconds. */
  for: number
  summary: string
  runbook?: string
  alerts?: Active[]
}

/** Names the demo's incident is about: its pods, deployment and claim. */
export interface DemoAlertNames {
  crashing: [string, string]
  healthy: string
  waiting: string
}

const rule = (group: string, r: Rule, now: number) => ({
  state: r.alerts?.some((a) => a.state === 'firing')
    ? 'firing'
    : r.alerts?.length
      ? 'pending'
      : 'inactive',
  name: r.name,
  query: `${r.name.toLowerCase()} > 0`,
  duration: r.for,
  keepFiringFor: 0,
  labels: { severity: r.severity },
  annotations: {
    summary: r.summary,
    ...(r.runbook ? { runbook_url: `${RUNBOOKS}/${r.runbook}` } : {}),
  },
  alerts: (r.alerts ?? []).map((a) => ({
    labels: { alertname: r.name, severity: r.severity, ...a.labels },
    annotations: {
      summary: r.summary,
      ...(r.runbook ? { runbook_url: `${RUNBOOKS}/${r.runbook}` } : {}),
      ...a.annotations,
    },
    state: a.state,
    activeAt: new Date(now - a.ago).toISOString(),
    value: a.value,
  })),
  health: 'ok',
  type: 'alerting',
  group,
})

export function demoAlertRules(now: number, names: DemoAlertNames): unknown[] {
  const crash = (pod: string, ago: number): Active => ({
    labels: { namespace: 'shop', pod, container: 'app', job: 'kube-state-metrics' },
    annotations: {
      description: `Pod shop/${pod} (app) is in waiting state (reason: "CrashLoopBackOff").`,
    },
    state: 'firing',
    ago,
    value: '1e+00',
  })
  const quiet = (name: string, severity: string, summary: string): Rule => ({
    name,
    severity,
    for: 15 * 60,
    summary,
  })
  const groups: [string, Rule[]][] = [
    [
      'kubernetes-apps',
      [
        {
          name: 'KubePodCrashLooping',
          severity: 'warning',
          for: 15 * 60,
          summary: 'Pod is crash looping.',
          runbook: 'kubernetes/kubepodcrashlooping',
          alerts: [crash(names.crashing[0], 26 * MINUTE), crash(names.crashing[1], 25 * MINUTE)],
        },
        {
          name: 'KubeDeploymentReplicasMismatch',
          severity: 'warning',
          for: 15 * 60,
          summary: 'Deployment has not matched the expected number of replicas.',
          runbook: 'kubernetes/kubedeploymentreplicasmismatch',
          alerts: [
            {
              labels: { namespace: 'shop', deployment: 'checkout', job: 'kube-state-metrics' },
              annotations: {
                description:
                  'Deployment shop/checkout has not matched the expected number of replicas for longer than 15 minutes.',
              },
              state: 'pending',
              ago: 4 * MINUTE,
              value: '1e+00',
            },
          ],
        },
        {
          name: 'KubeContainerWaiting',
          severity: 'warning',
          for: 60 * 60,
          summary: 'Pod container waiting longer than 1 hour.',
          runbook: 'kubernetes/kubecontainerwaiting',
          alerts: [
            {
              labels: { namespace: 'shop', pod: names.waiting, container: 'app' },
              annotations: {
                description: `pod/${names.waiting} in namespace shop on container app has been in waiting state for longer than 1 hour.`,
              },
              state: 'pending',
              ago: 18 * MINUTE,
              value: '1e+00',
            },
          ],
        },
        quiet(
          'KubeStatefulSetReplicasMismatch',
          'warning',
          'StatefulSet has not matched the expected number of replicas.',
        ),
        quiet('KubeDaemonSetRolloutStuck', 'warning', 'DaemonSet rollout is stuck.'),
        quiet('KubeJobFailed', 'warning', 'Job failed to complete.'),
        quiet('KubeJobNotCompleted', 'warning', 'Job did not complete in time.'),
        quiet(
          'KubeHpaReplicasMismatch',
          'warning',
          'HPA has not matched desired number of replicas.',
        ),
        quiet(
          'KubeStatefulSetUpdateNotRolledOut',
          'warning',
          'StatefulSet update has not been rolled out.',
        ),
        quiet('KubeDaemonSetNotScheduled', 'warning', 'DaemonSet pods are not scheduled.'),
      ],
    ],
    [
      'kubernetes-resources',
      [
        {
          name: 'CPUThrottlingHigh',
          severity: 'info',
          for: 15 * 60,
          summary: 'Processes experience elevated CPU throttling.',
          runbook: 'kubernetes/cputhrottlinghigh',
          alerts: [
            {
              labels: { namespace: 'shop', pod: names.healthy, container: 'app' },
              annotations: {
                description: `31.4% throttling of CPU in namespace shop for container app in pod ${names.healthy}.`,
              },
              state: 'firing',
              ago: 3 * HOUR,
              value: '3.14e-01',
            },
          ],
        },
        quiet('KubeCPUOvercommit', 'warning', 'Cluster has overcommitted CPU resource requests.'),
        quiet(
          'KubeMemoryOvercommit',
          'warning',
          'Cluster has overcommitted memory resource requests.',
        ),
        quiet('KubeQuotaExceeded', 'warning', 'Namespace quota has exceeded the limits.'),
      ],
    ],
    [
      'kubernetes-storage',
      [
        {
          name: 'KubePersistentVolumeFillingUp',
          severity: 'critical',
          for: 60,
          summary: 'PersistentVolume is filling up.',
          runbook: 'kubernetes/kubepersistentvolumefillingup',
          alerts: [
            {
              labels: { namespace: 'data', persistentvolumeclaim: 'data-redis-0' },
              annotations: {
                description:
                  'The PersistentVolume claimed by data-redis-0 in Namespace data is only 2.1% free.',
              },
              state: 'firing',
              ago: 2 * HOUR,
              value: '2.1e-02',
            },
          ],
        },
        quiet(
          'KubePersistentVolumeErrors',
          'critical',
          'PersistentVolume is having issues with provisioning.',
        ),
      ],
    ],
    [
      'kubernetes-system',
      [
        quiet('KubeNodeNotReady', 'warning', 'Node is not ready.'),
        quiet('KubeNodeUnreachable', 'warning', 'Node is unreachable.'),
        quiet('KubeletDown', 'critical', 'Target disappeared from Prometheus target discovery.'),
        quiet(
          'KubeVersionMismatch',
          'warning',
          'Different semantic versions of Kubernetes components running.',
        ),
        quiet(
          'KubeClientErrors',
          'warning',
          'Kubernetes API server client is experiencing errors.',
        ),
        quiet(
          'KubeAPIErrorBudgetBurn',
          'critical',
          'The API server is burning too much error budget.',
        ),
      ],
    ],
    [
      'node-exporter',
      [
        quiet(
          'NodeFilesystemAlmostOutOfSpace',
          'warning',
          'Filesystem has less than 5% space left.',
        ),
        quiet(
          'NodeNetworkReceiveErrs',
          'warning',
          'Network interface is reporting many receive errors.',
        ),
        quiet('NodeClockNotSynchronising', 'warning', 'Clock not synchronising.'),
        quiet('NodeMemoryHighUtilization', 'warning', 'Host is running out of memory.'),
      ],
    ],
    [
      'prometheus',
      [
        quiet('PrometheusBadConfig', 'critical', 'Failed Prometheus configuration reload.'),
        quiet('PrometheusRuleFailures', 'critical', 'Prometheus is failing rule evaluations.'),
        quiet('TargetDown', 'warning', 'One or more targets are unreachable.'),
      ],
    ],
    [
      'general.rules',
      [
        {
          name: 'Watchdog',
          severity: 'none',
          for: 0,
          summary:
            'An alert that should always be firing to certify that Alertmanager is working properly.',
          runbook: 'general/watchdog',
          alerts: [
            {
              labels: {},
              annotations: {
                description:
                  'This is an alert meant to ensure that the entire alerting pipeline is functional.',
              },
              state: 'firing',
              ago: 9 * DAY,
              value: '1e+00',
            },
          ],
        },
        quiet('InfoInhibitor', 'none', 'Info-level alert inhibition.'),
      ],
    ],
  ]
  return groups.map(([name, rules]) => ({
    name,
    file: `/etc/prometheus/rules/prometheus-k8s-rulefiles-0/monitoring-kube-prometheus-${name}.yaml`,
    rules: rules.map((r) => rule(name, r, now)),
    interval: 30,
    limit: 0,
    evaluationTime: 0.002,
    lastEvaluation: new Date(now - 12_000).toISOString(),
  }))
}

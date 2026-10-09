/**
 * The metrics stack Lumovi installs where a cluster has no usage history: which chart (the one
 * it ships, src/backend/helm/metrics-stack), where it goes, and how the namespace says it's
 * Lumovi's.
 */
export const METRICS_STACK = {
  namespace: 'lumovi-metrics',
  release: 'lumovi-metrics',
  chart: {
    name: 'prometheus',
    version: '29.36.1',
    appVersion: 'v3.15.0',
    /** The packaged chart's, as its repository's index gives it. */
    sha256: '8492d3a0e99f99a12bb389f1c83f3636e3fc5d68f995a09e815044773246217e',
    repository: 'https://prometheus-community.github.io/helm-charts',
  },
  /** On the namespace Lumovi makes for it: only one that carries it is ever removed. */
  label: { key: 'app.kubernetes.io/managed-by', value: 'lumovi' },
  /** Past either, the offer warns: it's sized for small clusters. */
  large: { nodes: 100, pods: 3000 },
} as const

/** The helm command that installs the same: the chart from its repository, at its version. */
export const metricsStackChartArgs = [
  METRICS_STACK.chart.name,
  '--repo',
  METRICS_STACK.chart.repository,
  '--version',
  METRICS_STACK.chart.version,
  '--values',
  'values.yaml',
  '--create-namespace',
]

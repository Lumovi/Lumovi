/**
 * A fleet of the mock clusters, as a hub's kubeconfig describes it: names,
 * labels and settings like a real one's, for the tests, the screenshots and
 * `npm run dev:server -- --fleet`.
 */
import type { TestClusters } from './kubeconfig.ts'

/** The fleet's clusters, by what they stand for. */
export const FLEET = {
  /** The demo cluster: busy, with every kind of problem. */
  prodEu: 'prod-eu',
  /** The large cluster: thousands of pods, and nothing wrong. */
  prodUs: 'prod-us',
  /** The sandbox, over plain HTTP, without metrics. */
  staging: 'staging',
  /** Nothing listens there. */
  edge: 'edge-ap',
} as const

/** Lumovi's settings for a context, as its `lumovi.dev` extension. */
export interface FleetSettings {
  labels?: Record<string, string>
  groups?: string[]
  forwardToken?: boolean
  usernamePrefix?: string
  groupsPrefix?: string
}

const DEFAULTS: Record<string, FleetSettings> = {
  [FLEET.prodEu]: { labels: { env: 'production', region: 'eu-west' } },
  [FLEET.prodUs]: { labels: { env: 'production', region: 'us-east' } },
  [FLEET.staging]: { labels: { env: 'staging', region: 'eu-west' } },
  [FLEET.edge]: { labels: { env: 'production', region: 'ap-south' } },
}

/**
 * The fleet's kubeconfig: each mock cluster as a context, with the hub's
 * credentials there (the demo cluster's administrator token, which may
 * impersonate), and `settings` replacing a context's defaults.
 */
export function fleetKubeconfig(
  clusters: TestClusters,
  settings: Record<string, FleetSettings | undefined> = {},
): string {
  const servers: Record<string, { server: string; ca?: string; insecure?: boolean }> = {
    [FLEET.prodEu]: { server: clusters.demo.url, ca: clusters.demo.caPem },
    [FLEET.prodUs]: { server: clusters.large.url, insecure: true },
    [FLEET.staging]: { server: clusters.sandbox.url, insecure: true },
    [FLEET.edge]: { server: clusters.offlineUrl, insecure: true },
  }
  const names = Object.values(FLEET)
  return JSON.stringify({
    apiVersion: 'v1',
    kind: 'Config',
    clusters: names.map((name) => ({
      name,
      cluster: {
        server: servers[name]!.server,
        ...(servers[name]!.ca
          ? { 'certificate-authority-data': Buffer.from(servers[name]!.ca!).toString('base64') }
          : { 'insecure-skip-tls-verify': true }),
      },
    })),
    users: [
      // The demo cluster's administrator, who may impersonate; the others take any token.
      { name: 'hub', user: { token: 'lumovi-demo-token' } },
    ],
    contexts: names.map((name) => ({
      name,
      context: {
        cluster: name,
        user: 'hub',
        extensions: [{ name: 'lumovi.dev', extension: { ...DEFAULTS[name], ...settings[name] } }],
      },
    })),
  })
}

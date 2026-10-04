/** Helpers for the fleet's tests: a fleet of the mock clusters, and its page. */
import type { BrowserContext, Locator, Page } from '@playwright/test'
import { fleetKubeconfig, type FleetSettings } from '../mock-cluster/fleet.ts'
import type { TestClusters } from '../mock-cluster/kubeconfig.ts'

/** A fleet of the mock clusters behind a proxy; its kubeconfig base64-encoded, as Sevalla takes it. */
export function fleetEnv(
  clusters: TestClusters,
  settings: Record<string, FleetSettings | undefined> = {},
): Record<string, string> {
  return {
    LUMOVI_AUTH: 'proxy',
    LUMOVI_FLEET_KUBECONFIG: Buffer.from(fleetKubeconfig(clusters, settings)).toString('base64'),
  }
}

/** Signed in through the proxy as `user`, in `groups`. */
export async function as(context: BrowserContext, user: string, groups = ''): Promise<void> {
  await context.setExtraHTTPHeaders({ 'X-Forwarded-User': user, 'X-Forwarded-Groups': groups })
}

/** A cluster's card on the fleet's page, by its name. */
export const card = (page: Page, name: string): Locator =>
  page.getByRole('link', { name: new RegExp(`^${name}, `) })

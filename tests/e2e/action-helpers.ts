/** Helpers for tests of actions: opening objects, picking actions, reading writes. */
import type { Page } from '@playwright/test'
import type { MockCluster } from '../mock-cluster/server.ts'
import { goTo, panel, row } from './fixtures.ts'

/** Opens an object in the detail panel from its list. */
export async function open(page: Page, label: string, name: string) {
  await goTo(page, label)
  await page.getByPlaceholder(`Filter ${label.toLowerCase()}`).fill(name)
  await row(page, label, name).first().getByRole('gridcell').first().click()
}

/** Picks an action from the open panel's "More actions" menu. */
export async function menuAction(page: Page, kind: string, name: string, action: string) {
  await panel(page, kind, name).getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: action, exact: true }).click()
}

export const dialog = (page: Page) => page.getByRole('dialog')
export const toasts = (page: Page) => page.getByRole('region', { name: 'Notifications' })

/** Bodies of the writes the cluster received for `path`. */
export function writes(cluster: MockCluster, method: string, path: string | RegExp) {
  return cluster.requests
    .filter(
      (r) =>
        r.method === method && (typeof path === 'string' ? r.path === path : path.test(r.path)),
    )
    .map((r) => ({ body: r.body, query: r.query, type: r.headers['content-type'] }))
}

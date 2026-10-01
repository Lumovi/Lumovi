/**
 * Fixtures for the integration tests: the app against the kind cluster from
 * cluster.ts, and kubectl to set things up and check what the app changed.
 * Only that cluster's kubeconfig is ever used.
 */
import { execFileSync } from 'node:child_process'
import { test as base, expect, type Page } from '@playwright/test'
import { launchApp, openCluster, type KubeStacks, type LaunchOptions } from '../e2e/fixtures.ts'
import { CONTEXT, KUBECONFIG } from './cluster.ts'

export { CONTEXT, expect, KUBECONFIG }

/** kubectl against the test cluster; `input` is passed on stdin. */
export function kubectl(args: string[], input?: string): string {
  return execFileSync('kubectl', ['--kubeconfig', KUBECONFIG, '--context', CONTEXT, ...args], {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

/** An object (or list) as JSON, the way the API server has it now. */
// Kubernetes JSON is free-form; typing every field would add nothing here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const get = (...args: string[]): any => JSON.parse(kubectl(['get', ...args, '-o', 'json']))

/**
 * Starts a namespace from scratch with `objects` in it, and waits for its
 * workloads to roll out (except those in `skip`, like ones that never get ready).
 */
export function freshNamespace(namespace: string, objects: object[], skip: string[] = []) {
  kubectl(['delete', 'namespace', namespace, '--ignore-not-found', '--wait', '--timeout=180s'])
  kubectl(['create', 'namespace', namespace])
  kubectl(
    ['apply', '--namespace', namespace, '-f', '-'],
    JSON.stringify({ apiVersion: 'v1', kind: 'List', items: objects }),
  )
  for (const kind of ['deployment', 'statefulset', 'daemonset']) {
    const names = kubectl(['get', kind, '-n', namespace, '-o', 'name']).split('\n')
    for (const name of names.filter((n) => n && !skip.includes(n))) {
      kubectl(['rollout', 'status', name, '-n', namespace, '--timeout=180s'])
    }
  }
}

interface Fixtures {
  launch: (options?: LaunchOptions & { kubeconfig?: string }) => Promise<KubeStacks>
  /** The app, opened on the kind cluster. */
  page: Page
}

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  launch: async ({}, use) => {
    const launched: KubeStacks[] = []
    await use(async (options = {}) => {
      const instance = await launchApp(options.kubeconfig ?? KUBECONFIG, options)
      launched.push(instance)
      return instance
    })
    for (const instance of launched) await instance.close()
  },
  page: async ({ launch }, use) => {
    const { page } = await launch()
    await openCluster(page, CONTEXT)
    await use(page)
  },
})

/** Picks a namespace in the header, as a user narrowing down to their app would. */
export async function inNamespace(page: Page, namespace: string) {
  await page.getByRole('button', { name: 'Namespace' }).click()
  await page.getByRole('option', { name: namespace, exact: true }).click()
  await expect(page.getByRole('button', { name: 'Namespace' })).toHaveText(namespace)
}

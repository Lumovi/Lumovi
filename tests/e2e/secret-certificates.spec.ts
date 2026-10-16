/**
 * What a Secret's certificates say (LMV-194): in its panel, a card a key; in the Secrets list,
 * when each ends, flagged within 14 days, once it has, or while it isn't valid yet. Never the key;
 * and the Overview reads no Secret for it.
 */
import type { ElectronApplication } from '@playwright/test'
import { generate } from 'selfsigned'
import type { KubeObject } from '../mock-cluster/types.ts'
import { holds } from '../holds.ts'
import { expect, goTo, openCluster, panel, row, test } from './fixtures.ts'

const DAY = 24 * 60 * 60 * 1000
const base64 = (text: string) => Buffer.from(text).toString('base64')

/** A TLS Secret in shop whose certificate is valid from `from` until `until`, days from now. */
async function tlsSecret(name: string, from: number, until: number): Promise<KubeObject> {
  const pems = await generate([{ name: 'commonName', value: `${name}.example` }], {
    algorithm: 'sha256',
    notBeforeDate: new Date(Date.now() + from * DAY),
    notAfterDate: new Date(Date.now() + until * DAY),
  })
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name,
      namespace: 'shop',
      uid: `${name}-uid`,
      creationTimestamp: new Date().toISOString(),
    },
    type: 'kubernetes.io/tls',
    data: { 'tls.crt': base64(pems.cert), 'tls.key': base64(pems.private) },
  } as unknown as KubeObject
}

test('a TLS Secret’s certificate in its panel: who it’s for, its names, its issuer, when it’s valid, its chain; never its key', async ({
  page,
}) => {
  await openCluster(page)
  await goTo(page, 'Secrets')
  await row(page, 'Secrets', 'storefront-tls').click()
  const detail = panel(page, 'Secret', 'storefront-tls')
  const card = detail.getByRole('article', { name: 'Certificate tls.crt' })
  await expect(card).toBeVisible()
  await expect(detail.getByRole('heading', { name: 'Certificate', exact: true })).toBeVisible()
  await expect(card).toContainText('Subjectshop.example.comO=Shop')
  await expect(card).toContainText('Namesshop.example.com, www.shop.example.com')
  await expect(card).toContainText('IssuerLumovi Demo CA · Lumovi Demo')
  await expect(card).toContainText(/Valid.+ – .+\(in \d+y\d+d\)/)
  await expect(card).toContainText('Chain1 more certificate')
  // Valid for years: nothing flagged.
  await expect(card.locator('[data-health]')).toHaveCount(0)
  // Its key has no card; its data is as it was, its values hidden.
  await expect(detail.getByRole('article', { name: /^Certificate tls\.key/ })).toHaveCount(0)
  await expect(detail.getByRole('heading', { name: 'Data' })).toBeVisible()
})

test('the Secrets list says when each certificate ends and flags those that need looking at; a flagged one’s panel says so at its top', async ({
  launch,
  clusters,
}) => {
  const soon = await tlsSecret('soon-tls', -1, 9)
  const gone = await tlsSecret('gone-tls', -30, -3)
  const early = await tlsSecret('early-tls', 10, 100)
  for (const secret of [soon, gone, early]) clusters.demo.upsert(secret)
  try {
    const { page } = await launch()
    await openCluster(page)
    // The Overview reads no Secret, and says nothing of certificates.
    await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible()
    await expect(page.getByText(/^Certificate (expires|expired|not valid)/)).toHaveCount(0)
    expect(clusters.demo.requests.some((r) => r.path.endsWith('/secrets'))).toBe(false)

    await goTo(page, 'Secrets')
    const cell = (name: string) =>
      row(page, 'Secrets', name)
        .locator('[role="gridcell"]')
        .filter({ hasText: /^(in |Not yet|.+ ago|—)/ })
    await expect(cell('soon-tls')).toHaveText('in 8d')
    await expect(cell('gone-tls')).toHaveText('3d ago')
    await expect(cell('early-tls')).toHaveText('Not yet valid')
    await expect(cell('storefront-tls')).toHaveText(/^in \d+y\d+d$/)
    await expect(cell('registry-pull')).toHaveText('—')
    // Two chips: not valid (expired, or not yet), and expiring soon; each filters to its own.
    const chips = page.getByRole('button', { name: /^(Expires soon|Not valid) \d+$/ })
    await expect(chips).toHaveText(['Not valid2', 'Expires soon1'])
    await page.getByRole('button', { name: /^Not valid \d+$/ }).click()
    await expect(page.getByRole('row').filter({ hasText: '-tls' })).toHaveCount(2)
    await expect(row(page, 'Secrets', 'gone-tls')).toBeVisible()
    await expect(row(page, 'Secrets', 'early-tls')).toBeVisible()

    // Opened, a flagged one says so at its top, in its card's words; one that's fine doesn't.
    await row(page, 'Secrets', 'gone-tls').click()
    const detail = panel(page, 'Secret', 'gone-tls')
    await expect(detail.getByRole('article', { name: 'Certificate tls.crt' })).toContainText(
      'Expired',
    )
    await expect(detail.locator('header [data-health]').first()).toHaveText('Expired')
    await page.getByRole('button', { name: /^Not valid \d+$/ }).click()
    await row(page, 'Secrets', 'storefront-tls').click()
    const fine = panel(page, 'Secret', 'storefront-tls')
    await expect(fine.getByRole('article', { name: 'Certificate tls.crt' })).toBeVisible()
    await expect(fine.locator('header [data-health]')).toHaveCount(0)
  } finally {
    for (const secret of [soon, gone, early])
      clusters.demo.remove('Secret', 'shop', secret.metadata.name)
  }
})

/**
 * How the app's reads of what certificates say are answered from here on: failed as one the
 * cluster doesn't answer, refused, or passed to the backend; and how many there have been.
 */
async function certificateReads(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    type Handler = (...args: unknown[]) => unknown
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })
      ._invokeHandlers
    const original = handlers.get('kube:certificates')!
    const state = globalThis as unknown as { certificateReads: { as: string; count: number } }
    state.certificateReads = { as: 'fail', count: 0 }
    handlers.set('kube:certificates', async (...args: unknown[]) => {
      const reads = state.certificateReads
      reads.count++
      if (reads.as === 'fail') {
        return { ok: false, error: { code: 'unreachable', message: 'The cluster didn’t answer.' } }
      }
      if (reads.as === 'refuse') {
        return { ok: false, error: { code: 'forbidden', message: 'You may not.' } }
      }
      return original(...args)
    })
  })
  return {
    as: (as: 'fail' | 'refuse' | 'pass') =>
      app.evaluate((_, as) => {
        ;(globalThis as unknown as { certificateReads: { as: string } }).certificateReads.as = as
      }, as),
    count: () =>
      app.evaluate(
        () =>
          (globalThis as unknown as { certificateReads: { count: number } }).certificateReads.count,
      ),
  }
}

test('a read of a Secret’s certificates the cluster doesn’t answer is asked again, and the panel says so meanwhile; one with none expected says nothing', async ({
  launch,
}) => {
  const { page, app } = await launch()
  const reads = await certificateReads(app)
  await openCluster(page)
  await goTo(page, 'Secrets')
  // One with no certificate in it: no heading for what can't be read.
  await row(page, 'Secrets', 'registry-pull').click()
  const pull = panel(page, 'Secret', 'registry-pull')
  await expect(pull.getByRole('heading', { name: 'Data' })).toBeVisible()
  await expect(pull.getByRole('heading', { name: /^Certificates?$/ })).toHaveCount(0)
  // A TLS Secret: said, quietly, while it can't be read; no pill meanwhile.
  await row(page, 'Secrets', 'storefront-tls').click()
  const detail = panel(page, 'Secret', 'storefront-tls')
  await expect(detail.getByRole('status')).toHaveText(
    'Lumovi couldn’t read the certificate just now. It’s trying again.',
  )
  await expect(detail.getByRole('heading', { name: 'Certificate', exact: true })).toBeVisible()
  await expect(detail.locator('header [data-health]')).toHaveCount(0)
  // Once it answers: read, as if nothing had happened.
  await reads.as('pass')
  await expect(detail.getByRole('article', { name: 'Certificate tls.crt' })).toContainText(
    'Subjectshop.example.com',
    { timeout: 15_000 },
  )
  await expect(detail.getByText('Lumovi couldn’t read the certificate just now.')).toHaveCount(0)
  // Read, nothing more is asked.
  const asked = await reads.count()
  await holds(async () => (await reads.count()) === asked, 6_000, 'nothing more is asked once read')
})

test('a refused read of a Secret’s certificates is an answer: nothing more is asked, and nothing’s said', async ({
  launch,
}) => {
  const { page, app } = await launch()
  const reads = await certificateReads(app)
  await reads.as('refuse')
  await openCluster(page)
  await goTo(page, 'Secrets')
  await row(page, 'Secrets', 'storefront-tls').click()
  const detail = panel(page, 'Secret', 'storefront-tls')
  await expect(detail.getByRole('heading', { name: 'Data' })).toBeVisible()
  await expect.poll(reads.count).toBe(1)
  await holds(async () => (await reads.count()) === 1, 6_000, 'a refusal is asked once')
  await expect(detail.getByRole('heading', { name: /^Certificates?$/ })).toHaveCount(0)
})

test('asking again ends with the panel, and after a while: then the panel says so, and asks again when told', async ({
  launch,
}) => {
  const { page, app } = await launch()
  const reads = await certificateReads(app)
  await openCluster(page)
  await goTo(page, 'Secrets')
  // Closed while it's asking: nothing more is asked.
  await row(page, 'Secrets', 'storefront-tls').click()
  const detail = panel(page, 'Secret', 'storefront-tls')
  await expect(detail.getByRole('status')).toContainText('It’s trying again.')
  await detail.getByRole('button', { name: 'Close (Esc)' }).click()
  await expect(detail).toHaveCount(0)
  const closed = await reads.count()
  await holds(async () => (await reads.count()) === closed, 7_000, 'nothing is asked once closed')
  // (The tests' build stops after two reads, where a person's asks for about two minutes.)
  await page.evaluate(() => {
    ;(globalThis as unknown as { __lumoviCertificatePolls: number }).__lumoviCertificatePolls = 2
  })
  await row(page, 'Secrets', 'storefront-tls').click()
  await expect(detail.getByRole('status')).toContainText('Lumovi couldn’t read the certificate.', {
    timeout: 20_000,
  })
  await expect(detail.getByRole('status')).not.toContainText('trying again')
  const stopped = await reads.count()
  await holds(async () => (await reads.count()) === stopped, 7_000, 'nothing is asked once stopped')
  // Told to try again, it asks once: failed, it says so as before, not that it's trying again.
  await detail.getByRole('button', { name: 'Try again' }).click()
  await expect.poll(reads.count).toBe(stopped + 1)
  await expect(detail.getByRole('button', { name: 'Try again' })).toBeVisible()
  await expect(detail.getByRole('status')).not.toContainText('trying again')
  await holds(async () => (await reads.count()) === stopped + 1, 6_000, 'Try again asks once')
  // Told again, once it's answered: read.
  await reads.as('pass')
  await detail.getByRole('button', { name: 'Try again' }).click()
  await expect(detail.getByRole('article', { name: 'Certificate tls.crt' })).toBeVisible()
})

test('at 1024 the Secrets list has its Expires column whole, and nothing scrolls sideways', async ({
  launch,
}) => {
  const { page } = await launch({ env: { LUMOVI_E2E_WINDOW: '1024x768' }, fullLayout: false })
  await openCluster(page)
  await goTo(page, 'Secrets')
  const grid = page.getByRole('grid').first()
  await expect(grid.getByRole('columnheader', { name: /^Expires/ })).toBeVisible()
  await expect(
    row(page, 'Secrets', 'storefront-tls')
      .locator('[role="gridcell"]')
      .filter({ hasText: /^in \d+y\d+d$/ }),
  ).toBeVisible()
  await expect.poll(() => grid.evaluate((at) => at.scrollWidth > at.clientWidth)).toBe(false)
})

test('a bundle of roots is only counted, and a certificate that can’t be read says only that; neither is flagged', async ({
  launch,
  clusters,
}) => {
  const roots = await Promise.all(
    ['One', 'Two'].map((name) =>
      generate([{ name: 'commonName', value: `Root ${name}` }], {
        algorithm: 'sha256',
        notAfterDate: new Date(Date.now() + 2 * DAY),
        extensions: [{ name: 'basicConstraints', cA: true }],
      }),
    ),
  )
  const odd = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'odd-tls', namespace: 'shop', uid: 'odd-tls-uid' },
    type: 'kubernetes.io/tls',
    data: {
      'ca.crt': base64(roots.map((each) => each.cert).join('')),
      // (A TLS Secret's certificate that isn't PEM: not read, and said so.)
      'tls.crt': base64('not a certificate'),
      'tls.key': base64('not a key'),
    },
  } as unknown as KubeObject
  clusters.demo.upsert(odd)
  try {
    const { page } = await launch()
    await openCluster(page)
    await goTo(page, 'Secrets')
    await row(page, 'Secrets', 'odd-tls').click()
    const detail = panel(page, 'Secret', 'odd-tls')
    await expect(detail.getByRole('heading', { name: 'Certificates', exact: true })).toBeVisible()
    await expect(detail.getByRole('article', { name: 'Certificate ca.crt' })).toContainText(
      'Bundle2 certificates',
    )
    await expect(detail.getByRole('article', { name: 'Certificate tls.crt' })).toContainText(
      'This isn’t a certificate Lumovi can read.',
    )
    await expect(detail.locator('[data-health]')).toHaveCount(0)
    await expect(
      row(page, 'Secrets', 'odd-tls').locator('[role="gridcell"]').filter({ hasText: /^—$/ }),
    ).toHaveCount(1)
  } finally {
    clusters.demo.remove('Secret', 'shop', 'odd-tls')
  }
})

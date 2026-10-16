/**
 * What a Secret's certificates say, on a server (LMV-194): read by the backend only where the
 * person may see the Secret's values, nothing of a value or a key crossing to the page, and each
 * read in the history.
 */
import type { Page } from '@playwright/test'
import { generate } from 'selfsigned'
import type { CertificateSummary, KubeList } from '../../src/shared/api.ts'
import type { KubeObject } from '../mock-cluster/types.ts'
import { as } from './fleet.ts'
import { audited, expect, test } from './fixtures.ts'

/** Developers see Secrets' values in batch, only their keys in shop, and no Secrets in data. */
const POLICY = `
everyone: { changes: read, shells: false, nodeShells: false, logs: true, secrets: keys, helm: off, assistants: ask, audit: own }
groups:
  - { id: dev, name: Developers, provider: [developers] }
profiles:
  - id: developer
    name: Developer
    values: { changes: write, shells: on, nodeShells: off, logs: on, secrets: values, helm: upgrade, assistants: self, audit: own }
grants:
  - { id: shop, name: Developers run the shop, who: [dev], profile: developer, namespaces: [shop, data, batch] }
limits:
  - { id: data, name: Data stays put, namespaces: [data], caps: { secrets: hidden } }
  - { id: shop, name: Card data, namespaces: [shop], caps: { secrets: keys } }
`

const base64 = (text: string) => Buffer.from(text).toString('base64')

type Answer<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } }

const kube = <T>(page: Page, call: 'list' | 'certificates', query: object) =>
  page.evaluate(
    ([call, query]) =>
      (window as unknown as { lumovi: { kube: Record<string, (q: object) => Promise<unknown>> } })
        .lumovi.kube[call]!(query),
    [call, query] as const,
  ) as Promise<Answer<T>>

test('a Secret’s certificates are read where its values may be seen, and nowhere else; nothing of a value crosses', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const pems = await generate([{ name: 'commonName', value: 'site.example' }], {
    algorithm: 'sha256',
    notAfterDate: new Date(Date.now() + 9 * 24 * 60 * 60 * 1000),
  })
  const secret = (namespace: string) =>
    ({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: 'site-tls',
        namespace,
        uid: `site-tls-${namespace}`,
        creationTimestamp: new Date().toISOString(),
      },
      type: 'kubernetes.io/tls',
      data: { 'tls.crt': base64(pems.cert), 'tls.key': base64(pems.private) },
    }) as unknown as KubeObject
  for (const namespace of ['batch', 'shop', 'data']) clusters.demo.upsert(secret(namespace))
  try {
    const served = await serve({ env: { LUMOVI_AUTH: 'proxy', LUMOVI_ACCESS: POLICY } })
    await as(context, 'dave@example.com', 'developers')
    // Everything the server sends the page from here on is kept, to be searched.
    const crossed: string[] = []
    page.on('websocket', (socket) =>
      socket.on('framereceived', (frame) => crossed.push(frame.payload.toString())),
    )
    page.on(
      'response',
      (response) =>
        void response.text().then(
          (text) => crossed.push(text),
          () => {},
        ),
    )
    await page.goto(`${served.url}cluster/demo`)
    await expect(page.getByRole('navigation', { name: 'Resources' })).toBeVisible()

    // Where its values may be seen: its list says what its certificate says, and so does a read.
    const listed = await kube<KubeList>(page, 'list', {
      context: 'demo',
      kind: 'Secret',
      namespace: 'batch',
    })
    expect(listed.ok && listed.data.certificates?.['batch/site-tls']).toEqual([
      expect.objectContaining({
        key: 'tls.crt',
        as: 'certificate',
        subject: { commonName: 'site.example' },
      }),
    ])
    const one = await kube<CertificateSummary[]>(page, 'certificates', {
      context: 'demo',
      namespace: 'batch',
      name: 'site-tls',
    })
    expect(one.ok && one.data.map((each) => each.key)).toEqual(['tls.crt'])
    // Where only its keys may be: none, from the list or a read.
    const keysOnly = await kube<KubeList>(page, 'list', {
      context: 'demo',
      kind: 'Secret',
      namespace: 'shop',
    })
    expect(
      keysOnly.ok && keysOnly.data.items.some((item) => item.metadata.name === 'site-tls'),
    ).toBe(true)
    expect(keysOnly.ok && keysOnly.data.certificates).toBeUndefined()
    expect(
      await kube(page, 'certificates', { context: 'demo', namespace: 'shop', name: 'site-tls' }),
    ).toEqual({ ok: true, data: [] })
    // Where Secrets are hidden: refused.
    const hidden = await kube(page, 'certificates', {
      context: 'demo',
      namespace: 'data',
      name: 'site-tls',
    })
    expect(hidden.ok).toBe(false)
    // Every namespace at once: only batch's.
    const all = await kube<KubeList>(page, 'list', { context: 'demo', kind: 'Secret' })
    expect(Object.keys((all.ok && all.data.certificates) || {})).toEqual(['batch/site-tls'])

    // Nothing of a value crossed: not the key, nor the certificate's own text.
    const lines = [...pems.private.split('\n'), ...pems.cert.split('\n')].filter(
      (line) => line.length > 40,
    )
    expect(lines.some((line) => crossed.some((frame) => frame.includes(line)))).toBe(false)
    expect(crossed.some((frame) => frame.includes(base64(pems.private).slice(0, 60)))).toBe(false)

    // The history: the read of one, and each list that said a certificate, once.
    const reads = () =>
      audited(served, 'secret.read').map((event) => [event.summary, event.outcome, event.details])
    await expect.poll(reads).toEqual(
      expect.arrayContaining([
        ['Read the certificates of 1 Secret in batch', 'success', { secrets: ['batch/site-tls'] }],
        ['Read the certificates of Secret site-tls', 'success', { certificates: ['tls.crt'] }],
        ['Read the certificates of Secret site-tls', 'refused', undefined],
      ]),
    )
    // (Keys only answered none: nothing of its values went, so there's no read of it.)
    expect(
      audited(served, 'secret.read').filter((event) => event.target?.namespace === 'shop'),
    ).toEqual([])
  } finally {
    for (const namespace of ['batch', 'shop', 'data'])
      clusters.demo.remove('Secret', namespace, 'site-tls')
  }
})

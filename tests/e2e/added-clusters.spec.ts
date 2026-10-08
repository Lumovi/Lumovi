/**
 * Clusters added in the desktop app from a pasted or imported kubeconfig: read, checked, kept as
 * a file of Lumovi's own (0600) and read after the rest, edited, removed; a credential that runs
 * a program never run before the person agrees; nothing but Lumovi's own file written; and adding
 * locked by an organization's policy. Through the API the page uses.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { DEMO_TOKEN, writeKubeconfig } from '../mock-cluster/kubeconfig.ts'
import { DEMO, expect, test } from './fixtures.ts'

const posix = process.platform !== 'win32'

/** A kubeconfig's text: one context (`name`) for the demo cluster, signing in as `user` says. */
function kubeconfig(
  name: string,
  server: string,
  caPem: string | undefined,
  user: Parameters<typeof writeKubeconfig>[1]['users'][number] = { name, token: DEMO_TOKEN },
): string {
  const dir = mkdtempSync(join(tmpdir(), `lumovi-${name}-`))
  return readFileSync(
    writeKubeconfig(dir, {
      currentContext: name,
      clusters: [{ name, server, caPem }],
      users: [{ ...user, name }],
      contexts: [{ name, cluster: name, user: name }],
    }),
    'utf8',
  )
}

const api = (page: Page) => page.evaluate(() => Object.keys(window.lumovi!.addedClusters!))
const contexts = (page: Page) =>
  page.evaluate(async () => (await window.lumovi!.kube.contexts()).contexts.map((c) => c.name))
/** Lumovi's own files, where it says they are (macOS's temporary folder is under /private). */
const own = (userDataDir: string) => {
  const folder = join(realpathSync(userDataDir), 'kubeconfigs')
  return existsSync(folder) ? readdirSync(folder).map((name) => join(folder, name)) : []
}

test('a pasted kubeconfig is read, checked, kept as Lumovi’s own, edited and removed, and nothing else is written', async ({
  launch,
  clusters,
}) => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  const { page, app } = await launch({ userDataDir })
  expect(await api(page)).toEqual(
    expect.arrayContaining([
      'import',
      'inspect',
      'check',
      'add',
      'read',
      'edit',
      'remove',
      'forKubectl',
    ]),
  )
  const kubeconfigEnv = await app.evaluate(() => process.env.KUBECONFIG!)
  const before = {
    text: readFileSync(kubeconfigEnv, 'utf8'),
    changed: statSync(kubeconfigEnv).mtimeMs,
  }
  // Named as one already read (the fixture's), as a copied kubeconfig often is.
  const text = kubeconfig('demo', clusters.demo.url, clusters.demo.caPem)

  expect(await page.evaluate((text) => window.lumovi!.addedClusters!.inspect(text), text)).toEqual({
    ok: true,
    data: {
      contexts: [{ name: 'demo', server: clusters.demo.url, auth: 'token' }],
      commands: [],
      files: [],
      conflicts: ['demo'],
    },
  })
  expect(
    await page.evaluate((text) => window.lumovi!.addedClusters!.check(text, 'demo', false), text),
  ).toEqual({
    ok: true,
    data: {
      server: { ok: true, version: DEMO.gitVersion },
      credentials: { ok: true, allowed: true },
    },
  })
  // Taken: kubectl would read the other.
  expect(
    await page.evaluate(
      (text) => window.lumovi!.addedClusters!.add(text, { allowCommands: false }),
      text,
    ),
  ).toMatchObject({
    ok: false,
    error: { code: 'conflict', message: expect.stringContaining('“demo”') },
  })
  expect(own(userDataDir)).toEqual([])

  const added = await page.evaluate(
    (text) =>
      window.lumovi!.addedClusters!.add(text, { names: { demo: 'pasted' }, allowCommands: false }),
    text,
  )
  const [file] = own(userDataDir)
  expect(added).toMatchObject({
    ok: true,
    data: { files: expect.arrayContaining([{ path: file, exists: true, own: true }]) },
  })
  if (posix) expect(statSync(file!).mode & 0o777).toBe(0o600)
  if (posix) expect(statSync(join(userDataDir, 'kubeconfigs')).mode & 0o777).toBe(0o700)
  expect((await contexts(page)).at(-1)).toBe('pasted')
  // Its cluster and user named after it: not taken for the fixture's "demo".
  expect(readFileSync(file!, 'utf8')).not.toMatch(/name: demo\b/)

  // Edited as text, and checked as when added.
  const saved = await page.evaluate((file) => window.lumovi!.addedClusters!.read(file), file!)
  expect(saved).toMatchObject({ ok: true, data: expect.stringContaining('name: pasted') })
  const edited = (saved as { data: string }).data.replace(
    'cluster: pasted\n',
    'cluster: pasted\n      namespace: team-a\n',
  )
  expect(
    await page.evaluate(
      ([file, edited]) => window.lumovi!.addedClusters!.edit(file!, edited!, false),
      [file, edited],
    ),
  ).toMatchObject({ ok: true })
  expect(
    (await page.evaluate(async () => (await window.lumovi!.kube.contexts()).contexts)).find(
      (context) => context.name === 'pasted',
    ),
  ).toMatchObject({ namespace: 'team-a' })
  expect(own(userDataDir)).toEqual([file])
  if (posix) expect(statSync(file!).mode & 0o777).toBe(0o600)

  // The line for a terminal: everything read, in order, or one of them.
  const all = await page.evaluate(() => window.lumovi!.addedClusters!.forKubectl())
  const one = await page.evaluate((file) => window.lumovi!.addedClusters!.forKubectl(file), file!)
  if (posix) {
    expect(all).toEqual({ ok: true, data: `export KUBECONFIG='${kubeconfigEnv}:${file}'` })
    expect(one).toEqual({ ok: true, data: `export KUBECONFIG='${file}'` })
  } else {
    expect(all).toEqual({ ok: true, data: `$env:KUBECONFIG = '${kubeconfigEnv};${file}'` })
  }

  // Only Lumovi's own: not any file the page names.
  for (const call of ['read', 'edit', 'remove', 'forKubectl'] as const) {
    expect(
      await page.evaluate(
        ([call, path]): Promise<unknown> =>
          call === 'edit'
            ? window.lumovi!.addedClusters!.edit(path!, 'x', false)
            : window.lumovi!.addedClusters![call as 'read'](path!),
        [call, join(tmpdir(), 'elsewhere.yaml')],
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid' } })
  }
  expect(
    await page.evaluate((path) => window.lumovi!.addedClusters!.read(path), kubeconfigEnv),
  ).toMatchObject({ ok: false, error: { code: 'invalid' } })
  // Removed where clusters added in Lumovi are, not as a file chosen.
  expect(
    await page.evaluate((file) => window.lumovi!.kubeconfigFiles!.remove(file), file!),
  ).toMatchObject({ ok: false, error: { message: expect.stringContaining('remove it there') } })
  await app.close()

  // Kept across a restart; then removed, its file with it.
  const again = await launch({ userDataDir })
  expect((await contexts(again.page)).at(-1)).toBe('pasted')
  expect(
    await again.page.evaluate((file) => window.lumovi!.addedClusters!.remove(file), file!),
  ).toMatchObject({ ok: true })
  expect(own(userDataDir)).toEqual([])
  expect(await contexts(again.page)).not.toContain('pasted')
  // The person's own kubeconfig never written.
  expect({
    text: readFileSync(kubeconfigEnv, 'utf8'),
    changed: statSync(kubeconfigEnv).mtimeMs,
  }).toEqual(before)
})

test('a check says what doesn’t work: the server, or the credentials; and what it can’t keep, why', async ({
  launch,
  clusters,
}) => {
  const { page } = await launch()
  const check = (text: string, context: string) =>
    page.evaluate(
      ([text, context]) => window.lumovi!.addedClusters!.check(text!, context!, false),
      [text, context],
    )
  expect(
    await check(
      kubeconfig('wrong', clusters.demo.url, clusters.demo.caPem, { name: '', token: 'wrong' }),
      'wrong',
    ),
  ).toMatchObject({
    ok: true,
    data: { server: { ok: true }, credentials: { ok: false, message: expect.any(String) } },
  })
  expect(
    await check(kubeconfig('untrusted', clusters.demo.url, undefined), 'untrusted'),
  ).toMatchObject({
    ok: true,
    data: {
      server: { ok: false, message: expect.any(String) },
      credentials: { ok: false, notTried: 'server' },
    },
  })
  expect(
    await check(kubeconfig('demo', clusters.demo.url, clusters.demo.caPem), 'nope'),
  ).toMatchObject({
    ok: false,
    error: { code: 'invalid', message: expect.stringContaining('“nope”') },
  })

  // Not a kubeconfig, or one naming its files relative to where it was.
  for (const [text, says] of [
    ['clusters: [', 'isn’t YAML'],
    ['kind: Config\n', 'no contexts'],
    [
      'contexts: [{name: rel, context: {cluster: rel, user: rel}}]\nclusters: [{name: rel, cluster: {server: "https://localhost", certificate-authority: ca.crt}}]\nusers: [{name: rel, user: {}}]\n',
      '“ca.crt” relative',
    ],
  ] as const) {
    expect(
      await page.evaluate(
        (text) => window.lumovi!.addedClusters!.add(text, { allowCommands: false }),
        text,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid', message: expect.stringContaining(says) },
    })
  }
})

test('a credential that runs a program is shown as it runs, and run only once the person agrees', async ({
  launch,
  clusters,
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-plugin-'))
  const ran = join(dir, 'ran')
  const plugin = join(dir, 'credential.mjs')
  writeFileSync(
    plugin,
    `import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(ran)}, 'ran\\n')
console.log(JSON.stringify({ apiVersion: 'client.authentication.k8s.io/v1', kind: 'ExecCredential', status: { token: ${JSON.stringify(DEMO_TOKEN)} } }))
`,
  )
  const text = kubeconfig('plugged', clusters.demo.url, clusters.demo.caPem, {
    name: '',
    exec: { command: process.execPath, args: [plugin], env: [{ name: 'TEAM', value: 'a' }] },
  })
  const userDataDir = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  const { page } = await launch({ userDataDir })

  expect(
    await page.evaluate((text) => window.lumovi!.addedClusters!.inspect(text), text),
  ).toMatchObject({
    ok: true,
    data: {
      contexts: [{ name: 'plugged', auth: 'command' }],
      commands: [
        {
          user: 'plugged',
          line: expect.stringContaining(plugin),
          env: [{ name: 'TEAM', value: 'a' }],
        },
      ],
    },
  })
  // Not agreed to: the server checked without it, and nothing kept.
  expect(
    await page.evaluate(
      (text) => window.lumovi!.addedClusters!.check(text, 'plugged', false),
      text,
    ),
  ).toEqual({
    ok: true,
    data: {
      // The mock tells its version only to those signed in.
      server: { ok: true },
      credentials: { ok: false, notTried: 'commands' },
    },
  })
  expect(
    await page.evaluate(
      (text) => window.lumovi!.addedClusters!.add(text, { allowCommands: false }),
      text,
    ),
  ).toMatchObject({
    ok: false,
    error: { code: 'not-allowed', message: expect.stringContaining(plugin) },
  })
  // Anything but a yes isn't one.
  expect(
    await page.evaluate(
      (text) =>
        window.lumovi!.addedClusters!.add(text, { allowCommands: 'yes' as unknown as boolean }),
      text,
    ),
  ).toMatchObject({ ok: false, error: { code: 'not-allowed' } })
  expect(existsSync(ran)).toBe(false)
  expect(own(userDataDir)).toEqual([])

  // Agreed to: run, to check it and once kept.
  expect(
    await page.evaluate((text) => window.lumovi!.addedClusters!.check(text, 'plugged', true), text),
  ).toMatchObject({ ok: true, data: { credentials: { ok: true, allowed: true } } })
  expect(readFileSync(ran, 'utf8')).toBe('ran\n')
  expect(
    await page.evaluate(
      (text) => window.lumovi!.addedClusters!.add(text, { allowCommands: true }),
      text,
    ),
  ).toMatchObject({ ok: true })
  expect(await contexts(page)).toContain('plugged')
})

test('an organization’s policy that keeps Lumovi to the default locks adding, and what was added isn’t read', async ({
  launch,
  clusters,
}) => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  // Added before the policy came.
  mkdirSync(join(userDataDir, 'kubeconfigs'))
  writeFileSync(
    join(userDataDir, 'kubeconfigs', '1-before.yaml'),
    kubeconfig('before', clusters.demo.url, clusters.demo.caPem),
  )
  const policy = join(mkdtempSync(join(tmpdir(), 'lumovi-policy-')), 'policy.json')
  writeFileSync(policy, JSON.stringify({ kubeconfigFiles: 'locked' }))
  const { page } = await launch({ env: { LUMOVI_POLICY: policy }, userDataDir })

  expect(await contexts(page)).not.toContain('before')
  const text = kubeconfig('after', clusters.demo.url, clusters.demo.caPem)
  expect(
    await page.evaluate(
      (text) => window.lumovi!.addedClusters!.add(text, { allowCommands: false }),
      text,
    ),
  ).toMatchObject({ ok: false, error: { code: 'not-allowed' } })
  expect(
    await page.evaluate((text) => window.lumovi!.addedClusters!.check(text, 'after', false), text),
  ).toMatchObject({ ok: false, error: { code: 'not-allowed' } })
  expect(own(userDataDir)).toHaveLength(1)
})

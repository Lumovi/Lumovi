/**
 * An organization's policy for the desktop app (deployed by IT): what it sets is locked, one
 * that can't be used locks the most it could, and its network is the one Lumovi goes through.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { proxyCredentials } from '../../src/main/chromium-proxy.ts'
import { inRegistry } from '../../src/main/policy.ts'
import { writeKubeconfig } from '../mock-cluster/kubeconfig.ts'
import { startMockProxy } from '../mock-proxy/server.ts'
import { open } from './action-helpers.ts'
import { clusterOption, DEMO, DEMO_TOKEN, expect, openCluster, panel, test } from './fixtures.ts'

/** A policy file, as IT would deploy it (LUMOVI_POLICY points at it, for trying one out). */
function policyFile(policy: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'lumovi-policy-')), 'policy.json')
  writeFileSync(path, typeof policy === 'string' ? policy : JSON.stringify(policy))
  return path
}

test('what an organization’s policy sets is locked', async ({ launch }) => {
  // The person had assistants on, and updates installed by themselves.
  const userDataDir = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  writeFileSync(
    join(userDataDir, 'settings.json'),
    JSON.stringify({ assistants: { enabled: true, port: 47_000 }, autoUpdate: true }),
  )
  const { page, app } = await launch({
    userDataDir,
    env: {
      LUMOVI_POLICY: policyFile({
        readOnly: ['dem*'],
        assistants: false,
        updates: false,
        assistantRules: [{ name: 'No Secrets', secrets: 'hidden' }],
      }),
    },
  })
  // Clusters it names are read-only, and can't be made changeable here.
  await openCluster(page)
  await open(page, 'Deployments', DEMO.deployments.storefront)
  const detail = panel(page, 'Deployment', DEMO.deployments.storefront)
  await detail.getByRole('button', { name: 'Read-only' }).click()
  await expect(page.getByRole('dialog')).toContainText(
    'Your organization’s policy makes demo read-only.',
  )
  await expect(page.getByRole('button', { name: 'Allow changes' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Switch cluster' }).click()
  await expect(page.getByRole('switch', { name: 'Read-only' })).toBeDisabled()
  await expect(page.getByText('Set by your organization')).toBeVisible()
  await page.keyboard.press('Escape')
  // (The main process refuses too.)
  await expect(page.evaluate(() => window.lumovi!.app.setReadOnly('demo', false))).rejects.toThrow(
    'Your organization’s policy makes demo read-only.',
  )
  // Others aren't.
  expect(await page.evaluate(() => window.lumovi!.app.setReadOnly('sandbox', true))).toMatchObject({
    readOnly: ['sandbox'],
  })

  // AI assistants: off, and can't be turned on; what they may do at most, its rules.
  await page.evaluate(() => {
    window.location.hash = '#/assistants/connect'
  })
  await expect(page.getByRole('switch', { name: 'Let AI assistants connect' })).toBeDisabled()
  await expect(page.getByRole('main')).toContainText(
    'Your organization’s policy turns AI assistants off on this computer.',
  )
  await expect(
    page.evaluate(() => window.lumovi!.assistants!.configure({ enabled: true })),
  ).rejects.toThrow('Your organization’s policy turns AI assistants off on this computer.')
  expect(await page.evaluate(() => window.lumovi!.aiPermissions!.get())).toMatchObject({
    admin: [{ name: 'No Secrets', set: { secrets: 'hidden' } }],
  })

  // Updates: IT's, so Lumovi neither looks for them nor installs them, and the menu can't.
  expect(
    await app.evaluate(({ Menu }) =>
      ['check-updates', 'auto-updates'].map((id) => {
        const item = Menu.getApplicationMenu()!.getMenuItemById(id)!
        return { label: item.label, enabled: item.enabled, checked: item.checked }
      }),
    ),
  ).toEqual([
    { label: 'Updates Are Set by Your Organization', enabled: false, checked: false },
    { label: 'Check for Updates Automatically', enabled: false, checked: false },
  ])
  await page.evaluate(() => window.lumovi!.updates!.check())
  await expect(page.getByText('Your organization updates Lumovi')).toBeVisible()
  // What the policy sets isn't kept over the person's own: theirs is back when it's gone.
  expect(JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8'))).toMatchObject({
    assistants: { enabled: true, port: 47_000 },
    autoUpdate: true,
  })
})

test('a policy that can’t be used locks the most it could', async ({ launch }) => {
  const path = policyFile({ readOnly: true, colour: 'blue' })
  const { page } = await launch({ env: { LUMOVI_POLICY: path } })
  expect(await page.evaluate(() => window.lumovi!.app.settings())).toMatchObject({
    managed: {
      source: path,
      readOnly: true,
      assistantsOff: true,
      problem: `${path} can’t be used: it has colour, which Lumovi doesn’t know: readOnly, assistants, assistantRules, updates, network.`,
    },
  })
  await openCluster(page)
  await open(page, 'Deployments', DEMO.deployments.storefront)
  await panel(page, 'Deployment', DEMO.deployments.storefront)
    .getByRole('button', { name: 'Read-only' })
    .click()
  await expect(page.getByRole('dialog')).toContainText(
    `Lumovi can’t use your organization’s policy (${path} can’t be used: it has colour`,
  )
  // And said as Lumovi starts, not only to a terminal.
  await expect(page.getByText('Lumovi started without something it was given')).toBeVisible()
})

test('a policy that isn’t JSON, has a key twice, or isn’t a file can’t be used either', async ({
  launch,
}) => {
  const twice = policyFile('{ "readOnly": true, "readOnly": false }')
  const fifo = join(mkdtempSync(join(tmpdir(), 'lumovi-policy-')), 'policy.json')
  if (process.platform !== 'win32') execFileSync('mkfifo', [fifo])
  const cases: [string, string][] = [
    [twice, 'a key is given twice'],
    // Where it isn't JSON, never what's there.
    [policyFile('{\n  "readOnly": true,\n}'), 'it isn’t JSON (at line 3 column 1).'],
  ]
  if (process.platform !== 'win32') cases.push([fifo, `${fifo} must be a file.`])
  for (const [path, problem] of cases) {
    // (Nothing waits on a FIFO: Lumovi starts.)
    const { page, app } = await launch({ env: { LUMOVI_POLICY: path } })
    expect(await page.evaluate(() => window.lumovi!.app.settings())).toMatchObject({
      managed: { readOnly: true, assistantsOff: true, problem: expect.stringContaining(problem) },
    })
    await app.close()
  }
})

test('the network a policy says: its proxy, over the one the environment says', async ({
  launch,
  clusters,
}) => {
  const proxy = await startMockProxy()
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-policy-'))
  const kubeconfig = writeKubeconfig(dir, {
    clusters: [
      {
        name: 'corp',
        server: `https://cluster.test:${clusters.demo.port}`,
        caPem: clusters.demo.caPem,
        tlsServerName: 'localhost',
      },
    ],
    users: [{ name: 'demo', token: DEMO_TOKEN }],
    contexts: [{ name: 'corp', cluster: 'corp', user: 'demo' }],
  })
  const { page, app } = await launch({
    env: {
      KUBECONFIG: kubeconfig,
      // The person's own, which the policy's replaces.
      HTTPS_PROXY: 'http://127.0.0.1:9',
      LUMOVI_POLICY: policyFile({
        network: { proxy: proxy.url, noProxy: 'internal.corp', caFiles: [join(dir, 'gone.pem')] },
      }),
    },
  })
  await expect(clusterOption(page, 'corp')).toContainText(DEMO.gitVersion)
  expect(proxy.seen).toContain(`CONNECT cluster.test:${clusters.demo.port}`)
  // What Chromium fetches (the updater) goes through it too, but for what it leaves out.
  expect(
    await app.evaluate(({ session }) =>
      Promise.all(
        ['https://github.com/', 'https://git.internal.corp/'].map((url) =>
          session.defaultSession.resolveProxy(url),
        ),
      ),
    ),
  ).toEqual([`PROXY ${new URL(proxy.url).host}`, 'DIRECT'])
  // The updater's own session, as well.
  expect(
    await app.evaluate(({ session }) =>
      session.fromPartition('electron-updater').resolveProxy('https://github.com/'),
    ),
  ).toBe(`PROXY ${new URL(proxy.url).host}`)
  // A certificate authority's file that isn't there: said, and the rest set up.
  await expect(
    page.getByText(`The certificate authorities in ${join(dir, 'gone.pem')}`),
  ).toBeVisible()
  expect(await app.evaluate(() => process.env.NO_PROXY)).toBe(
    'internal.corp,localhost,127.0.0.1,::1,[::1]',
  )
  await proxy.close()
})

test('on Windows, IT’s policy is the registry’s: as it was set, and only none where there’s none', async () => {
  test.skip(process.platform !== 'win32', 'Windows’ registry')
  // As IT sets it under HKEY_LOCAL_MACHINE, here where a test may write.
  const key = `HKEY_CURRENT_USER\\Software\\LumoviTest${process.pid}`
  const set = (script: string) =>
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
  const path = key.replace('HKEY_CURRENT_USER', 'HKCU:')
  const policy = (value: string) =>
    set(
      `New-ItemProperty -Path '${path}' -Name Policy -PropertyType String -Force -Value @'\n${value}\n'@ | Out-Null`,
    )
  // Where reg.exe can't be run (as "Prevent access to registry editing tools" has it).
  const blocked = {
    reg: 'C:\\Windows\\System32\\no-reg.exe',
    powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  }
  try {
    // No key: no policy, whichever reads it.
    expect(inRegistry(process.env, key)).toBeUndefined()
    expect(inRegistry(process.env, key, blocked)).toBeUndefined()
    // A key without the value: one that can't be used.
    set(`New-Item -Path '${path}' -Force | Out-Null`)
    expect(() => inRegistry(process.env, key)!.text()).toThrow('it must be text (REG_SZ)')
    // Over lines, as IT would write it, with JSON's escapes.
    policy('{\n  "readOnly": ["prod-*", "caf\\u00e9"],\n  "updates": false\n}')
    const found = inRegistry(process.env, key)!
    expect(found.source).toBe(`${key}\\Policy`)
    expect(JSON.parse(found.text())).toEqual({ readOnly: ['prod-*', 'café'], updates: false })
    // What isn't ASCII, as it is (which reg.exe garbles: PowerShell reads it).
    policy('{ "readOnly": ["café-prod"] }')
    expect(JSON.parse(inRegistry(process.env, key)!.text())).toEqual({ readOnly: ['café-prod'] })
    expect(JSON.parse(inRegistry(process.env, key, blocked)!.text())).toEqual({
      readOnly: ['café-prod'],
    })
    // A number isn't a policy.
    set(`Set-ItemProperty -Path '${path}' -Name Policy -Type DWord -Value 1`)
    expect(() => inRegistry(process.env, key)!.text()).toThrow('it must be text (REG_SZ)')
    expect(() => inRegistry(process.env, key, blocked)!.text()).toThrow('it must be text (REG_SZ)')
    // Neither can read it: not none, but one that can't be used.
    const neither = { reg: blocked.reg, powershell: 'C:\\Windows\\System32\\no-powershell.exe' }
    expect(() => inRegistry(process.env, key, neither)!.text()).toThrow(
      'Lumovi can’t read it: neither reg.exe nor PowerShell could.',
    )
  } finally {
    set(`Remove-Item -Path '${path}' -Recurse -Force -ErrorAction SilentlyContinue`)
  }
})

test('a proxy’s credentials go to that proxy alone', () => {
  const proxy = 'http://corp%40example:s3cret@proxy.corp:3128'
  const asked = (auth: Partial<Electron.AuthInfo>) =>
    proxyCredentials(proxy, {
      isProxy: true,
      scheme: 'basic',
      realm: '',
      host: 'proxy.corp',
      port: 3128,
      ...auth,
    })
  expect(asked({})).toEqual(['corp@example', 's3cret'])
  expect(asked({ isProxy: false })).toBeUndefined()
  expect(asked({ host: 'evil.example' })).toBeUndefined()
  expect(asked({ port: 8080 })).toBeUndefined()
  expect(
    proxyCredentials('http://proxy.corp:3128', {
      isProxy: true,
      scheme: 'basic',
      realm: '',
      host: 'proxy.corp',
      port: 3128,
    }),
  ).toBeUndefined()
})

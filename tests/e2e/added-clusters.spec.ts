/**
 * Clusters added in the desktop app from a pasted or imported kubeconfig: read, checked, kept as
 * a file of Lumovi's own (0600) and read after the rest, edited (its secrets kept from the page),
 * removed; a credential that runs a program, or sends a file, never used before the person agrees
 * to that very thing; nothing but Lumovi's own file written; files that aren't refused; and adding
 * locked by an organization's policy. Through the API the page uses.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { Page } from '@playwright/test'
import { parse, stringify } from 'yaml'
import { DEMO_TOKEN, writeKubeconfig } from '../mock-cluster/kubeconfig.ts'
import { DEMO, expect, test } from './fixtures.ts'

const posix = process.platform !== 'win32'
/** A kubeconfig, as parsed. */
interface Config {
  clusters: { name: string; cluster: Record<string, unknown> }[]
  users: { name: string; user: Record<string, unknown> }[]
  contexts: { name: string; context: { cluster: string; user: string } }[]
}
/** A plugin's environment's value, as a secret might be: kept from the page once added. */
const TEAM_SECRET = 'team-secret-4f2a9c'
/** How the line for kubectl starts, in the shell here. */
const LINE = posix ? /^export KUBECONFIG=/ : /^\$env:KUBECONFIG = "/

/** What KUBECONFIG is once `line` has run, in the shell it's for. */
const run = (line: string) =>
  posix
    ? execFileSync('sh', ['-c', `${line}; printf %s "$KUBECONFIG"`], { encoding: 'utf8' })
    : execFileSync(
        'powershell',
        ['-NoProfile', '-Command', `${line}; [Console]::Out.Write($env:KUBECONFIG)`],
        { encoding: 'utf8' },
      )

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

/** A kubeconfig's text: one context (`name`) for the demo cluster, signing in with a token file. */
function withTokenFile(name: string, server: string, caPem: string, tokenFile: string): string {
  return JSON.stringify({
    apiVersion: 'v1',
    kind: 'Config',
    clusters: [
      {
        name,
        cluster: {
          server,
          'certificate-authority-data': Buffer.from(caPem).toString('base64'),
        },
      },
    ],
    users: [{ name, user: { 'token-file': tokenFile } }],
    contexts: [{ name, context: { cluster: name, user: name } }],
  })
}

const api = (page: Page) => page.evaluate(() => Object.keys(window.lumovi!.addedClusters!))
const contexts = (page: Page) =>
  page.evaluate(async () => (await window.lumovi!.kube.contexts()).contexts.map((c) => c.name))
/** Lumovi's own files, where it says they are (macOS's temporary folder is under /private). */
const own = (userDataDir: string) => {
  const folder = join(realpathSync(userDataDir), 'clusters')
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
      tokenFiles: [],
      keptCredentials: [],
      files: [],
      conflicts: ['demo'],
    },
  })
  expect(
    await page.evaluate((text) => window.lumovi!.addedClusters!.check(text, 'demo', []), text),
  ).toEqual({
    ok: true,
    data: {
      server: { ok: true, version: DEMO.gitVersion, latencyMs: expect.any(Number) },
      credentials: { ok: true, allowed: true },
    },
  })
  // Taken: kubectl would read the other.
  expect(
    await page.evaluate((text) => window.lumovi!.addedClusters!.add(text, { agreed: [] }), text),
  ).toMatchObject({
    ok: false,
    error: { code: 'conflict', message: expect.stringContaining('“demo”') },
  })
  expect(own(userDataDir)).toEqual([])

  const added = await page.evaluate(
    (text) => window.lumovi!.addedClusters!.add(text, { names: { demo: 'pasted' }, agreed: [] }),
    text,
  )
  const [file] = own(userDataDir)
  // Named after the cluster.
  expect(file).toMatch(/[\\/]pasted\.yaml$/)
  expect(added).toMatchObject({
    ok: true,
    data: {
      path: file,
      files: { files: expect.arrayContaining([{ path: file, exists: true, own: true }]) },
    },
  })
  if (posix) expect(statSync(file!).mode & 0o777).toBe(0o600)
  if (posix) expect(statSync(join(userDataDir, 'clusters')).mode & 0o777).toBe(0o700)
  expect((await contexts(page)).at(-1)).toBe('pasted')
  // Its cluster and user named as nothing of the person's is: not taken for the fixture's "demo",
  // nor for any named as the context is.
  const keptText = readFileSync(file!, 'utf8')
  expect(keptText.match(/name: lumovi-[0-9a-f]{12}\n/g)).toHaveLength(2)
  expect(keptText).not.toMatch(/name: (demo|pasted)\n\s+(cluster|user):/)

  // Edited as text, its token kept from the page, and checked as when added.
  const saved = await page.evaluate((file) => window.lumovi!.addedClusters!.read(file), file!)
  expect(saved).toMatchObject({ ok: true, data: expect.stringContaining('name: pasted') })
  const savedText = (saved as { data: string }).data
  expect(savedText).not.toContain(DEMO_TOKEN)
  expect(savedText).toContain('token: (kept by Lumovi)')
  // Checked as it's edited: with its secrets for its placeholders (not the placeholders sent).
  expect(
    await page.evaluate(
      ([text, file]) => window.lumovi!.addedClusters!.check(text!, 'pasted', [], file),
      [savedText, file],
    ),
  ).toMatchObject({ ok: true, data: { credentials: { ok: true, allowed: true } } })
  expect(
    await page.evaluate(
      (text) => window.lumovi!.addedClusters!.check(text, 'pasted', []),
      savedText,
    ),
  ).toMatchObject({ ok: true, data: { credentials: { ok: false } } })
  const edited = savedText.replace(
    /(\n\s+)user: (lumovi-[0-9a-f]+)\n/,
    '$1user: $2$1namespace: team-a\n',
  )
  expect(edited).toContain('namespace: team-a')
  expect(
    await page.evaluate(
      ([file, edited]) => window.lumovi!.addedClusters!.edit(file!, edited!, []),
      [file, edited],
    ),
  ).toMatchObject({ ok: true })
  // Its token as it was: it still signs in.
  expect(readFileSync(file!, 'utf8')).toContain(DEMO_TOKEN)
  expect(await page.evaluate(() => window.lumovi!.kube.version('pasted'))).toMatchObject({
    ok: true,
    data: { gitVersion: DEMO.gitVersion },
  })
  // A placeholder moved to another user isn't that user's secret.
  const moved = savedText.replace(
    /name: (lumovi-[0-9a-f]+)\n(\s+)user:\n/,
    'name: someone\n$2user:\n',
  )
  expect(
    await page.evaluate(
      ([file, moved]) => window.lumovi!.addedClusters!.edit(file!, moved!, []),
      [file, moved],
    ),
  ).toMatchObject({ ok: false, error: { message: expect.stringContaining('paste it again') } })
  expect(
    (await page.evaluate(async () => (await window.lumovi!.kube.contexts()).contexts)).find(
      (context) => context.name === 'pasted',
    ),
  ).toMatchObject({ namespace: 'team-a' })
  expect(own(userDataDir)).toEqual([file])
  if (posix) expect(statSync(file!).mode & 0o777).toBe(0o600)

  // The line for a terminal: everything read, in order, or one of them, as its shell reads it.
  const all = await page.evaluate(() => window.lumovi!.addedClusters!.forKubectl())
  const one = await page.evaluate((file) => window.lumovi!.addedClusters!.forKubectl(file), file!)
  expect(all).toMatchObject({ ok: true, data: expect.stringMatching(LINE) })
  expect(run((all as { data: string }).data)).toBe([kubeconfigEnv, file].join(delimiter))
  expect(run((one as { data: string }).data)).toBe(file)

  // Only Lumovi's own: not any file the page names.
  for (const call of ['read', 'edit', 'remove', 'forKubectl'] as const) {
    expect(
      await page.evaluate(
        ([call, path]): Promise<unknown> =>
          call === 'edit'
            ? window.lumovi!.addedClusters!.edit(path!, 'x', [])
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

test('the line for kubectl keeps a path whole, whatever it holds, and one in the home folder from $HOME', async ({
  launch,
}) => {
  const odd = join(
    mkdtempSync(join(tmpdir(), 'lumovi-odd-')),
    // What a shell would read as more than text: history (`!`), and curly quotes in PowerShell.
    posix ? `a $dir "it's" \\ \`here\` !x !!` : `a $dir 'it''s' \`here\` ”x“ „`,
  )
  mkdirSync(odd)
  const file = join(odd, 'config')
  writeFileSync(file, '')
  const { page, app } = await launch()
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as never
  }, file)
  await page.evaluate(() => window.lumovi!.kubeconfigFiles!.choose('add'))
  const line = await page.evaluate((file) => window.lumovi!.addedClusters!.forKubectl(file), file)
  expect(line).toMatchObject({ ok: true, data: expect.stringMatching(LINE) })
  expect(run((line as { data: string }).data)).toBe(file)
  // In single quotes, where nothing is read but the text (`!` included, in bash and zsh).
  if (posix) {
    expect(line).toEqual({
      ok: true,
      data: `export KUBECONFIG='${file.replaceAll("'", `'\\''`)}'`,
    })
  }

  // In the home folder: from $HOME, as it'd be typed.
  const home = await app.evaluate(({ app }) => app.getPath('home'))
  const inHome = mkdtempSync(join(home, '.lumovi-test-'))
  try {
    const config = join(inHome, 'config')
    writeFileSync(config, '')
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as never
    }, config)
    await page.evaluate(() => window.lumovi!.kubeconfigFiles!.choose('add'))
    const fromHome = await page.evaluate(
      (file) => window.lumovi!.addedClusters!.forKubectl(file),
      config,
    )
    expect(fromHome).toMatchObject({ ok: true, data: expect.stringContaining('"$HOME"') })
    expect(run((fromHome as { data: string }).data)).toBe(config)
  } finally {
    rmSync(inHome, { recursive: true, force: true })
  }
})

test('a check says what doesn’t work: the server, or the credentials; and what it can’t keep, why', async ({
  launch,
  clusters,
}) => {
  const { page } = await launch()
  const check = (text: string, context: string) =>
    page.evaluate(
      ([text, context]) => window.lumovi!.addedClusters!.check(text!, context!, []),
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
      await page.evaluate((text) => window.lumovi!.addedClusters!.add(text, { agreed: [] }), text),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid', message: expect.stringContaining(says) },
    })
  }

  // Two of its contexts named the same: said so, not taken for one already read.
  const two = parse(kubeconfig('one', clusters.demo.url, clusters.demo.caPem)) as Config
  two.contexts.push({ name: 'two', context: { ...two.contexts[0]!.context } })
  expect(
    await page.evaluate(
      (text) =>
        window.lumovi!.addedClusters!.add(text, {
          names: { one: 'same', two: 'same' },
          agreed: [],
        }),
      stringify(two),
    ),
  ).toMatchObject({
    ok: false,
    error: { message: 'Two of its contexts would be named “same”: name them apart.' },
  })

  // A file it names that isn't one (a folder, a device), or larger than any: never read.
  const big = join(mkdtempSync(join(tmpdir(), 'lumovi-big-')), 'token')
  writeFileSync(big, 'x'.repeat(1024 * 1024 + 1))
  for (const [path, says] of [
    [tmpdir(), 'isn’t a file'],
    [big, 'larger'],
    [join(tmpdir(), 'lumovi-not-there'), 'isn’t there'],
  ] as const) {
    const text = withTokenFile('odd', clusters.demo.url, clusters.demo.caPem!, path)
    for (const result of [
      await check(text, 'odd'),
      await page.evaluate((text) => window.lumovi!.addedClusters!.add(text, { agreed: [] }), text),
    ]) {
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'invalid', message: expect.stringContaining(says) },
      })
    }
  }

  // An unverified server, or a proxy: said, for the page to show.
  const insecure = JSON.parse(kubeconfig('open', clusters.demo.url, undefined)) as {
    clusters: { cluster: Record<string, unknown> }[]
  }
  Object.assign(insecure.clusters[0]!.cluster, {
    'insecure-skip-tls-verify': true,
    'proxy-url': 'http://proxy.example:3128',
  })
  expect(
    await page.evaluate(
      (text) => window.lumovi!.addedClusters!.inspect(text),
      JSON.stringify(insecure),
    ),
  ).toMatchObject({
    ok: true,
    data: { contexts: [{ name: 'open', insecure: true, proxy: 'http://proxy.example:3128' }] },
  })
})

test('a credential that sends a file to the server is shown, and the file isn’t even read before the person agrees', async ({
  launch,
  clusters,
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-token-'))
  const token = join(dir, 'token')
  writeFileSync(token, DEMO_TOKEN)
  const text = withTokenFile('tokened', clusters.demo.url, clusters.demo.caPem!, token)
  const userDataDir = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  const { page } = await launch({ userDataDir })

  const inspected = await page.evaluate((text) => window.lumovi!.addedClusters!.inspect(text), text)
  expect(inspected).toMatchObject({
    ok: true,
    data: {
      contexts: [{ name: 'tokened', auth: 'token' }],
      // With the server it's sent to.
      tokenFiles: [
        { user: 'tokened', path: token, server: clusters.demo.url, consent: expect.any(String) },
      ],
    },
  })
  const { consent } = (inspected as { data: { tokenFiles: { consent: string }[] } }).data
    .tokenFiles[0]!
  // Not readable: were it read before agreement, the check would fail, not wait for it.
  if (posix) chmodSync(token, 0)
  expect(
    await page.evaluate((text) => window.lumovi!.addedClusters!.check(text, 'tokened', []), text),
  ).toEqual({
    ok: true,
    data: {
      server: { ok: true, latencyMs: expect.any(Number) },
      credentials: { ok: false, notTried: 'agreement' },
    },
  })
  if (posix) chmodSync(token, 0o600)
  expect(
    await page.evaluate((text) => window.lumovi!.addedClusters!.add(text, { agreed: [] }), text),
  ).toMatchObject({
    ok: false,
    error: {
      code: 'not-allowed',
      message: `Its credentials would send ${token} to ${clusters.demo.url}. Agree to that to keep it.`,
    },
  })
  expect(own(userDataDir)).toEqual([])

  // Agreed to: sent, to check it and once kept.
  expect(
    await page.evaluate(
      ([text, consent]) => window.lumovi!.addedClusters!.check(text!, 'tokened', [consent!]),
      [text, consent],
    ),
  ).toMatchObject({ ok: true, data: { credentials: { ok: true, allowed: true } } })
  expect(
    await page.evaluate(
      ([text, consent]) => window.lumovi!.addedClusters!.add(text!, { agreed: [consent!] }),
      [text, consent],
    ),
  ).toMatchObject({ ok: true })
  expect(await contexts(page)).toContain('tokened')
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
    exec: {
      command: process.execPath,
      args: [plugin],
      env: [{ name: 'TEAM', value: TEAM_SECRET }],
    },
  })
  const userDataDir = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  const { page } = await launch({ userDataDir })

  const inspected = await page.evaluate((text) => window.lumovi!.addedClusters!.inspect(text), text)
  expect(inspected).toMatchObject({
    ok: true,
    data: {
      contexts: [{ name: 'plugged', auth: 'command' }],
      commands: [
        {
          user: 'plugged',
          line: expect.stringContaining(plugin),
          env: [{ name: 'TEAM', value: TEAM_SECRET }],
          consent: expect.any(String),
        },
      ],
    },
  })
  const { consent } = (inspected as { data: { commands: { consent: string }[] } }).data.commands[0]!
  // Not agreed to: the server checked without it, and nothing kept.
  expect(
    await page.evaluate((text) => window.lumovi!.addedClusters!.check(text, 'plugged', []), text),
  ).toEqual({
    ok: true,
    data: {
      // The mock tells its version only to those signed in.
      server: { ok: true, latencyMs: expect.any(Number) },
      credentials: { ok: false, notTried: 'agreement' },
    },
  })
  expect(
    await page.evaluate((text) => window.lumovi!.addedClusters!.add(text, { agreed: [] }), text),
  ).toMatchObject({
    ok: false,
    error: { code: 'not-allowed', message: expect.stringContaining(plugin) },
  })
  // Agreed to something else: what was shown, not what this runs (another argument, or another
  // environment), isn't agreement to it.
  for (const changed of [
    kubeconfig('plugged', clusters.demo.url, clusters.demo.caPem, {
      name: '',
      exec: {
        command: process.execPath,
        args: [plugin, '--more'],
        env: [{ name: 'TEAM', value: TEAM_SECRET }],
      },
    }),
    kubeconfig('plugged', clusters.demo.url, clusters.demo.caPem, {
      name: '',
      exec: {
        command: process.execPath,
        args: [plugin],
        env: [{ name: 'TEAM', value: 'another' }],
      },
    }),
  ]) {
    for (const result of [
      await page.evaluate(
        ([text, consent]) => window.lumovi!.addedClusters!.add(text!, { agreed: [consent!] }),
        [changed, consent],
      ),
      await page.evaluate(
        ([text, consent]) => window.lumovi!.addedClusters!.check(text!, 'plugged', [consent!]),
        [changed, consent],
      ),
    ]) {
      expect(result).toMatchObject(
        'error' in result
          ? { ok: false, error: { code: 'not-allowed' } }
          : { ok: true, data: { credentials: { notTried: 'agreement' } } },
      )
    }
  }
  expect(existsSync(ran)).toBe(false)
  expect(own(userDataDir)).toEqual([])

  // Agreed to: run, to check it and once kept.
  expect(
    await page.evaluate(
      ([text, consent]) => window.lumovi!.addedClusters!.check(text!, 'plugged', [consent!]),
      [text, consent],
    ),
  ).toMatchObject({ ok: true, data: { credentials: { ok: true, allowed: true } } })
  expect(readFileSync(ran, 'utf8')).toBe('ran\n')
  expect(
    await page.evaluate(
      ([text, consent]) => window.lumovi!.addedClusters!.add(text!, { agreed: [consent!] }),
      [text, consent],
    ),
  ).toMatchObject({ ok: true })
  expect(await contexts(page)).toContain('plugged')

  // Its program's environment is kept from the page as its other secrets are, and kept on edit:
  // what it runs is what was agreed to, needing no agreement again.
  const [file] = own(userDataDir)
  const saved = (
    (await page.evaluate((file) => window.lumovi!.addedClusters!.read(file), file!)) as {
      data: string
    }
  ).data
  expect(saved).not.toContain(TEAM_SECRET)
  expect(saved).toContain('value: (kept by Lumovi)')
  // What's agreed to, as it'd run (its secret too), but nothing of the secret in what the page gets.
  const editing = await page.evaluate(
    ([text, file]) => window.lumovi!.addedClusters!.inspect(text!, file),
    [saved, file],
  )
  expect(editing).toMatchObject({
    ok: true,
    data: { commands: [{ consent, env: [{ name: 'TEAM', value: '(kept by Lumovi)' }] }] },
  })
  expect(JSON.stringify(editing)).not.toContain(TEAM_SECRET)
  expect(JSON.stringify(inspected)).toContain(TEAM_SECRET)
  expect(consent).toMatch(/^[0-9a-f]{64}$/)
  expect(
    await page.evaluate(
      ([file, text]) => window.lumovi!.addedClusters!.edit(file!, text!, []),
      [file, saved],
    ),
  ).toMatchObject({ ok: true })
  expect(readFileSync(file!, 'utf8')).toContain(TEAM_SECRET)
})

test('an organization’s policy that keeps Lumovi to the default locks adding, and what was added isn’t read', async ({
  launch,
  clusters,
}) => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  // Added before the policy came.
  mkdirSync(join(userDataDir, 'clusters'))
  writeFileSync(
    join(userDataDir, 'clusters', 'before.yaml'),
    kubeconfig('before', clusters.demo.url, clusters.demo.caPem),
  )
  const policy = join(mkdtempSync(join(tmpdir(), 'lumovi-policy-')), 'policy.json')
  writeFileSync(policy, JSON.stringify({ kubeconfigFiles: 'locked' }))
  const { page } = await launch({ env: { LUMOVI_POLICY: policy }, userDataDir })

  expect(await contexts(page)).not.toContain('before')
  const text = kubeconfig('after', clusters.demo.url, clusters.demo.caPem)
  expect(
    await page.evaluate((text) => window.lumovi!.addedClusters!.add(text, { agreed: [] }), text),
  ).toMatchObject({ ok: false, error: { code: 'not-allowed' } })
  expect(
    await page.evaluate((text) => window.lumovi!.addedClusters!.check(text, 'after', []), text),
  ).toMatchObject({ ok: false, error: { code: 'not-allowed' } })
  expect(own(userDataDir)).toHaveLength(1)
})

test('an added cluster’s kept credentials go only where they were kept for, unless the person agrees', async ({
  launch,
  clusters,
}) => {
  // A stand-in server, which notes what credentials reach it.
  const seen: string[] = []
  const standIn = createServer((req, res) => {
    if (req.headers.authorization) seen.push(req.headers.authorization)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(req.url === '/version' ? { gitVersion: 'v9.9.9' } : { items: [] }))
  })
  await new Promise<void>((done) => standIn.listen(0, '127.0.0.1', done))
  const elsewhere = `http://127.0.0.1:${(standIn.address() as AddressInfo).port}`

  const userDataDir = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  const { page } = await launch({ userDataDir })
  expect(
    await page.evaluate(
      (text) => window.lumovi!.addedClusters!.add(text, { agreed: [] }),
      kubeconfig('kept', clusters.demo.url, clusters.demo.caPem),
    ),
  ).toMatchObject({ ok: true })
  const [file] = own(userDataDir)
  const read = async (file: string) =>
    (
      (await page.evaluate((file) => window.lumovi!.addedClusters!.read(file), file)) as {
        data: string
      }
    ).data
  const kept = await read(file!)

  const inspect = (text: string) =>
    page.evaluate(
      ([text, file]) => window.lumovi!.addedClusters!.inspect(text!, file),
      [text, file!],
    )
  const check = (text: string, context: string, agreed: string[] = []) =>
    page.evaluate(
      ([text, context, file, agreed]) =>
        window.lumovi!.addedClusters!.check(
          text as string,
          context as string,
          agreed as string[],
          file as string,
        ),
      [text, context, file!, agreed] as const,
    )
  const edit = (text: string) =>
    page.evaluate(
      ([file, text]) => window.lumovi!.addedClusters!.edit(file!, text!, []),
      [file!, text],
    )

  // Its server moved (not verified, nor proxied): the kept token isn't sent there, or kept so.
  const moved = parse(kept) as Config
  moved.clusters[0]!.cluster = { server: elsewhere, 'insecure-skip-tls-verify': true }
  const movedText = stringify(moved)
  const asked = (await inspect(movedText)) as {
    data: { keptCredentials: { context: string; server: string; consent: string }[] }
  }
  expect(asked.data.keptCredentials).toEqual([
    { context: 'kept', server: elsewhere, consent: expect.stringMatching(/^[0-9a-f]{64}$/) },
  ])
  expect(await check(movedText, 'kept')).toMatchObject({
    ok: true,
    data: { server: { ok: true, version: 'v9.9.9' }, credentials: { notTried: 'agreement' } },
  })
  expect(await edit(movedText)).toMatchObject({
    ok: false,
    error: {
      code: 'not-allowed',
      message: expect.stringContaining(`send its kept credentials to ${elsewhere}`),
    },
  })
  expect(seen).toEqual([])
  expect(readFileSync(file!, 'utf8')).toContain(clusters.demo.url)

  // A context added under its user, to another cluster: the same, though its own is as it was.
  const added = parse(kept) as Config
  added.clusters.push({
    name: 'elsewhere',
    cluster: { server: elsewhere, 'insecure-skip-tls-verify': true },
  })
  added.contexts.push({
    name: 'elsewhere',
    context: { cluster: 'elsewhere', user: added.contexts[0]!.context.user },
  })
  const addedText = stringify(added)
  expect(await check(addedText, 'elsewhere')).toMatchObject({
    ok: true,
    data: { credentials: { notTried: 'agreement' } },
  })
  expect(await check(addedText, 'kept')).toMatchObject({
    ok: true,
    data: { credentials: { ok: true } },
  })
  expect(await edit(addedText)).toMatchObject({ ok: false, error: { code: 'not-allowed' } })
  expect(seen).toEqual([])

  // Agreed to, for that very server: sent there.
  const { consent } = asked.data.keptCredentials[0]!
  expect(await check(movedText, 'kept', [consent])).toMatchObject({
    ok: true,
    data: { credentials: { ok: true } },
  })
  expect(seen).toContain(`Bearer ${DEMO_TOKEN}`)

  // A proxy's password is kept from the page too, and kept only for that proxy.
  const proxied = parse(kubeconfig('proxied', clusters.demo.url, clusters.demo.caPem)) as Config
  proxied.clusters[0]!.cluster['proxy-url'] = 'http://someone:hunter2@127.0.0.1:9'
  const add = (await page.evaluate(
    (text) => window.lumovi!.addedClusters!.add(text, { agreed: [] }),
    stringify(proxied),
  )) as { data: { path: string } }
  const proxiedText = await read(add.data.path)
  expect(proxiedText).not.toContain('hunter2')
  expect(proxiedText).toContain('someone:(kept%20by%20Lumovi)@127.0.0.1')
  const editProxied = (text: string) =>
    page.evaluate(
      ([file, text]) => window.lumovi!.addedClusters!.edit(file!, text!, []),
      [add.data.path, text],
    )
  const reproxied = parse(proxiedText) as Config
  reproxied.clusters[0]!.cluster['proxy-url'] = 'http://someone:(kept%20by%20Lumovi)@127.0.0.2:9'
  expect(await editProxied(stringify(reproxied))).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining('paste it again') },
  })
  // As it was, it keeps its password.
  expect(await editProxied(proxiedText)).toMatchObject({ ok: true })
  expect(readFileSync(add.data.path, 'utf8')).toContain('hunter2')
  standIn.close()
})

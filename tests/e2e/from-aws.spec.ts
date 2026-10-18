/**
 * Add a cluster → From AWS: EKS clusters found with the person's own `aws` CLI (a stand-in here,
 * on the login shell's PATH, that answers from what it's given and writes down each run), only
 * as they ask; each added as any other kubeconfig is, its command agreed to first.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEMO_TOKEN } from '../mock-cluster/kubeconfig.ts'
import type { Locator } from '@playwright/test'
import type { TestClusters } from '../mock-cluster/kubeconfig.ts'
import { clusterOption, expect, test } from './fixtures.ts'
import { holds } from '../holds.ts'

/** What a run of the stand-in was: its arguments, and the environment's profile and keys. */
interface Ran {
  args: string[]
  profile: string | null
  key: string | null
  pager: string | null
}

/**
 * A stand-in `aws` on the PATH a login shell gives: profiles default (eu-west-1, three clusters),
 * sso-dev and "sso team" (their SSO sign-in run out), nokeys (no credentials), odd (us-east-1, a
 * cluster whose name EKS wouldn't give), empty (no clusters) and garbled (an answer cut short);
 * region eu-nowhere-1 can't be reached. Each cluster is the demo one. With AWS_STANDIN_SET=rare,
 * it has profiles whose answers Lumovi won't use or can't read instead (none called default):
 * lone (no account, its clusters each described oddly), shy (no account, no list), twin, denied
 * (may not list), whoever (may not ask who it is), "no keys", huge (an answer over 4 MB), loud
 * (says over 4 MB of why) and mute (says nothing of why).
 */
function standIn(clusters: TestClusters): { shell: string; runs: () => Ran[] } {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-aws-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const log = join(dir, 'ran.jsonl')
  const script = join(dir, 'aws.mjs')
  writeFileSync(
    script,
    `import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
const env = process.env
appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  args,
  profile: env.AWS_PROFILE ?? null,
  key: env.AWS_ACCESS_KEY_ID ?? null,
  pager: env.AWS_PAGER ?? null,
}) + '\\n')
const at = (...words) => words.every((word, i) => args[i] === word)
const option = (name) => args[args.indexOf(name) + 1]
const say = (value) => {
  process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value))
  process.exit(0)
}
const fail = (text) => {
  process.stderr.write(text + '\\n')
  process.exit(255)
}
// (What's large goes out whole before the stand-in ends, however its pipe drains.)
const large = (stream, text, code) => {
  stream.write(text, () => process.exit(code))
  return new Promise(() => {})
}
const rare = env.AWS_STANDIN_SET === 'rare'
const profile = env.AWS_PROFILE ?? 'default'
if (at('configure', 'list-profiles')) say(env.AWS_STANDIN_NONE ? '' : rare ? 'lone\\nshy\\ntwin\\ndenied\\nwhoever\\nno keys\\nhuge\\nloud\\nmute\\n' : 'default\\nsso-dev\\nnokeys\\nodd\\nempty\\nsso team\\ngarbled\\n')
if (at('configure', 'get', 'region')) say({ default: 'eu-west-1', odd: 'us-east-1', empty: 'eu-west-1' }[profile] ?? '')
if (option('--region') === 'eu-nowhere-1') fail('Could not connect to the endpoint URL: \`https://sts.eu-nowhere-1.amazonaws.com/\` **now**')
if (profile === 'garbled' && at('sts', 'get-caller-identity')) say('{"Account": "111111111111", "Arn": ')
if (profile === 'sso-dev' || profile === 'sso team') fail('Error when retrieving token from sso: Token has expired and refresh failed')
if (profile === 'nokeys' || profile === 'no keys') fail('Unable to locate credentials. You can configure credentials by running "aws configure".')
if (profile === 'whoever' && at('sts')) fail('An error occurred (AccessDenied) when calling the GetCallerIdentity operation: not allowed')
if (profile === 'mute' && at('sts')) process.exit(255)
if (profile === 'loud' && at('sts')) await large(process.stderr, 'x'.repeat(5_000_000), 255)
const account = { odd: '222222222222', twin: '333333333333' }[profile] ?? '111111111111'
if (at('sts', 'get-caller-identity')) say(profile === 'lone' || profile === 'shy' ? { UserId: 'AIDA' } : { Account: account, Arn: 'arn:aws:iam::' + account + ':user/ada', UserId: 'AIDA' })
if (profile === 'denied' && at('eks', 'list-clusters')) fail('An error occurred (AccessDeniedException) when calling the ListClusters operation: User: arn:aws:iam::111111111111:user/ada is not authorized to perform: eks:ListClusters')
if (profile === 'huge' && at('eks', 'list-clusters')) await large(process.stdout, '{"clusters": [' + ' '.repeat(5_000_000) + '"api"]}', 0)
if (at('eks', 'list-clusters')) say(profile === 'shy' ? {} : { clusters: {
  odd: ['bad name!'],
  empty: [],
  lone: ['bare', 'plainhttp', 'noca', 'badca', 'noarn', 'weird', 'broken'],
  twin: ['noarn'],
}[profile] ?? ['api', 'jobs', 'web'] })
if (at('eks', 'describe-cluster')) {
  const name = option('--name')
  if (name === 'bare') say({})
  say({ cluster: {
    name,
    ...(name === 'noarn' ? {} : {
      arn: 'arn:aws:eks:' + option('--region') + ':' + account + ':cluster/' + name,
      version: '1.31',
      status: { jobs: 'UPDATING', web: 'CREATING', weird: 'WEIRD', broken: 'FAILED' }[name] ?? 'ACTIVE',
    }),
    endpoint: name === 'plainhttp' ? ${JSON.stringify(clusters.demo.url.replace(/^https:/, 'http:'))} : ${JSON.stringify(clusters.demo.url)},
    ...(name === 'noca' ? {} : {
      certificateAuthority: { data: name === 'badca' ? 'bm90IGEgY2VydGlmaWNhdGU=' : ${JSON.stringify(Buffer.from(clusters.demo.caPem!).toString('base64'))} },
    }),
  } })
}
if (args.includes('get-token')) say({
  apiVersion: 'client.authentication.k8s.io/v1beta1',
  kind: 'ExecCredential',
  status: { token: ${JSON.stringify(DEMO_TOKEN)} },
})
fail('aws: unknown: ' + args.join(' '))
`,
  )
  writeFileSync(
    join(bin, 'aws'),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`,
  )
  chmodSync(join(bin, 'aws'), 0o755)
  // A login shell whose profile puts the stand-in first on PATH, then runs what it's asked to.
  const shell = join(dir, 'fake-shell')
  writeFileSync(shell, `#!/bin/sh\nPATH="${bin}:$PATH"; export PATH; eval "$2"\n`)
  chmodSync(shell, 0o755)
  const runs = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as Ran)
      : []
  return { shell, runs }
}

/**
 * An editor's text as it holds it, from CodeMirror's own view (`cmTile`, as
 * create-form-written.spec.ts reads it): if that isn't there, or isn't this editor's, it fails
 * saying so.
 */
const held = (editor: Locator) =>
  editor.evaluate((content) => {
    const view = (
      content as unknown as {
        cmTile?: { view?: { contentDOM: Element; state: { doc: { toString(): string } } } }
      }
    ).cmTile?.view
    if (!view || view.contentDOM !== content) {
      throw new Error('The editor’s internals changed: read its text another way.')
    }
    return view.state.doc.toString()
  })

/** Keys of the environment's own, which must never sign in for the profile chosen. */
const KEYS = {
  AWS_ACCESS_KEY_ID: 'AKIAENVIRONMENTKEY',
  AWS_SECRET_ACCESS_KEY: 'environment-secret',
  AWS_SESSION_TOKEN: 'environment-session',
}

test('EKS clusters found with your aws, only when asked, by account; one added with its command agreed to, and nothing kept but it', async ({
  launch,
  clusters,
}) => {
  test.skip(process.platform === 'win32', 'A POSIX login shell gives aws its PATH')
  const aws = standIn(clusters)
  const userDataDir = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  const { page } = await launch({ userDataDir, env: { SHELL: aws.shell, ...KEYS } })
  await expect(clusterOption(page, 'demo')).toBeVisible()
  // Nothing at launch, nor on the clusters page.
  await holds(() => aws.runs().length === 0, 2_000, 'aws not run')

  await page.getByRole('button', { name: 'Add cluster' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'From AWS' }).click()
  await expect(dialog).toContainText(
    'Lumovi runs aws as you, with the profiles you tick from your AWS config. If a profile signs in through a program of its own (credential_process, say), that program runs too.',
  )
  expect(aws.runs()).toEqual([])
  await dialog.getByRole('button', { name: 'Find clusters' }).click()
  // Its profiles, the default one ticked, each in its own region where it has one; a region
  // only for a profile ticked.
  const profiles = dialog.getByRole('list', { name: 'Profiles' })
  await expect(profiles.getByRole('checkbox')).toHaveCount(7)
  await expect(profiles.getByRole('checkbox', { name: 'default' })).toBeChecked()
  await expect(dialog.getByLabel('Region for default')).toHaveValue('eu-west-1')
  await expect(dialog.getByLabel('Region for odd')).toHaveValue('us-east-1')
  await expect(dialog.getByLabel('Region for odd')).toBeDisabled()
  for (const profile of ['sso-dev', 'nokeys', 'odd', 'empty', 'sso team', 'garbled']) {
    await profiles.getByRole('checkbox', { name: profile }).check()
  }
  for (const profile of ['sso-dev', 'nokeys', 'sso team', 'garbled']) {
    await dialog.getByLabel(`Region for ${profile}`).fill('eu-west-1')
  }
  await dialog.getByLabel('Region for default').fill('eu-west-1, eu-nowhere-1')
  await dialog.getByRole('button', { name: 'Find clusters' }).click()

  // By account, each said in Lumovi's words: an active one as its version alone, another's state
  // in words; Add only where it can be.
  const found = dialog.getByRole('region', { name: 'AWS · default (111111111111) · eu-west-1' })
  const row = (name: string) => found.getByRole('listitem').filter({ hasText: name })
  await expect(found.getByRole('listitem')).toHaveCount(3)
  await expect(row('api')).toContainText('Kubernetes 1.31')
  await expect(found).not.toContainText('ACTIVE')
  await expect(row('jobs')).toContainText('Kubernetes 1.31·Updating')
  await expect(row('web')).toContainText('Being created')
  await expect(found.getByRole('button')).toHaveText(['Add', 'Add'])
  await expect(row('web').getByRole('button')).toHaveCount(0)
  await expect(dialog.getByRole('region', { name: 'AWS · sso-dev · eu-west-1' })).toContainText(
    'Its SSO sign-in has run out: run aws sso login --profile sso-dev in a terminal, then choose Find clusters again.',
  )
  // A profile whose name a pasted command couldn't hold as it is: said without a command.
  const team = dialog.getByRole('region', { name: 'AWS · sso team · eu-west-1' })
  await expect(team).toContainText(
    'Its SSO sign-in has run out: sign in again with aws sso login for this profile, then choose Find clusters again.',
  )
  await expect(team.getByRole('button')).toHaveCount(0)
  // An answer that isn't JSON, said so (never what the parser quotes of it).
  await expect(dialog.getByRole('region', { name: 'AWS · garbled · eu-west-1' })).toContainText(
    'aws’s answer wasn’t JSON.',
  )
  // aws's own words: nothing in them made code to copy, or bold.
  const nowhere = dialog.getByRole('region', { name: 'AWS · default · eu-nowhere-1' })
  await expect(nowhere).toContainText(
    'aws couldn’t: Could not connect to the endpoint URL: https://sts.eu-nowhere-1.amazonaws.com/ now',
  )
  await expect(nowhere.getByRole('button')).toHaveCount(0)
  await expect(dialog.getByRole('region', { name: 'AWS · nokeys · eu-west-1' })).toContainText(
    'This profile has no credentials. Set them up with aws configure --profile nokeys, then choose Find clusters again.',
  )
  await expect(
    dialog.getByRole('region', { name: 'AWS · empty (111111111111) · eu-west-1' }),
  ).toContainText('No EKS clusters in eu-west-1 for empty.')
  const odd = dialog.getByRole('region', { name: 'AWS · odd (222222222222) · us-east-1' })
  await expect(odd).toContainText(
    'Its name isn’t one EKS allows, so Lumovi won’t put it in a command.',
  )
  await expect(odd.getByRole('button')).toHaveCount(0)
  // Every run as the profile chosen, with none of the environment's keys, and nothing to page.
  const finding = aws.runs()
  expect(finding.filter((run) => run.key !== null)).toEqual([])
  expect(finding.filter((run) => run.pager !== '')).toEqual([])
  expect(
    finding
      .filter((run) => run.args[0] !== 'configure' || run.args[1] === 'get')
      .every((run) => run.profile !== null),
  ).toBe(true)
  // Read-only: nothing but who it is, what's there, and what each is.
  expect(new Set(finding.map((run) => run.args.slice(0, 2).join(' ')))).toEqual(
    new Set([
      'configure list-profiles',
      'configure get',
      'sts get-caller-identity',
      'eks list-clusters',
      'eks describe-cluster',
    ]),
  )

  // Added: its command shown with what's set, what's cleared for it said, and agreed to first.
  await row('api').getByRole('button', { name: 'Add api' }).click()
  await expect(dialog).toContainText('AWS · default (111111111111) · eu-west-1 · 1 context, api')
  await expect(dialog).toContainText('Signing in runs a program on this computer')
  await expect(dialog).toContainText(
    'Lumovi wrote this kubeconfig from what AWS said. Each time Lumovi connects with it, it runs the command below to sign in, as kubectl would.',
  )
  await expect(dialog).not.toContainText('Allow it only if you trust')
  await expect(dialog).toContainText(
    'AWS_PROFILE=default aws --region eu-west-1 eks get-token --cluster-name api --output json',
  )
  await expect(dialog).not.toContainText('AWS_ACCESS_KEY_ID=')
  await expect(dialog).toContainText(
    'Lumovi clears AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_SESSION_TOKEN for it, so the profile is what signs in.',
  )
  await dialog.getByRole('button', { name: 'Allow and continue' }).click()
  const ready = page.getByRole('dialog', { name: /^api is ready$/ })
  await expect(ready).toBeVisible()
  // Grouped under its account.
  await expect(ready.getByLabel('Group')).toHaveValue('AWS · default (111111111111) · eu-west-1')
  // Closed: back to what was found, the one added marked so, to add another.
  await ready.getByText('Close', { exact: true }).click()
  await expect(row('api')).toContainText('Added')
  await expect(row('api').getByRole('button')).toHaveCount(0)
  await row('jobs').getByRole('button', { name: 'Add jobs' }).click()
  await dialog.getByRole('button', { name: 'Allow and continue' }).click()
  await page
    .getByRole('dialog', { name: /^jobs is ready$/ })
    .getByRole('button', { name: 'Open jobs' })
    .click()
  await expect(page.getByRole('button', { name: 'Switch cluster' })).toContainText('jobs')
  // Each signed in as the profile, the environment's keys out of the way.
  const signedIn = aws.runs().filter((run) => run.args.includes('get-token'))
  expect(signedIn.length).toBeGreaterThan(0)
  expect(signedIn.every((run) => run.profile === 'default' && run.key === '')).toBe(true)

  // Kept: those added alone, with their command and no credential; the account in their groups.
  const folder = join(realpathSync(userDataDir), 'clusters')
  const kept = readdirSync(folder).sort()
  expect(kept).toHaveLength(2)
  for (const file of kept) {
    const text = readFileSync(join(folder, file), 'utf8')
    expect(text).toContain('get-token')
    for (const secret of [DEMO_TOKEN, ...Object.values(KEYS), '111111111111']) {
      expect(text).not.toContain(secret)
    }
  }
  const settings = readFileSync(join(userDataDir, 'settings.json'), 'utf8')
  expect(settings.split('111111111111')).toHaveLength(3)
  expect(settings.match(/"group":\s*"AWS · default \(111111111111\) · eu-west-1"/g)).toHaveLength(2)
})

test('a kubeconfig from AWS, edited, is a pasted one: its consent asks for trust, and no AWS group is offered', async ({
  launch,
  clusters,
}) => {
  test.skip(process.platform === 'win32', 'A POSIX login shell gives aws its PATH')
  const aws = standIn(clusters)
  const { page } = await launch({ env: { SHELL: aws.shell } })
  await page.getByRole('button', { name: 'Add cluster' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'From AWS' }).click()
  await dialog.getByRole('button', { name: 'Find clusters' }).click()
  await expect(dialog.getByLabel('Region for default')).toHaveValue('eu-west-1')
  await dialog.getByRole('button', { name: 'Find clusters' }).click()
  await dialog.getByRole('button', { name: 'Add api' }).click()
  await expect(dialog).toContainText('Lumovi wrote this kubeconfig from what AWS said.')

  // Edited: back to what was found, then to its text, one argument changed.
  await dialog.getByRole('button', { name: 'Edit', exact: true }).click()
  await dialog
    .getByRole('group', { name: 'From' })
    .getByRole('button', { name: 'Paste', exact: true })
    .click()
  // The whole text put back with one argument changed: by keys, never where a line is drawn.
  const field = dialog.getByRole('textbox', { name: 'Kubeconfig' })
  const given = await held(field)
  const changed = given.replace(/^(\s*- )json$/m, '$1text')
  expect(changed).not.toBe(given)
  await field.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText(changed)
  await expect.poll(() => held(field)).toBe(changed)
  await dialog.getByRole('button', { name: 'Check it' }).click()

  await expect(dialog).toContainText('Pasted · 1 context, api')
  await expect(dialog).toContainText(
    'AWS_PROFILE=default aws --region eu-west-1 eks get-token --cluster-name api --output text',
  )
  await expect(dialog).toContainText('Allow it only if you trust where the kubeconfig came from.')
  await expect(dialog).not.toContainText('Lumovi wrote')
  await expect(dialog).toContainText(
    'Lumovi clears AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_SESSION_TOKEN for it.',
  )
  await expect(dialog).not.toContainText('so the profile is what signs in')
  await dialog.getByRole('button', { name: 'Allow and continue' }).click()
  const ready = page.getByRole('dialog', { name: /^api is ready$/ })
  await expect(ready).toBeVisible()
  await expect(ready.getByLabel('Group')).toHaveValue('')
})

test('what aws gives that Lumovi won’t use, or can’t read, is said so; only a cluster it can add has Add, and nothing runs for a name aws wouldn’t give', async ({
  launch,
  clusters,
}) => {
  test.skip(process.platform === 'win32', 'A POSIX login shell gives aws its PATH')
  const aws = standIn(clusters)
  const { page } = await launch({ env: { SHELL: aws.shell, AWS_STANDIN_SET: 'rare' } })
  await page.getByRole('button', { name: 'Add cluster' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'From AWS' }).click()
  await dialog.getByRole('button', { name: 'Find clusters' }).click()
  // No profile called default: the first one is ticked.
  const profiles = dialog.getByRole('list', { name: 'Profiles' })
  await expect(profiles.getByRole('checkbox', { name: 'lone' })).toBeChecked()
  // Nothing ticked, or no region to look in: nothing to find.
  await profiles.getByRole('checkbox', { name: 'lone' }).uncheck()
  await profiles.getByRole('checkbox', { name: 'shy' }).check()
  await dialog.getByRole('button', { name: 'Find clusters' }).click()
  await expect(dialog).toContainText('Tick a profile, with a region to look in.')
  const names = ['lone', 'shy', 'twin', 'denied', 'whoever', 'no keys', 'huge', 'loud', 'mute']
  for (const profile of names) {
    await profiles.getByRole('checkbox', { name: profile }).check()
    await dialog.getByLabel(`Region for ${profile}`).fill('eu-west-1')
  }
  await dialog.getByLabel('Region for lone').fill('eu-west-1 nowhere')
  await dialog.getByRole('button', { name: 'Find clusters' }).click()

  // Each cluster as EKS described it: without an https address or a certificate authority it
  // can't be added; a state Lumovi doesn't know isn't one to add; one that failed says so.
  const lone = dialog.getByRole('region', { name: 'AWS · lone · eu-west-1' })
  const row = (name: string) => lone.getByRole('listitem').filter({ hasText: name })
  await expect(lone.getByRole('listitem')).toHaveCount(7)
  await expect(row('bare')).toContainText('EKS gave no https address for it.')
  await expect(row('plainhttp')).toContainText('EKS gave no https address for it.')
  await expect(row('noca')).toContainText('EKS gave no certificate authority for it.')
  await expect(row('badca')).toContainText('EKS gave no certificate authority for it.')
  await expect(row('weird')).toHaveText('weirdKubernetes 1.31')
  await expect(row('broken')).toContainText('Kubernetes 1.31·Failed')
  // Said of nothing but its name, it's still one to add.
  await expect(row('noarn')).toHaveText('noarnAdd')
  await expect(lone.getByRole('button')).toHaveText(['Add'])
  await expect(dialog.getByRole('region', { name: 'AWS · lone · nowhere' })).toContainText(
    'nowhere isn’t a region.',
  )
  await expect(dialog.getByRole('region', { name: 'AWS · shy · eu-west-1' })).toContainText(
    'No EKS clusters in eu-west-1 for shy.',
  )
  await expect(
    dialog
      .getByRole('region', { name: 'AWS · twin (333333333333) · eu-west-1' })
      .getByRole('button'),
  ).toHaveText(['Add'])
  // Why not, each in Lumovi's words where it knows the case, else aws's first line, cut short.
  await expect(
    dialog.getByRole('region', { name: 'AWS · denied (111111111111) · eu-west-1' }),
  ).toContainText('This profile may not list clusters in eu-west-1 (it needs eks:ListClusters).')
  await expect(dialog.getByRole('region', { name: 'AWS · whoever · eu-west-1' })).toContainText(
    'aws couldn’t: An error occurred (AccessDenied) when calling the GetCallerIdentity operation: not allowed',
  )
  const noKeys = dialog.getByRole('region', { name: 'AWS · no keys · eu-west-1' })
  await expect(noKeys).toContainText(
    'This profile has no credentials. Set them up with aws configure for this profile, then choose Find clusters again.',
  )
  await expect(noKeys.getByRole('button')).toHaveCount(0)
  await expect(
    dialog.getByRole('region', { name: 'AWS · huge (111111111111) · eu-west-1' }),
  ).toContainText('aws’s answer wasn’t JSON.')
  const loud = dialog.getByRole('region', { name: 'AWS · loud · eu-west-1' })
  await expect(loud).toContainText(`aws couldn’t: ${'x'.repeat(200)}`)
  await expect(loud).not.toContainText('x'.repeat(201))
  await expect(dialog.getByRole('region', { name: 'AWS · mute · eu-west-1' })).toContainText(
    'aws couldn’t: it failed',
  )

  // Asked of the app itself: a name aws wouldn't list runs nothing, and asks that aren't
  // profiles with their regions (or too many at once) are refused.
  const ran = aws.runs().length
  const find = (asks: unknown) =>
    page.evaluate((asks) => window.lumovi!.addedClusters!.awsFind(asks as never), asks)
  expect(
    await find([
      { profile: 'a=b', regions: ['eu-west-1'] },
      { profile: '', regions: ['eu-west-1'] },
    ]),
  ).toEqual({ ok: true, data: [] })
  for (const asks of [
    'lone',
    Array.from({ length: 21 }, () => ({ profile: 'lone', regions: [] })),
    [null],
    ['lone'],
    [{ profile: 7, regions: [] }],
    [{ profile: 'lone', regions: 'eu-west-1' }],
    [{ profile: 'lone', regions: Array.from({ length: 21 }, () => 'eu-west-1') }],
  ]) {
    await expect(find(asks)).rejects.toThrow('asks must be profiles, each with its regions')
  }
  expect(aws.runs()).toHaveLength(ran)
})

test('where the organization keeps Lumovi to its kubeconfig, there’s no From AWS, and aws never runs', async ({
  launch,
  clusters,
}) => {
  test.skip(process.platform === 'win32', 'A POSIX login shell gives aws its PATH')
  const aws = standIn(clusters)
  const policy = join(mkdtempSync(join(tmpdir(), 'lumovi-policy-')), 'policy.json')
  writeFileSync(policy, JSON.stringify({ kubeconfigFiles: 'locked' }))
  const { page } = await launch({ env: { SHELL: aws.shell, LUMOVI_POLICY: policy } })
  await expect(page.getByRole('button', { name: 'Managed' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add cluster' })).toHaveCount(0)
  // Asked of the app itself, it's refused before aws is run.
  const refused = { ok: false, error: { code: 'not-allowed' } }
  expect(await page.evaluate(() => window.lumovi!.addedClusters!.awsProfiles())).toMatchObject(
    refused,
  )
  expect(
    await page.evaluate(() =>
      window.lumovi!.addedClusters!.awsFind([{ profile: 'default', regions: ['eu-west-1'] }]),
    ),
  ).toMatchObject(refused)
  expect(aws.runs()).toEqual([])
})

test('with no profiles, it says how to set one up', async ({ launch, clusters }) => {
  test.skip(process.platform === 'win32', 'A POSIX login shell gives aws its PATH')
  const aws = standIn(clusters)
  const { page } = await launch({ env: { SHELL: aws.shell, AWS_STANDIN_NONE: '1' } })
  await page.getByRole('button', { name: 'Add cluster' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'From AWS' }).click()
  await dialog.getByRole('button', { name: 'Find clusters' }).click()
  await expect(dialog).toContainText(
    'aws has no profiles. Set one up with aws configure (or aws configure sso), then choose Find clusters again.',
  )
  await expect(
    dialog.getByRole('button', { name: 'Copy aws configure', exact: true }),
  ).toBeVisible()
  await expect(dialog.getByRole('list', { name: 'Profiles' })).toHaveCount(0)
})

test('a pasted kubeconfig’s cleared variables are said under its command, not shown as empty', async ({
  launch,
  clusters,
}) => {
  const { page } = await launch()
  await page.getByRole('button', { name: 'Add cluster' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('.cm-content').click()
  await page.keyboard.insertText(
    JSON.stringify({
      apiVersion: 'v1',
      kind: 'Config',
      clusters: [
        {
          name: 'c',
          cluster: {
            server: clusters.demo.url,
            'certificate-authority-data': Buffer.from(clusters.demo.caPem!).toString('base64'),
          },
        },
      ],
      users: [
        {
          name: 'u',
          user: {
            exec: {
              apiVersion: 'client.authentication.k8s.io/v1beta1',
              command: 'get-a-token',
              env: [
                { name: 'CLEARED_ONE', value: '' },
                { name: 'SET_ONE', value: 'x' },
              ],
            },
          },
        },
      ],
      contexts: [{ name: 'pasted', context: { cluster: 'c', user: 'u' } }],
    }),
  )
  await dialog.getByRole('button', { name: 'Check it' }).click()
  await expect(dialog).toContainText('Signing in runs a program on this computer')
  await expect(dialog).toContainText('SET_ONE=x get-a-token')
  await expect(dialog).not.toContainText('CLEARED_ONE=')
  await expect(dialog).toContainText('Lumovi clears CLEARED_ONE for it.')
  await expect(dialog).toContainText('Allow it only if you trust where the kubeconfig came from.')
})

test('without aws on the PATH, it says so', async ({ launch }) => {
  test.skip(process.platform === 'win32', 'A POSIX login shell gives aws its PATH')
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-aws-'))
  const shell = join(dir, 'fake-shell')
  writeFileSync(shell, `#!/bin/sh\nPATH="/nowhere"; export PATH; eval "$2"\n`)
  chmodSync(shell, 0o755)
  const { page } = await launch({ env: { SHELL: shell } })
  await page.getByRole('button', { name: 'Add cluster' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'From AWS' }).click()
  await dialog.getByRole('button', { name: 'Find clusters' }).click()
  await expect(dialog).toContainText(
    'Lumovi needs the aws command (AWS CLI v2), and this computer doesn’t have it.',
  )
  await expect(dialog.getByRole('button', { name: 'How to set it up' })).toBeVisible()
})

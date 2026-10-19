/**
 * How the Plugins page asks for Lumovi-plugins' latest release (src/main/plugin-store.ts): of
 * GitHub alone, following only its own redirects, once at a time, kept ten minutes unless Check
 * now asks again, and never past the time a file may take. Signed by the tests' stand-in for
 * Sigstore (tests/mock-downloads/sigstore.ts), with the release workflow's real identity. What
 * the page shows of it is plugin-store.spec.ts's, in the e2e tests.
 */
import { expect, test } from '../temp-folders.ts'
import { PluginStore, type StoreOptions } from '../../src/main/plugin-store.ts'
import { PLUGINS_REPOSITORY, PLUGINS_SIGNER, type Trust } from '../../src/main/plugins-release.ts'
import type { TrustRoot } from '../../src/main/kubectl-signature.ts'
import { makeRelease, refsAnswer, type MadeRelease } from '../mock-downloads/plugin-store.ts'
import { startMockSigstore, type MockSigstore } from '../mock-downloads/sigstore.ts'

const PLUGIN = (name: string, version: string) => ({
  name,
  version,
  text: `apiVersion: lumovi.dev/v1beta1\nkind: Plugin\nmetadata: { name: ${name} }\n`,
})

let sigstore: MockSigstore
let trust: Trust
let latest: MadeRelease
test.beforeAll(async () => {
  sigstore = await startMockSigstore()
  trust = {
    root: sigstore.root as TrustRoot,
    signer: PLUGINS_SIGNER,
    repository: PLUGINS_REPOSITORY,
  }
  latest = await makeRelease(sigstore, {
    version: '1.3.0',
    serial: 5,
    plugins: [PLUGIN('alpha', '1.1.0'), PLUGIN('beta', '1.0.0')],
  })
})

const GITHUB = 'https://github.com'
const PLUGINS = `${GITHUB}/${PLUGINS_REPOSITORY}`

/**
 * GitHub, as the store asks it, with `served` as its latest release: its redirect to the latest
 * tag, git's refs, and each file, sent on to `assets` (GitHub's own host, by default). Each URL
 * asked is written to `asked`.
 */
function github({
  asked = [],
  assets = 'https://release-assets.githubusercontent.com/github-production-release-asset',
  hold = false,
  served,
}: {
  asked?: string[]
  assets?: string
  hold?: boolean
  served?: MadeRelease
} = {}): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    const release = served ?? latest
    asked.push(url)
    if (hold) {
      // Never answers: until the time it may take is up.
      return new Promise((_, fail) =>
        init?.signal?.addEventListener('abort', () => fail(init.signal!.reason)),
      )
    }
    if (url === `${PLUGINS}/releases/latest`) {
      return new Response(null, {
        status: 302,
        headers: { location: `${PLUGINS}/releases/tag/v${release.version}` },
      })
    }
    if (url === `${PLUGINS}.git/info/refs?service=git-upload-pack`) {
      return new Response(refsAnswer(release.version, release.commit))
    }
    const name = url.slice(url.lastIndexOf('/') + 1)
    if (url === `${PLUGINS}/releases/download/v${release.version}/${name}`) {
      return new Response(null, { status: 302, headers: { location: `${assets}/${name}` } })
    }
    if (url.startsWith(`${assets}/`) && release.files[name]) {
      return new Response(new Uint8Array(release.files[name]))
    }
    return new Response('Not Found', { status: 404 })
  }) as typeof fetch
}

/** A store asking `download`, with nothing taken yet. */
function store(options: Partial<StoreOptions> = {}): { store: PluginStore; taken: number[] } {
  const taken: number[] = []
  return {
    taken,
    store: new PluginStore({
      trust,
      off: () => false,
      builtWith: { version: '1.2.0', serial: 4 },
      serial: () => taken.at(-1) ?? 0,
      accept: (serial) => taken.push(serial),
      download: github(),
      ...options,
    }),
  }
}

test('the latest release, checked: its plugins, and its serial taken', async () => {
  const asked: string[] = []
  const { store: made, taken } = store({ download: github({ asked }) })
  const check = await made.check()
  expect(check).toMatchObject({
    state: 'checked',
    release: {
      version: '1.3.0',
      serial: 5,
      plugins: [
        { name: 'alpha', version: '1.1.0', code: false },
        { name: 'beta', version: '1.0.0', code: false },
      ],
    },
  })
  expect(taken).toEqual([5])
  // The tag's redirect, git's refs, and five files, each sent on to where GitHub keeps them.
  expect(asked).toHaveLength(2 + 5 * 2)
})

test('only GitHub, and only the redirects to its own hosts', async () => {
  for (const [assets, why] of [
    ['https://elsewhere.example/assets', 'elsewhere.example isn’t GitHub’s'],
    // (Its own host, but not over HTTPS.)
    [
      'http://release-assets.githubusercontent.com/assets',
      'release-assets.githubusercontent.com isn’t GitHub’s',
    ],
  ] as const) {
    const asked: string[] = []
    const check = await store({ download: github({ asked, assets }) }).store.check()
    expect(check).toMatchObject({ state: 'failed', failure: { check: 'network', words: why } })
    expect(asked.some((url) => url.startsWith(assets))).toBe(false)
  }
  // GitHub's other host for a release's files.
  const other = store({
    download: github({ assets: 'https://objects.githubusercontent.com/assets' }),
  })
  expect((await other.store.check()).state).toBe('checked')
})

test('one check at a time, kept ten minutes unless Check now asks again', async () => {
  const asked: string[] = []
  let now = Date.now()
  const { store: made } = store({ download: github({ asked }), now: () => now })
  const [first, second] = await Promise.all([made.check(), made.check()])
  expect(second).toBe(first)
  const once = asked.length
  now += 9 * 60_000
  expect(await made.check()).toBe(first)
  expect(asked).toHaveLength(once)
  // Check now: asked again.
  await made.check(true)
  expect(asked).toHaveLength(2 * once)
  now += 11 * 60_000
  await made.check()
  expect(asked).toHaveLength(3 * once)
})

test('off by the organization’s policy, nothing is asked', async () => {
  const asked: string[] = []
  const { store: made } = store({ download: github({ asked }), off: () => true })
  expect(await made.check(true)).toEqual({ state: 'off' })
  expect(asked).toEqual([])
})

test('a GitHub that doesn’t answer is given up on, saying so, and what was found before stays', async () => {
  let hold = false
  const answering = github()
  const holding = github({ hold: true })
  const { store: made } = store({
    download: ((input: string, init?: RequestInit) =>
      (hold ? holding : answering)(input, init)) as typeof fetch,
    timeLimit: 100,
  })
  const good = await made.check()
  hold = true
  const late = await made.check(true)
  expect(late).toMatchObject({
    state: 'failed',
    failure: { check: 'network', words: 'GitHub didn’t answer in 0.1 seconds' },
  })
  expect(late.state === 'failed' && late.last).toEqual(good.state === 'checked' && good.release)
})

test('only the plugins the organization’s policy allows', async () => {
  const { store: made } = store({ allowed: () => ['beta'] })
  const check = await made.check()
  expect(check.state === 'checked' && check.release.plugins.map(({ name }) => name)).toEqual([
    'beta',
  ])
})

test('never older than the release Lumovi was built with', async () => {
  const { store: made, taken } = store({ builtWith: { version: '1.4.0', serial: 6 } })
  expect(await made.check()).toMatchObject({ state: 'failed', failure: { check: 'older' } })
  expect(taken).toEqual([])
})

test('an index past the date it says it expires is refused, saying when, and nothing is taken', async () => {
  const expired = await makeRelease(sigstore, {
    version: '1.3.0',
    serial: 5,
    expires: '2025-10-01T12:00:00.000Z',
    plugins: [PLUGIN('alpha', '1.1.0')],
  })
  const { store: made, taken } = store({ download: github({ served: expired }) })
  expect(await made.check()).toMatchObject({
    state: 'failed',
    failure: { check: 'expired', on: '2025-10-01T12:00:00.000Z' },
  })
  expect(taken).toEqual([])
})

test('never older than one already taken; the same one is taken again', async () => {
  const later = store({ serial: () => 6 })
  expect(await later.store.check()).toMatchObject({ state: 'failed', failure: { check: 'older' } })
  expect(later.taken).toEqual([])
  const same = store({ serial: () => 5 })
  expect((await same.store.check()).state).toBe('checked')
  expect(same.taken).toEqual([5])
})

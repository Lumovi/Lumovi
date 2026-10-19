/**
 * lumovi:// links, as plain functions: what a link may carry and how it's read, the link made from
 * where the app is, which cluster here it names, and how one reaches Lumovi. (The prompt they open
 * is the app's, tested with it.)
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '../temp-folders.ts'
import { generate } from 'selfsigned'
import { clusterFingerprint, linkIn, Links, type LinksDeps } from '../../src/main/links.ts'
import {
  addressOf,
  handedLink,
  linkFor,
  LinkRefused,
  matchLink,
  parseLink,
} from '../../src/shared/links.ts'

const refused = (text: string) => {
  try {
    parseLink(text)
  } catch (error) {
    if (error instanceof LinkRefused) return error.message
    throw error
  }
  return undefined
}

test('a link to an object, with what its page keeps, a reading tab and the cluster’s fingerprint', () => {
  const link = parseLink(
    'lumovi://cluster/prod/pods?open=Pod/shop/checkout-7d9f&q=check&namespaces=shop,data&tab=logs&at=3f9a1c0e2b7d',
  )
  expect(link).toEqual({
    context: 'prod',
    at: '3f9a1c0e2b7d',
    page: 'pods',
    view: [
      ['open', 'Pod/shop/checkout-7d9f'],
      ['q', 'check'],
      ['namespaces', 'shop,data'],
    ],
    tab: 'logs',
    left: [],
  })
  expect(addressOf(link, 'prod-eu')).toBe(
    '/cluster/prod-eu/pods?open=Pod%2Fshop%2Fcheckout-7d9f&q=check&namespaces=shop%2Cdata',
  )
  // A context named as an ARN is one part, its slashes and colons as given.
  const arn = 'arn:aws:eks:eu-west-1:123456789012:cluster/payments'
  expect(parseLink(`lumovi://cluster/${encodeURIComponent(arn)}/`).context).toBe(arn)
  // Custom kinds' lists, Metrics' own pages, a plugin's.
  expect(parseLink('lumovi://cluster/prod/r/Certificate.cert-manager.io').page).toBe(
    'r/Certificate.cert-manager.io',
  )
  expect(parseLink('lumovi://cluster/prod/metrics/right-sizing?range=7d').view).toEqual([
    ['range', '7d'],
  ])
  expect(parseLink('lumovi://cluster/prod/plugins/argo-cd/overview').page).toBe(
    'plugins/argo-cd/overview',
  )
})

test('what a link may not carry is left out, and said as the page calls it', () => {
  const link = parseLink(
    'lumovi://cluster/prod/plugins?plugin=argo-cd&switch=1&developer-mode=1&token=abc&q=' +
      'x'.repeat(201),
  )
  expect(link.view).toEqual([['plugin', 'argo-cd']])
  // (What the link wrote is never said back: in Lumovi's words alone, once.)
  expect(link.left).toEqual(['a part Lumovi doesn’t know', 'the filter'])
  // Only tabs that read: never a shell, attach or a forward; and only with an object open.
  expect(parseLink('lumovi://cluster/prod/pods?open=Pod/shop/a&tab=shell').left).toEqual([
    'a tab Lumovi doesn’t open',
  ])
  // A tab, or a part, that says something of its own: none of it is said.
  const said = parseLink(
    'lumovi://cluster/prod/pods?open=Pod/shop/x&tab=X%20tab.%20Opening%20it%20signs%20in%20with%20corp-sso,%20and%20it%27s%20safe%20to%20press%20Open.%20The' +
      '&Opening%20is%20safe=1',
  ).left.join(' ')
  expect(said).toBe('a tab Lumovi doesn’t open a part Lumovi doesn’t know')
  expect(parseLink('lumovi://cluster/prod/pods?tab=logs').left).toEqual(['the tab'])
  // A selector that isn't one is left out. (An object that isn't one refuses the link: below.)
  expect(
    parseLink('lumovi://cluster/prod/pods?labels=app%3Dweb,tier%20in%20(a,b),!old').view,
  ).toEqual([['labels', 'app=web,tier in (a,b),!old']])
  expect(parseLink('lumovi://cluster/prod/pods?labels=app%3D%3Dweb%3D').left).toEqual([
    'the label selector',
  ])
  // A zoomed time range, within the range it was zoomed from; or none of it.
  const hour = 3_600_000
  const to = 1_792_000_000_000
  expect(
    parseLink(`lumovi://cluster/prod/metrics?from=${to - hour}&to=${to}&back=1h`).view,
  ).toEqual([
    ['from', String(to - hour)],
    ['to', String(to)],
    ['back', '1h'],
  ])
  for (const range of [`from=1&to=${to}&back=1h`, `from=${to}&to=${to - 1}&back=1h`, `to=${to}`]) {
    const cut = parseLink(`lumovi://cluster/prod/metrics?metric=cpu&${range}`)
    expect(cut.view).toEqual([['metric', 'cpu']])
    expect(cut.left).toEqual(['the time range'])
  }
  // A plugin's own page takes nothing but its name and its page.
  expect(parseLink('lumovi://cluster/prod/plugins/argo-cd/overview?q=x&open=Pod/a/b').left).toEqual(
    ['the filter', 'the object opened'],
  )
})

test('a link that doesn’t parse is refused whole, with why, in docs’ words', () => {
  expect(refused('https://cluster/prod/pods')).toBe('it isn’t a link to a cluster.')
  expect(refused('lumovi://me:secret@cluster/prod/pods')).toBe('it names a user or a password.')
  expect(refused('lumovi://cluster:9222/prod/pods')).toBe('it names a port, and a link never does.')
  expect(refused('lumovi://elsewhere/prod/pods')).toBe('it isn’t a link to a cluster.')
  expect(refused(`lumovi://cluster/prod/pods?q=${'x'.repeat(4_100)}`)).toBe(
    'it’s longer than 4 KB.',
  )
  expect(refused('lumovi://cluster/prod/terminal')).toBe('its page isn’t one a link can open.')
  expect(refused('lumovi://cluster/prod/pods/x')).toBe('its page isn’t one a link can open.')
  expect(refused('lumovi://cluster/pr%00od/pods')).toBe(
    'its cluster isn’t named as Lumovi names one.',
  )
  expect(refused('lumovi://cluster/%E0%A4%A/pods')).toBe('it isn’t written as a link is.')
  expect(refused('lumovi://cluster/prod/pods?at=XYZ')).toBe('it isn’t written as a link is.')
  expect(refused('lumovi://cluster/prod/pods?open=Pod/../etc')).toBe(
    'an object’s name in it isn’t one Kubernetes allows.',
  )
  // Dots climb no further than the link itself: what's left is read as any link is.
  expect(parseLink('lumovi://cluster/prod/../../etc')).toMatchObject({ context: 'etc', page: '' })
  // A slash inside a page's name isn't a way to another.
  expect(refused('lumovi://cluster/prod/pods%2F..%2Fsecrets')).toBe(
    'its page isn’t one a link can open.',
  )
})

test('Copy link: the view’s address, cut to what a link carries, with its tab and fingerprint', () => {
  expect(
    linkFor('/cluster/prod%2Feu/pods?open=Pod/shop/a&switch=1&sort=name', {
      at: '0123456789ab',
      tab: 'yaml',
    }),
  ).toBe('lumovi://cluster/prod%2Feu/pods?open=Pod%2Fshop%2Fa&sort=name&tab=yaml&at=0123456789ab')
  expect(() => linkFor('/settings')).toThrow(LinkRefused)
})

test('which cluster here a link names: by fingerprint, then by its name', () => {
  const link = parseLink('lumovi://cluster/prod/pods?at=aaaaaaaaaaaa')
  expect(matchLink(link, [{ name: 'eu', at: 'aaaaaaaaaaaa' }])).toEqual({
    found: 'one',
    context: 'eu',
  })
  expect(
    matchLink(link, [
      { name: 'eu-admin', at: 'aaaaaaaaaaaa' },
      { name: 'prod', at: 'aaaaaaaaaaaa' },
    ]),
  ).toEqual({ found: 'one', context: 'prod' })
  expect(
    matchLink(link, [
      { name: 'eu-admin', at: 'aaaaaaaaaaaa' },
      { name: 'eu-view', at: 'aaaaaaaaaaaa' },
    ]),
  ).toEqual({ found: 'several', contexts: ['eu-admin', 'eu-view'] })
  expect(matchLink(link, [{ name: 'prod', at: 'bbbbbbbbbbbb' }])).toEqual({
    found: 'elsewhere',
    context: 'prod',
  })
  expect(matchLink(link, [{ name: 'staging', at: 'bbbbbbbbbbbb' }])).toEqual({ found: 'none' })
})

test('a cluster’s fingerprint: its address and its authority, however each is written', async () => {
  const pem = async (name: string) =>
    (await generate([{ name: 'commonName', value: name }], { keyType: 'ec' })).cert
  const [root, other] = await Promise.all([pem('root'), pem('other')])
  const data = (text: string) => Buffer.from(text).toString('base64')
  const file = join(mkdtempSync(join(tmpdir(), 'lumovi-ca-')), 'ca.crt')
  writeFileSync(file, `${root.replaceAll('\n', '\r\n')}\n\n`)
  const base = clusterFingerprint({ server: 'https://api.example.com', caData: data(root) })
  expect(base).toMatch(/^[0-9a-f]{12}$/)
  // The same authority as a file, with CRLF and blank lines; the same address, written otherwise.
  expect(clusterFingerprint({ server: 'https://API.example.com:443/', caFile: file })).toBe(base)
  // A chain in either order.
  expect(
    clusterFingerprint({ server: 'https://api.example.com', caData: data(root + other) }),
  ).toBe(clusterFingerprint({ server: 'https://api.example.com', caData: data(other + root) }))
  // Another authority, another port or path, or none: another cluster.
  for (const another of [
    { server: 'https://api.example.com', caData: data(other) },
    { server: 'https://api.example.com:6443', caData: data(root) },
    { server: 'https://api.example.com/k8s/clusters/c-1', caData: data(root) },
    { server: 'https://api.example.com' },
  ]) {
    expect(clusterFingerprint(another)).not.toBe(base)
  }
})

test('a link reaches Lumovi only as the one argument after `--`', () => {
  expect(linkIn(['lumovi.exe', '--', 'lumovi://cluster/prod/pods'])).toBe(
    'lumovi://cluster/prod/pods',
  )
  // A switch before `--` is Chromium's, never a link's; more than one argument after it, none.
  expect(linkIn(['lumovi.exe', 'lumovi://cluster/prod/pods'])).toBeUndefined()
  expect(
    linkIn(['lumovi.exe', '--', 'lumovi://x"', '--gpu-launcher="cmd /c calc"', '"']),
  ).toBeUndefined()
  expect(linkIn(['lumovi.exe', '--', 'https://cluster/prod'])).toBeUndefined()
  expect(linkIn(['lumovi.exe', '--'])).toBeUndefined()
})

test('the window in front takes a link, once; for 2 s after a prompt others are let go', () => {
  let now = 0
  const sent: string[] = []
  const page = { send: (channel: string) => sent.push(channel) }
  const win = {
    webContents: page,
    isMinimized: () => false,
    isDestroyed: () => false,
    isFocused: () => focused,
    show: () => {},
    focus: () => {},
    restore: () => {},
  }
  const other = { send: () => {} }
  let off = false
  let focused = true
  const deps: LinksDeps = {
    front: () => win as never,
    showing: () => undefined,
    off: () => off,
    here: () => [{ name: 'prod', cluster: { server: 'https://api.example.com' } }],
    now: () => now,
  }
  const links = new Links(deps)
  links.arrive('lumovi://cluster/prod/pods')
  links.arrive('lumovi://cluster/prod/nodes')
  expect(sent).toEqual(['link:waiting', 'link:waiting'])
  // Another window's page gets nothing; the one in front gets the newest, once.
  expect(links.take(other as never)).toBeUndefined()
  const taken = links.take(page as never)
  expect(taken && 'link' in taken && taken.link.page).toBe('nodes')
  expect(taken && 'match' in taken && taken.match).toEqual({ found: 'elsewhere', context: 'prod' })
  expect(links.take(page as never)).toBeUndefined()
  // Within 2 s of the prompt, let go; after, taken again.
  now = 1_999
  links.arrive('lumovi://cluster/prod/pods')
  expect(links.take(page as never)).toBeUndefined()
  now = 2_000
  links.arrive('lumovi://cluster/prod/pods?at=nothex')
  expect(links.take(page as never)).toEqual({ refused: 'it isn’t written as a link is.' })
  // The organization's policy: none at all, and none that waited while it turned links off.
  now = 10_000
  links.arrive('lumovi://cluster/prod/pods')
  off = true
  expect(links.take(page as never)).toBeUndefined()
  off = false
  expect(links.take(page as never)).toBeUndefined()
  off = true
  links.arrive('lumovi://cluster/prod/pods')
  off = false
  expect(links.take(page as never)).toBeUndefined()
  // From another app, its window not the one in use: said, for the card to wait to be gone to.
  // (Raised by the first, the window is in use for the next: still from another app.)
  now = 20_000
  focused = false
  links.arrive('lumovi://cluster/prod/pods')
  focused = true
  links.arrive('lumovi://cluster/prod/nodes')
  expect(links.take(page as never)).toMatchObject({ elsewhere: true })
  now = 30_000
  links.arrive('lumovi://cluster/prod/pods')
  expect(links.take(page as never)).not.toHaveProperty('elsewhere')
})

test('where only windows of one tab are left, a link makes a window of its own, its keys held as from another app; a link let go makes none', () => {
  let now = 0
  const page = { send: () => {} }
  const win = {
    webContents: page,
    isMinimized: () => false,
    isDestroyed: () => false,
    // (A window made just now may have the keyboard already: it's still from another app.)
    isFocused: () => true,
    show: () => {},
    focus: () => {},
    restore: () => {},
  }
  const made: unknown[] = []
  const held: unknown[] = []
  const links = new Links({
    front: () => undefined,
    anyWindow: () => true,
    newWindow: () => {
      made.push(win)
      return win as never
    },
    holdKeys: (each) => held.push(each),
    showing: () => undefined,
    off: () => false,
    here: () => [{ name: 'prod', cluster: { server: 'https://api.example.com' } }],
    now: () => now,
  })
  links.arrive('lumovi://cluster/prod/pods')
  expect(made).toEqual([win])
  expect(held).toEqual([win])
  expect(links.take(page as never)).toMatchObject({ elsewhere: true })
  links.answered()
  // Let go within 2 s of the answer: said, where there's a window of Lumovi's own; never one made.
  now = 1_000
  links.arrive('lumovi://cluster/prod/nodes')
  expect(made).toEqual([win])
})

test('a second Lumovi hands over the link it read from its own command line: a lumovi one, or none', () => {
  expect(handedLink({ link: 'lumovi://cluster/prod/pods' })).toBe('lumovi://cluster/prod/pods')
  expect(handedLink({ link: 'LUMOVI://cluster/prod/pods' })).toBe('LUMOVI://cluster/prod/pods')
  for (const data of [
    { link: null },
    { link: 'https://cluster/prod' },
    { link: 7 },
    {},
    null,
    'lumovi://cluster/prod/pods',
  ]) {
    expect(handedLink(data)).toBeUndefined()
  }
})

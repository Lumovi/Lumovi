/**
 * The door's checks for what a person presses, tried in Lumovi's own built page: presses.spec's
 * cases, with its values and its words, each check made by the page's own door (the tests' stage
 * lends it), so what's measured of the door is what ran in a page. presses.spec tries the same as
 * plain functions. What needs a function (a quick way to make tokens, the calls a press makes,
 * what's said of a stale token) is made in the page, as presses.spec makes it; and what's only
 * ever the same object (a reference a component was handed) is tried there whole. None of its
 * cases is left out.
 */
import type { Page } from '@playwright/test'
import {
  choice,
  handler,
  list,
  object,
  record,
  secret,
  text,
  type handedFields,
  type Part,
  type wrongWithFields,
  type wrongWithPart,
} from '../../src/shared/kit/declare.ts'
import type { DoorPage } from '../../src/shared/plugin-door.ts'
import {
  HANDED_LIMITS,
  ON_A_LARGER_SCREEN,
  type callOf,
  type mayStart,
  type swapFor,
  type Tokens,
} from '../../src/shared/plugin-presses.ts'
import { expect, test, type ServeOptions, type Served } from './fixtures.ts'

/** What the stage lends the tests of the door, for presses. */
interface PressChecks {
  Tokens: typeof Tokens
  swapFor: typeof swapFor
  callOf: typeof callOf
  mayStart: typeof mayStart
  DoorPage: typeof DoorPage
  wrongWithFields: typeof wrongWithFields
  wrongWithPart: typeof wrongWithPart
  handedFields: typeof handedFields
}
/** The page's window, as the stage lends it. */
type Lent = { __lumoviDoor: { doorChecks: PressChecks } }

const POD = { kind: '/Pod', namespace: 'shop', name: 'cart-1' }
const SECRET = { namespace: 'shop', name: 'shop-tls', keys: ['tls.crt'] }

const ROWS: Part = {
  name: 'Rows',
  holds: 'nothing',
  props: {
    title: text(80),
    rows: list(record({ key: text(64), opens: object, shows: secret }, ['key']), 100),
    onOpen: handler('open'),
    onRetry: handler('retry'),
  },
  events: { open: { row: text(64) }, retry: {} },
}

/** Lumovi's page, built for the tests, with its door's checks there. */
async function opened(page: Page, serve: (options?: ServeOptions) => Promise<Served>) {
  const { url } = await serve()
  await page.goto(url)
  await page.waitForFunction(() => '__lumoviDoor' in window)
  return page
}

test('presses: tokens, and what they stand for', async ({ page, serve }) => {
  await opened(page, serve)

  await test.step('a token is random, good on the page it was handed to and on no other, and of one sort', async () => {
    const said = await page.evaluate(
      (given) => {
        'use strict'
        const [POD, SECRET] = given
        const { Tokens } = (window as unknown as Lent).__lumoviDoor.doorChecks
        const pods = (count: number, from = 0) =>
          Array.from({ length: count }, (_, i) => ({ ...POD, name: `pod-${from + i}` }))
        const plugin = { objects: 0 }
        const page = new Tokens(plugin)
        const other = new Tokens(plugin)
        const pod = (page.hand(1, [POD]) as string[])[0]!
        const tls = (page.secrets(1, POD, [SECRET]) as string[])[0]!
        const many = page.hand(2, pods(2000)) as string[]
        const throws = (change: () => void) => {
          try {
            change()
            return false
          } catch {
            return true
          }
        }
        return {
          pod,
          many: new Set(many).size,
          objectOfPod: page.objectOf(pod),
          secretOfTls: page.secretOf(tls),
          secretOfPod: page.secretOf(pod),
          objectOfTls: page.objectOf(tls),
          otherPod: other.objectOf(pod),
          otherTls: other.secretOf(tls),
          lookalikes: [
            pod.slice(0, -1),
            `${pod}x`,
            pod.toLowerCase(),
            '',
            '__proto__',
            'constructor',
            'toString',
          ].map((token) => [token, page.objectOf(token)] as const),
          renamed: throws(() => ((page.objectOf(pod) as { name: string }).name = 'other')),
          pushed: throws(() => (page.secretOf(tls)!.keys as string[]).push('tls.key')),
          keys: page.secretOf(tls)!.keys,
        }
      },
      [POD, SECRET] as const,
    )
    // At least 128 random bits, as text the door's grammar takes for a token.
    expect(said.pod).toMatch(/^[A-Za-z0-9_-]{24}$/)
    expect(said.many).toBe(2000)
    expect(said.objectOfPod).toEqual(POD)
    expect(said.secretOfTls).toEqual(SECRET)
    // The two sorts never stand in for each other.
    expect(said.secretOfPod).toBeUndefined()
    expect(said.objectOfTls).toBeUndefined()
    // Another page of the same plugin: nothing.
    expect(said.otherPod).toBeUndefined()
    expect(said.otherTls).toBeUndefined()
    // Nothing but the token itself, whole: not its start, not the names every object answers to.
    for (const [token, found] of said.lookalikes) expect(found, token).toBeUndefined()
    // What it stands for can't be changed by whoever is handed it.
    expect(said.renamed).toBe(true)
    expect(said.pushed).toBe(true)
    expect(said.keys).toEqual(['tls.crt'])
  })

  await test.step('a token goes with the read that brought it, and with the page', async () => {
    const said = await page.evaluate(
      ([POD, SECRET]) => {
        const { Tokens } = (window as unknown as Lent).__lumoviDoor.doorChecks
        const plugin = { objects: 0 }
        const page = new Tokens(plugin)
        const first = (page.hand(1, [POD]) as string[])[0]!
        const tls = (page.secrets(1, POD, [SECRET]) as string[])[0]!
        const second = (page.hand(2, [{ ...POD, name: 'cart-2' }]) as string[])[0]!
        const handed = plugin.objects
        page.ended(1)
        const ended = {
          first: page.objectOf(first),
          tls: page.secretOf(tls),
          second: page.objectOf(second),
          objects: plugin.objects,
        }
        // Ended twice, or a read that brought nothing: nothing to do.
        page.ended(1)
        page.ended(9)
        page.close()
        page.close()
        return { handed, ended, closed: page.objectOf(second), left: plugin.objects }
      },
      [POD, SECRET] as const,
    )
    expect(said.handed).toBe(2)
    expect(said.ended.first).toBeUndefined()
    expect(said.ended.tls).toBeUndefined()
    expect(said.ended.second).toBeTruthy()
    expect(said.ended.objects).toBe(1)
    expect(said.closed).toBeUndefined()
    expect(said.left).toBe(0)
  })

  await test.step('how much is handed over is bounded by refusing a read, never by stopping a plugin', async () => {
    const said = await page.evaluate(
      ([POD, SECRET, LIMITS]) => {
        const { Tokens } = (window as unknown as Lent).__lumoviDoor.doorChecks
        /** Tokens that are quick to make, for counting many. */
        const counting = (prefix = 'a') => {
          let n = 0
          return () => `${prefix}${++n}`
        }
        const pods = (count: number, from = 0) =>
          Array.from({ length: count }, (_, i) => ({ ...POD, name: `pod-${from + i}` }))
        // (A list comes back as its length alone: what's compared of it is how many.)
        const size = (handed: unknown) =>
          Array.isArray(handed) ? { length: handed.length } : handed
        const plugin = { objects: 0 }
        const page = new Tokens(plugin, counting())
        // One over a page's share: none is handed and nothing is counted.
        const over = size(page.hand(1, pods(LIMITS.objectsAPage + 1)))
        const counted = plugin.objects
        const full = size(page.hand(1, pods(LIMITS.objectsAPage)))
        const more = size(page.hand(2, pods(1, 900_000)))
        // A plugin's pages share its bound; a read that ends gives its objects back.
        const second = new Tokens(plugin, counting('b'))
        const secondFull = size(second.hand(1, pods(LIMITS.objectsAPage)))
        const third = new Tokens(plugin, counting('c'))
        const thirdOver = size(third.hand(1, pods(1)))
        page.ended(1)
        const thirdAfter = size(third.hand(1, pods(1)))
        // A Secret's token isn't an object handed over: it isn't counted among them.
        const before = plugin.objects
        third.secrets(1, { ...POD, name: 'pod-0' }, [SECRET])
        return {
          over,
          counted,
          full,
          more,
          secondFull,
          thirdOver,
          thirdAfter,
          before,
          after: plugin.objects,
        }
      },
      [POD, SECRET, HANDED_LIMITS] as const,
    )
    expect(said.over).toBe('too-many')
    expect(said.counted).toBe(0)
    expect(said.full).toHaveLength(HANDED_LIMITS.objectsAPage)
    expect(said.more).toBe('too-many')
    expect(said.secondFull).toHaveLength(HANDED_LIMITS.objectsAPage)
    expect(said.thirdOver).toBe('too-many')
    expect(said.thirdAfter).toHaveLength(1)
    expect(said.after).toBe(said.before)
  })

  await test.step('no token is made for a name or a namespace no object could have', async () => {
    const names = ['', '.', '..', 'a/b', 'a%2Fb', 'cart 1', 'cart​1', 'cart\n1', 'a'.repeat(254)]
    const namespaces = ['', 'Shop', 'shop.prod', '-shop', 'a'.repeat(64)]
    const keys = ['tls/crt', '', 'a\u202Eb', 'k'.repeat(254), 'tls crt', '.', '..', '..data']
    const said = await page.evaluate(
      ([POD, SECRET, names, namespaces, keys]) => {
        const { Tokens } = (window as unknown as Lent).__lumoviDoor.doorChecks
        const counting = (prefix = 'a') => {
          let n = 0
          return () => `${prefix}${++n}`
        }
        const plugin = { objects: 0 }
        const page = new Tokens(plugin, counting())
        // Names as kinds have them: a cluster's own, a role's with colons, one without a namespace.
        const fine = [
          POD,
          {
            kind: 'rbac.authorization.k8s.io/ClusterRole',
            name: 'system:controller:job-controller',
          },
          { kind: '/Node', name: 'ip-10-0-1-17.eu-west-1.compute.internal' },
        ].map((ref) => page.hand(1, [ref]))
        const handed = plugin.objects
        // What a path would take for another (or for nothing), what can't be seen, what's too long.
        const byName = names.map((name) => page.hand(2, [POD, { ...POD, name }]))
        const byNamespace = namespaces.map((namespace) => ({
          handed: page.hand(2, [{ ...POD, namespace }]),
          secrets: page.secrets(1, POD, [{ ...SECRET, namespace }]),
        }))
        const climbing = page.secrets(1, POD, [{ ...SECRET, name: '../shop-tls' }])
        // Nor for what isn't text, nor a Secret outside a namespace.
        const unread = { ...SECRET, namespace: undefined } as unknown as typeof SECRET
        const outside = page.secrets(1, POD, [unread])
        // Nor for keys that aren't Secrets' keys: a part draws each where a person reads it.
        const byKey = keys.map((key) =>
          page.secrets(1, POD, [{ ...SECRET, keys: ['tls.crt', key] }]),
        )
        const unnamed = page.hand(2, [{ ...POD, name: undefined } as unknown as typeof POD])
        const numbered = page.hand(2, [{ ...POD, namespace: 7 } as unknown as typeof POD])
        return {
          fine,
          handed,
          byName,
          byNamespace,
          climbing,
          outside,
          byKey,
          unnamed,
          numbered,
          after: plugin.objects,
          again: page.hand(2, [POD]),
        }
      },
      [POD, SECRET, names, namespaces, keys] as const,
    )
    for (const handed of said.fine) expect(handed).toHaveLength(1)
    for (const [i, name] of names.entries()) {
      expect(said.byName[i], JSON.stringify(name)).toBe('not-a-name')
    }
    for (const [i, namespace] of namespaces.entries()) {
      expect(said.byNamespace[i]!.handed, JSON.stringify(namespace)).toBe('not-a-name')
      expect(said.byNamespace[i]!.secrets, JSON.stringify(namespace)).toEqual([undefined])
    }
    expect(said.climbing).toEqual([undefined])
    expect(said.outside).toEqual([undefined])
    for (const [i, key] of keys.entries()) {
      expect(said.byKey[i], JSON.stringify(key)).toEqual([undefined])
    }
    expect(said.unnamed).toBe('not-a-name')
    expect(said.numbered).toBe('not-a-name')
    // None handed, nothing counted: the read is refused whole.
    expect(said.after).toBe(said.handed)
    expect(said.again).toHaveLength(1)
  })

  await test.step('within a read an object has one token, however often it’s handed over: counted once', async () => {
    const said = await page.evaluate(
      ([POD, LIMITS]) => {
        const { Tokens } = (window as unknown as Lent).__lumoviDoor.doorChecks
        const pods = (count: number, from = 0) =>
          Array.from({ length: count }, (_, i) => ({ ...POD, name: `pod-${from + i}` }))
        const size = (handed: unknown) =>
          Array.isArray(handed) ? { length: handed.length } : handed
        const plugin = { objects: 0 }
        const page = new Tokens(plugin)
        const [first] = page.hand(1, [POD]) as string[]
        // A list kept up to date hands a pod over every time it changes.
        const often = Array.from({ length: 1000 }, () => page.hand(1, [{ ...POD }]))
        const once = plugin.objects
        // Twice in one handing over: one token, one counted.
        const [a, other, again] = page.hand(1, [POD, { ...POD, name: 'cart-2' }, POD]) as string[]
        const twice = plugin.objects
        const rest = size(page.hand(1, pods(LIMITS.objectsAPage - 2)))
        // Another read of the same object is another token: each read's go with it.
        const [elsewhere] = new Tokens({ objects: 0 }).hand(1, [POD]) as string[]
        return { first, often, once, a, other, again, twice, rest, elsewhere }
      },
      [POD, HANDED_LIMITS] as const,
    )
    expect(said.often).toEqual(Array.from({ length: 1000 }, () => [said.first]))
    expect(said.once).toBe(1)
    expect([said.a, said.again]).toEqual([said.first, said.first])
    expect(said.other).not.toBe(said.first)
    expect(said.twice).toBe(2)
    expect(said.rest).not.toBe('too-many')
    expect(said.elsewhere).not.toBe(said.first)
  })

  await test.step('an object that leaves a read gives its place back, and its token is no more', async () => {
    const said = await page.evaluate((POD) => {
      const { Tokens } = (window as unknown as Lent).__lumoviDoor.doorChecks
      const plugin = { objects: 0 }
      const page = new Tokens(plugin)
      const [token] = page.hand(1, [POD]) as string[]
      // (The reference a component was handed is the same object, so it's asked of here.)
      const given = page.objectOf(token!)
      page.gone(1, { ...POD })
      const gone = {
        objects: plugin.objects,
        token: page.objectOf(token!),
        destination: page.destinationOf(given),
      }
      // Gone twice, or never there: nothing to do. Back again: a new token.
      page.gone(1, POD)
      page.gone(7, POD)
      const [again] = page.hand(1, [POD]) as string[]
      return { token, gone, again, objects: plugin.objects }
    }, POD)
    expect(said.gone.objects).toBe(0)
    expect(said.gone.token).toBeUndefined()
    expect(said.gone.destination).toBeUndefined()
    expect(said.again).not.toBe(said.token)
    expect(said.objects).toBe(1)
  })
})

test('presses: a Secret an object names, and how many', async ({ page, serve }) => {
  await opened(page, serve)

  await test.step('a Secret an object names keeps its token while the object names it, and goes with the object', async () => {
    const said = await page.evaluate(
      ([POD, SECRET]) => {
        const { Tokens } = (window as unknown as Lent).__lumoviDoor.doorChecks
        const counting = (prefix = 'a') => {
          let n = 0
          return () => `${prefix}${++n}`
        }
        const page = new Tokens({ objects: 0 }, counting())
        page.hand(1, [POD, { ...POD, name: 'cart-2' }])
        const db = { ...SECRET, name: 'shop-db', keys: ['password'] }
        const [tls, first] = page.secrets(1, POD, [SECRET, db]) as string[]
        // Read again: the same tokens, however often.
        const often = Array.from({ length: 100 }, () => page.secrets(1, { ...POD }, [SECRET, db]))
        // The same Secret named by another object is that object's token, not this one's.
        const [theirs] = page.secrets(1, { ...POD, name: 'cart-2' }, [SECRET]) as string[]
        // Named no more: its token is no more. Named again: a new one.
        const fewer = page.secrets(1, POD, [SECRET])
        const firstAfter = page.secretOf(first!)
        const named = (page.secrets(1, POD, [SECRET, db]) as string[])[1]
        // The same Secret with other keys is another reference: what it may show is part of it.
        const otherKeys = (page.secrets(1, POD, [{ ...SECRET, keys: ['ca.crt'] }]) as string[])[0]
        const tlsAfter = page.secretOf(tls!)
        // An object that leaves the read takes its Secrets' tokens with it.
        const [now] = page.secrets(1, POD, [SECRET]) as string[]
        page.gone(1, POD)
        const nowAfter = page.secretOf(now!)
        const theirsAfter = page.secretOf(theirs!)
        // Nothing for an object the read didn't hand (any more), or another read's.
        const unhanded = page.secrets(1, POD, [SECRET])
        const otherRead = page.secrets(2, { ...POD, name: 'cart-2' }, [SECRET])
        // And the read's end takes every one.
        page.ended(1)
        return {
          tls,
          first,
          often,
          theirs,
          fewer,
          firstAfter,
          named,
          otherKeys,
          tlsAfter,
          nowAfter,
          theirsAfter,
          unhanded,
          otherRead,
          ended: page.secretOf(theirs!),
        }
      },
      [POD, SECRET] as const,
    )
    expect(said.often).toEqual(Array.from({ length: 100 }, () => [said.tls, said.first]))
    expect(said.theirs).not.toBe(said.tls)
    expect(said.fewer).toEqual([said.tls])
    expect(said.firstAfter).toBeUndefined()
    expect(said.named).not.toBe(said.first)
    expect(said.otherKeys).not.toBe(said.tls)
    expect(said.tlsAfter).toBeUndefined()
    expect(said.nowAfter).toBeUndefined()
    expect(said.theirsAfter).toEqual(SECRET)
    expect(said.unhanded).toEqual([undefined])
    expect(said.otherRead).toEqual([undefined])
    expect(said.ended).toBeUndefined()
  })

  await test.step('how many Secrets a page is handed is bounded by refusing, never by taking any back', async () => {
    const said = await page.evaluate(
      ([POD, SECRET, LIMITS]) => {
        const { Tokens } = (window as unknown as Lent).__lumoviDoor.doorChecks
        const counting = (prefix = 'a') => {
          let n = 0
          return () => `${prefix}${++n}`
        }
        const pods = (count: number, from = 0) =>
          Array.from({ length: count }, (_, i) => ({ ...POD, name: `pod-${from + i}` }))
        const size = (handed: unknown) =>
          Array.isArray(handed) ? { length: handed.length } : handed
        const page = new Tokens({ objects: 0 }, counting())
        const owners = pods(LIMITS.secretsAPage / 20 + 1)
        page.hand(1, owners)
        const twenty = (n: number) =>
          Array.from({ length: 20 }, (_, i) => ({ ...SECRET, name: `s-${n}-${i}` }))
        const each = owners.slice(0, -1).map((owner, n) => size(page.secrets(1, owner, twenty(n))))
        const last = owners.at(-1)!
        const over = page.secrets(1, last, twenty(99_999))
        // Nothing was made, and what was had stands.
        const [kept] = page.secrets(1, owners[0]!, twenty(0)) as string[]
        const stands = page.secretOf(kept!)
        // Room again once one names fewer.
        page.secrets(1, owners[0]!, [])
        return { each, over, stands, room: size(page.secrets(1, last, twenty(99_999))) }
      },
      [POD, SECRET, HANDED_LIMITS] as const,
    )
    for (const handed of said.each) expect(handed).not.toBe('too-many')
    expect(said.over).toBe('too-many')
    expect(said.stands).toBeTruthy()
    expect(said.room).not.toBe('too-many')
  })
})

test('presses: what a part is handed, and what opens anything', async ({ page, serve }) => {
  await opened(page, serve)

  await test.step('a part is handed the object where a plugin named a token, and nothing where the page holds none', async () => {
    const said = await page.evaluate(
      ([POD, SECRET, ROWS]) => {
        const { Tokens, swapFor, wrongWithFields, handedFields } = (window as unknown as Lent)
          .__lumoviDoor.doorChecks
        const page = new Tokens({ objects: 0 })
        const other = new Tokens({ objects: 0 })
        const pod = (page.hand(1, [POD]) as string[])[0]!
        const tls = (page.secrets(1, POD, [SECRET]) as string[])[0]!
        const elsewhere = (other.hand(1, [{ ...POD, name: 'not-this-page' }]) as string[])[0]!
        const calls: unknown[][] = []
        let stale = 0
        const swap = swapFor(
          page,
          (...call) => calls.push(call),
          () => stale++,
        )
        const props = {
          title: 'Pods',
          rows: [
            { key: 'a', opens: pod, shows: tls },
            // Made up, another page's, gone stale, and each sort in the other's place.
            { key: 'b', opens: 'made-up-token' },
            { key: 'c', opens: elsewhere },
            { key: 'd', opens: tls, shows: pod },
          ],
          onOpen: 'h1',
        }
        const wrong = wrongWithFields(props, ROWS.props, [], 'Rows')
        const given = handedFields(props, ROWS.props, swap) as {
          rows: { key: unknown; opens?: unknown; shows?: unknown }[]
          onOpen: (carries: unknown) => void
          onRetry?: unknown
        }
        // A row that gets no reference has no `opens` at all: nothing the plugin wrote stands in.
        const opensSecond = Object.hasOwn(given.rows[1]!, 'opens')
        const staleThen = stale
        // A handler the plugin named is a function; one it didn't name isn't there.
        given.onOpen({ row: 'a' })
        const retry = given.onRetry
        // When the read ends, the same description gives no reference any more.
        page.ended(1)
        const later = (handedFields(props, ROWS.props, swap) as typeof given).rows[0]
        return { wrong, rows: given.rows, opensSecond, staleThen, calls, retry, later }
      },
      [POD, SECRET, ROWS] as const,
    )
    expect(said.wrong).toBeUndefined()
    expect(said.rows).toEqual([
      { key: { their: 'a' }, opens: POD, shows: SECRET },
      { key: { their: 'b' } },
      { key: { their: 'c' } },
      { key: { their: 'd' } },
    ])
    expect(said.opensSecond).toBe(false)
    expect(said.staleThen).toBe(4)
    expect(said.calls).toEqual([['h1', 'open', { row: 'a' }]])
    expect(said.retry).toBeUndefined()
    expect(said.later).toEqual({ key: { their: 'a' } })
  })

  await test.step('a token a page doesn’t hold is said to its author once, and a swap needn’t say it', async () => {
    const said = await page.evaluate(() => {
      const { Tokens, swapFor } = (window as unknown as Lent).__lumoviDoor.doorChecks
      const tokens = new Tokens({ objects: 0 })
      // (With nothing to tell of a stale token, a swap tells nothing.)
      const swap = swapFor(tokens, () => undefined)
      return {
        given: [swap.object('made-up'), swap.secret('made-up')],
        told: [tokens.staleToSay(), tokens.staleToSay()],
      }
    })
    expect(said.given).toEqual([undefined, undefined])
    expect(said.told).toEqual([true, false])
  })

  await test.step('nothing the door swaps can be required: a part is always written to draw without it', async () => {
    // (A token can be made up, or gone with its read while a commit was on its way: the property
    // is then absent, and a part that required it would fail as it drew, by a plugin's choice.)
    const part = (props: Part['props'], required?: string[]): Part => ({
      name: 'A',
      holds: 'nothing',
      props,
      required,
    })
    const parts: Part[] = [
      ROWS,
      part({ opens: object }, ['opens']),
      part({ shows: secret }, ['shows']),
      part({ row: record({ key: text(8), opens: object }, ['key', 'opens']) }),
      part({ rows: list(record({ opens: object }, ['opens']), 5) }),
      // In a choice, what isn't optional is required.
      part({ cell: choice('kind', { link: { opens: object } }) }),
      part({
        cell: choice('kind', { link: { opens: object, label: text(8) } }, { link: ['opens'] }),
      }),
      // Optional, it's fine anywhere; and a handler may be required (it's always a function).
      part({ opens: object, shows: secret, row: record({ opens: object }) }),
      { ...part({ onOpen: handler('open') }, ['onOpen']), events: { open: {} } },
    ]
    const said = await page.evaluate(
      (parts) =>
        parts.map((part) =>
          (window as unknown as Lent).__lumoviDoor.doorChecks.wrongWithPart(part),
        ),
      parts,
    )
    expect(said[0]).toBeUndefined()
    expect(said[1]).toBe('A.opens: an object or a Secret can’t be required')
    expect(said[2]).toBe('A.shows: an object or a Secret can’t be required')
    expect(said[3]).toContain('can’t be required')
    expect(said[4]).toContain('can’t be required')
    expect(said[5]).toContain('can’t be required')
    expect(said[6]).toBeUndefined()
    expect(said[7]).toBeUndefined()
    expect(said[8]).toBeUndefined()
  })

  await test.step('only a reference the door put in a component’s hands opens anything', async () => {
    const said = await page.evaluate((POD) => {
      const { Tokens } = (window as unknown as Lent).__lumoviDoor.doorChecks
      const page = new Tokens({ objects: 0 })
      const other = new Tokens({ objects: 0 })
      const token = (page.hand(1, [POD]) as string[])[0]!
      const given = page.objectOf(token)!
      // Something that only looks like it; another page's; a path, an address, a token, nothing.
      const made: [string, unknown][] = [
        ['a copy', { ...POD }],
        ['another page’s', other.objectOf((other.hand(1, [POD]) as string[])[0]!)],
        ['a path', '/cluster/demo/secrets/shop/admin'],
        ['an address', 'https://example.com'],
        ['a token', token],
        ['null', null],
        ['undefined', undefined],
      ]
      return {
        given: page.destinationOf(given),
        made: made.map(([what, ref]) => [what, page.destinationOf(ref)] as const),
        // A token never minted for this page isn't a destination just because it was looked up.
        madeUp: page.objectOf('made-up'),
      }
    }, POD)
    expect(said.given).toEqual({ to: 'object', object: POD })
    for (const [what, destination] of said.made) expect(destination, what).toBeUndefined()
    expect(said.madeUp).toBeUndefined()
  })

  await test.step('what a component was handed opens nothing once its read has ended, or its page has gone', async () => {
    const said = await page.evaluate((POD) => {
      const { Tokens } = (window as unknown as Lent).__lumoviDoor.doorChecks
      const page = new Tokens({ objects: 0 })
      const [one, two] = page.hand(1, [POD, { ...POD, name: 'cart-2' }]) as string[]
      const [kept] = page.hand(2, [POD]) as string[]
      const given = [page.objectOf(one!), page.objectOf(two!), page.objectOf(kept!)]
      const before = given.map((ref) => page.destinationOf(ref))
      // A component not yet drawn again still holds the old reference: it opens nothing.
      page.ended(1)
      const ended = given.map((ref) => page.destinationOf(ref))
      page.close()
      return { before, ended, closed: page.destinationOf(given[2]) }
    }, POD)
    for (const destination of said.before) expect(destination).toBeTruthy()
    expect(said.ended[0]).toBeUndefined()
    expect(said.ended[1]).toBeUndefined()
    expect(said.ended[2]).toBeTruthy()
    expect(said.closed).toBeUndefined()
  })
})

test('presses: what a press sends, and what may start', async ({ page, serve }) => {
  await opened(page, serve)

  await test.step('nothing a plugin’s code can send opens anything, or is a press', async () => {
    const messages = [
      { open: 'token' },
      { go: { to: 'object', object: POD } },
      { navigate: '/cluster/demo/secrets' },
      { press: 1 },
      { call: 'h1', carries: {} },
      { commit: [], open: 'token' },
      { commit: [['open', 1]] },
      { commit: [['press', 1, 'open']] },
    ]
    const said = await page.evaluate(
      ([ROWS, messages]) => {
        const { DoorPage } = (window as unknown as Lent).__lumoviDoor.doorChecks
        const door = new DoorPage({ Rows: ROWS }, () => 0)
        const taken = messages.map((message) =>
          new DoorPage({ Rows: ROWS }, () => 0).take(JSON.stringify(message)),
        )
        return { taken, stopped: door.stopped }
      },
      [ROWS, messages] as const,
    )
    for (const [i, message] of messages.entries()) {
      expect(said.taken[i], JSON.stringify(message)).toMatchObject({ why: 'not-allowed' })
    }
    expect(said.stopped).toBeUndefined()
  })

  await test.step('a press sends a plugin its handle and what the part’s declaration says it carries, and nothing else', async () => {
    // An event the part doesn't declare; what it doesn't declare, Lumovi's own reference above
    // all; too little; the wrong kind; the names every object answers to.
    const wrong: [string, unknown][] = [
      ['close', {}],
      ['open', { row: 'a', object: POD }],
      ['open', { row: 'a', name: 'cart-1' }],
      ['open', {}],
      ['open', { row: 5 }],
      ['open', { row: 'x'.repeat(65) }],
      ['open', null],
      ['open', ['a']],
      ['retry', { row: 'a' }],
      ['toString', {}],
      ['__proto__', {}],
      ['constructor', {}],
    ]
    const said = await page.evaluate(
      ([ROWS, wrong]) => {
        const { callOf } = (window as unknown as Lent).__lumoviDoor.doorChecks
        return {
          open: callOf(ROWS, 'open', 'h1', { row: 'a' }),
          retry: callOf(ROWS, 'retry', 'h2', {}),
          wrong: wrong.map(([event, carries]) => callOf(ROWS, event, 'h1', carries)),
          undeclared: callOf({ ...ROWS, events: undefined }, 'open', 'h1', { row: 'a' }),
        }
      },
      [ROWS, wrong] as const,
    )
    expect(said.open).toBe('{"call":"h1","carries":{"row":"a"}}')
    expect(said.retry).toBe('{"call":"h2","carries":{}}')
    for (const [i, [event, carries]] of wrong.entries()) {
      expect(said.wrong[i], `${event} ${JSON.stringify(carries)}`).toBeUndefined()
    }
    expect(said.undeclared).toBeUndefined()
  })

  await test.step('a press is what it does, not what its button said: on a phone nothing a plugin’s page starts is a change', async () => {
    const button = (changes: boolean) => ({ key: 'sync', name: 'Sync', changes })
    const layouts: unknown[] = [
      'phone',
      'Phone',
      'PHONE',
      'narrow',
      'desktop',
      'watch',
      '',
      ' wide',
      null,
      undefined,
      5,
      {},
    ]
    const doings: unknown[] = ['destroys', 'Changes', '', 'toString', '__proto__', null, undefined]
    const said = await page.evaluate(
      ([layouts, doings]) => {
        const { mayStart } = (window as unknown as Lent).__lumoviDoor.doorChecks
        return {
          phoneChange: mayStart('changes', 'phone'),
          phoneTells: mayStart('tells', 'phone'),
          phoneOpens: mayStart('opens', 'phone'),
          larger: ['wide', 'tablet'].map((layout) => mayStart('changes', layout)),
          unknown: layouts.map((layout) => ({
            changes: mayStart('changes', layout),
            tells: mayStart('tells', layout),
            opens: mayStart('opens', layout),
          })),
          undecided: doings.map((does) =>
            ['wide', 'tablet', 'phone'].map((layout) => mayStart(does as never, layout)),
          ),
          length: mayStart.length,
        }
      },
      [layouts, doings] as const,
    )
    // A button that says it changes nothing, whose press would change: refused on a phone.
    expect(button(false).changes).toBe(false)
    expect(said.phoneChange).toEqual({ refused: ON_A_LARGER_SCREEN })
    expect(ON_A_LARGER_SCREEN).toBe('Open Lumovi on a larger screen to do this.')
    // A button that says it changes, whose press only tells the plugin or opens something: fine.
    expect(button(true).changes).toBe(true)
    expect(said.phoneTells).toBe(true)
    expect(said.phoneOpens).toBe(true)
    // On a larger screen a change may start (and is then Lumovi's own confirmation's to carry).
    for (const started of said.larger) expect(started).toBe(true)
    // Anything that isn't known to be a larger screen is not one: a new layout, a wrong word,
    // nothing at all. There only telling and opening may start.
    for (const [i, layout] of layouts.entries()) {
      expect(said.unknown[i]!.changes, String(layout)).toEqual({ refused: ON_A_LARGER_SCREEN })
      expect(said.unknown[i]!.tells).toBe(true)
      expect(said.unknown[i]!.opens).toBe(true)
    }
    // A sort of press nobody has decided about starts nowhere, on any screen.
    for (const [i, does] of doings.entries()) {
      for (const [j, layout] of ['wide', 'tablet', 'phone'].entries()) {
        expect(said.undecided[i]![j], `${String(does)} ${layout}`).toEqual({
          refused: 'Lumovi doesn’t know what this would do, so it didn’t.',
        })
      }
    }
    // The rule takes no word of a plugin's at all: there's nowhere to hand it one.
    expect(said.length).toBe(2)
  })
})

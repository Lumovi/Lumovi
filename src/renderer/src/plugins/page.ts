/**
 * A plugin's page, open: its code in its box, what it sends taken by the door (its page's
 * commits by the tree, its asks to read by the reads), and the tree the door keeps for Lumovi to
 * draw. Whatever ends it (the box, the door, the main process) ends it once, with the reason a
 * person is told; its box is taken away with it, and its reads.
 */
import type { ComponentType, ReactNode } from 'react'
import {
  handedFields,
  type ListDestination,
  type ObjectRef,
  type Part,
  type Swap,
} from '@shared/kit/declare'
import {
  PROPOSE_AT_MOST,
  proposalProblem,
  type PageProposal,
  type ProposalOutcome,
} from '@shared/plugin-changes'
import { DoorPage } from '@shared/plugin-door'
import type { PageEnd } from '@shared/plugin-ended'
import { callOf, swapFor, unnamedLine, type Destination } from '@shared/plugin-presses'
import { whose } from '@shared/plugins'
import { api } from '@renderer/lib/api'
import { openBox, type BoxEnd } from './box'
import { PageReading, type ReadNotices } from './reads'

/** A part of Lumovi's a plugin may name: how it's declared, and what draws it. */
export interface KitPart {
  declared: Part
  /**
   * Drawn with the properties the door checked (as `handed` hands them), what's inside it
   * already drawn, and `go`: Lumovi's own open of an object or a list the part was handed, never
   * the plugin's (it's no property, and no plugin names it).
   */
  draw: ComponentType<{
    props: Readonly<Record<string, unknown>>
    children?: ReactNode
    go?: (to: ObjectRef | ListDestination) => void
  }>
}

export interface OpenPage {
  /** The page as the plugin has described it so far: read it, never change it. */
  readonly tree: DoorPage
  /** Why it ended, once it has. */
  readonly end: PageEnd | undefined
  /** The parts its plugin may name: what the door checked against, and what draws them. */
  readonly parts: Readonly<Record<string, KitPart>>
  /** Hears when the page ends. */
  subscribe(ended: () => void): () => void
  /**
   * Hears when the part or text `id` has something new to draw: its properties, its text, or
   * what's under it, in which order (what's inside what's under it is theirs to hear). Once a
   * frame at most, however many commits came in it: so a commit that changes one row draws that
   * row again, and nothing else. What it's drawn from is the tree's `changedAt(id)`: one drawn
   * before it listened, and changed meanwhile, is drawn again as it starts to.
   */
  subscribeTo(id: number, changed: () => void): () => void
  /**
   * A part of Lumovi's failed as it drew this page: the page ends, said as Lumovi's own fault.
   * Called by the boundary round the page's surface and by nothing else: nothing a plugin sends
   * leads here.
   */
  fault(): void
  /**
   * The part `part`'s properties as its component is handed them: every text a plugin's, and
   * every token and handle in the place of what it stands for on this page (the door's swap). A
   * handler, pressed, sends the plugin its call, checked against the part's declaration. Made
   * once for the properties the door holds, which are never changed.
   */
  handed(part: string, props: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>
  /**
   * Opens the object a component was handed, where this page's door handed it, for a read
   * that's still going; or the list the door made for it. Anything else opens nothing.
   */
  go(object: unknown): void
  /**
   * What Lumovi says of the page's reads, round the page and never by the plugin: one failing
   * now, a list cut at Lumovi's limit. The same object until that changes.
   */
  readonly notices: ReadNotices
  subscribeNotices(heard: () => void): () => void
  /** The person's "Retry": the reads that are failing are read again now. */
  retry(): void
  /** Takes the page away: its box and its worker with it. */
  close(): void
}

/**
 * What a press carries, as its plugin is sent it: each text of a plugin's that a part was handed
 * (a `Their`) as the text it wrote. (What isn't one of the part's declared kinds is still
 * refused by `callOf`: this changes no shape, only takes the texts back out of their wrapping.)
 */
function written(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(written)
  if (typeof value !== 'object' || value === null) return value
  const keys = Object.keys(value)
  if (
    keys.length === 1 &&
    keys[0] === 'their' &&
    typeof (value as { their: unknown }).their === 'string'
  ) {
    return (value as { their: string }).their
  }
  return Object.fromEntries(
    keys.map((key) => [key, written((value as Record<string, unknown>)[key])]),
  )
}

/** What a box's end is to a person. (A way for a box to end that isn't here fails the build.) */
function boxEnd(end: BoxEnd): PageEnd {
  switch (end.why) {
    case 'failed':
      return { why: 'failed', said: end.said }
    case 'silent':
    case 'no-box':
      return { why: end.why }
    case 'over':
      return { why: end.over === 'not-text' ? 'not-allowed' : 'too-much' }
    default:
      return end satisfies never
  }
}

/**
 * Of what a plugin sent, an ask to read: anything short that reads as an object and isn't a
 * commit. (Anything else is the door's to take, and to say what's wrong with: an ask is never
 * long, and a commit always says it's one.)
 */
function askIn(text: string): object | undefined {
  if (text.length > ASK_AT_MOST) return undefined
  let read: unknown
  try {
    read = JSON.parse(text)
  } catch {
    return undefined
  }
  return typeof read === 'object' &&
    read !== null &&
    !Array.isArray(read) &&
    !Object.hasOwn(read, 'commit')
    ? read
    : undefined
}

/**
 * Longer than any ask can be: its kind, its namespace and its name at their longest, or a list's
 * fields and labels at theirs.
 */
const ASK_AT_MOST = 4096

/**
 * Of what a plugin sent, a proposal of a change: an object that says it's one. (Looked for before
 * an ask: a proposal can be longer than any ask, and isn't one.)
 */
function proposalIn(text: string): object | undefined {
  if (text.length > PROPOSE_AT_MOST || !text.includes('"propose"')) return undefined
  let read: unknown
  try {
    read = JSON.parse(text)
  } catch {
    return undefined
  }
  return typeof read === 'object' &&
    read !== null &&
    !Array.isArray(read) &&
    Object.hasOwn(read, 'propose')
    ? read
    : undefined
}

/**
 * Opens the page of the plugin named `plugin` (its box's address), from its `code`. What it
 * reads, it reads in `context`.
 */
export function openPage(options: {
  plugin: string
  context: string
  code: string
  /**
   * What the code was handed with (`PluginCode`), which its reads name: none for code that
   * wasn't handed over (the tests' stage's own), whose reads are then never made.
   */
  handed?: { digest: string; codeDigest: string }
  parts: Readonly<Record<string, KitPart>>
  /**
   * Every kind its file names, as Lumovi names them (`namedKinds`): what its parts may open a
   * list of. None, and a part opens no list.
   */
  kinds?: readonly string[]
  /**
   * What its code is told first, once it's there: which of its pages it describes, or which tab,
   * with the object the tab is on (read for it as its own kind is, and handed with a token).
   */
  opening?: { page: string } | { tab: string; object: ObjectRef }
  /** Lumovi's own open of what a press named: where its door says, and nowhere else. */
  open?: (to: Destination) => void
  /**
   * Lumovi's own dialog for a change the page proposes, right after a press: what became of it.
   * None, and every proposal is refused.
   */
  propose?: (proposal: PageProposal) => Promise<ProposalOutcome>
}): OpenPage {
  const kinds: ReadonlySet<string> = new Set(options.kinds)
  const declared = Object.fromEntries(
    Object.entries(options.parts).map(([name, part]) => [name, part.declared]),
  )
  const listeners = new Set<() => void>()
  // (What the page stops hearing once it's closed: set once the box is opened, below.)
  let stopListening = () => {}
  // Of each part or text being drawn, who hears it. (Only of those drawn: what's taken away is
  // drawn no more, and nothing of it is kept.)
  const drawn = new Map<number, Set<() => void>>()
  const page = {
    tree: new DoorPage(declared),
    parts: options.parts,
    end: undefined as PageEnd | undefined,
    subscribe(ended: () => void) {
      listeners.add(ended)
      return () => void listeners.delete(ended)
    },
    subscribeTo(id: number, changed: () => void) {
      let heard = drawn.get(id)
      if (!heard) drawn.set(id, (heard = new Set()))
      heard.add(changed)
      return () => {
        heard.delete(changed)
        if (heard.size === 0) drawn.delete(id)
      }
    },
    fault() {
      ended({ why: 'drawing' })
    },
    handed(part: string, props: Readonly<Record<string, unknown>>) {
      let handed = made.get(props)
      if (!handed) {
        // (Its presses checked against what this description drew: a button off sends nothing.)
        const swap: Swap = {
          ...swapOf(part),
          handler: (handle, event) => (carries) => send(part, handle, event, carries, props),
        }
        made.set(props, (handed = handedFields(props, options.parts[part]!.declared.props, swap)))
      }
      return handed
    },
    go(object: unknown) {
      const to = reading.tokens.destinationOf(object)
      if (to && !page.end) options.open?.(to)
    },
    get notices() {
      return reading.notices
    },
    subscribeNotices(heard: () => void) {
      return reading.subscribeNotices(heard)
    },
    retry() {
      if (!page.end) reading.retry()
    },
    close() {
      stopListening()
      cancelAnimationFrame(telling)
      reading.close()
      box.close()
    },
  }
  // What a plugin sends is drawn once a frame, however many commits a frame brings: what each
  // changed is kept until then, and only that is drawn again. (Only what's drawn is kept: what
  // isn't yet is drawn with what holds it, and a hidden window, which has no frames, keeps no
  // more than it shows.)
  const toTell = new Set<number>()
  let telling = 0
  const toDraw = (changed: readonly number[]) => {
    for (const id of changed) if (drawn.has(id)) toTell.add(id)
    if (telling) return
    telling = requestAnimationFrame(() => {
      telling = 0
      if (page.end) return
      const told = [...toTell].flatMap((id) => [...(drawn.get(id) ?? [])])
      toTell.clear()
      told.forEach((changed) => changed())
    })
  }
  const ended = (end: PageEnd) => {
    if (page.end) return
    page.end = end
    page.close()
    telling = 0
    toTell.clear()
    listeners.forEach((listener) => listener())
  }
  // What each part is handed, made once; and each part's swap, whose presses are checked against
  // that part's declaration before anything is sent.
  const made = new WeakMap<object, Readonly<Record<string, unknown>>>()
  const swaps = new Map<string, Swap>()
  /** A press, sent where its part's declaration, and what it was drawn with, say it may be. */
  const send = (
    part: string,
    handle: string,
    event: string,
    carries: unknown,
    drawn?: Readonly<Record<string, unknown>>,
  ) => {
    if (page.end) return
    // (Each press has its token, made only for a press that's sent: a change the page proposes
    // right after carries it.)
    const call = callOf(options.parts[part]!.declared, event, handle, written(carries), {
      ...(drawn && { drawn }),
      press: () => reading.tokens.pressed(Date.now()),
    })
    if (call !== undefined) box.post(call)
  }
  const swapOf = (part: string): Swap => {
    let swap = swaps.get(part)
    if (!swap) {
      swap = swapFor(
        reading.tokens,
        (handle, event, carries) => send(part, handle, event, carries),
        () => {
          // (For whoever writes the plugin, once a page: to the person, a row that doesn't
          // open is quiet.)
          if (reading.tokens.staleToSay()) {
            console.warn(
              `Lumovi’s page of the plugin ${options.plugin} named a token it doesn’t hold: what it stood for is gone, or was never handed to it.`,
            )
          }
        },
        kinds,
        (kind) => {
          // (Likewise once a page: a tile that opens nothing is quiet.)
          if (reading.tokens.unnamedToSay()) {
            console.warn(unnamedLine(kind, `the plugin ${whose(options.plugin)}`))
          }
        },
      )
      swaps.set(part, swap)
    }
    return swap
  }
  // (What's read is sent down to its code once the box is there: nothing is read before.)
  const reading = new PageReading({
    context: options.context,
    plugin: options.plugin,
    handed: options.handed ?? { digest: '', codeDigest: '' },
    send: (text) => box.post(text),
    changed: () => ended({ why: 'changed' }),
  })
  const box = openBox({
    plugin: options.plugin,
    code: options.code,
    heard(text) {
      if (page.end) return
      const proposal = proposalIn(text)
      if (proposal !== undefined) return void propose(proposal)
      const ask = askIn(text)
      const taken = ask === undefined ? page.tree.take(text) : reading.ask(ask)
      if (taken && 'why' in taken) {
        // (For whoever writes the plugin: the line quotes nothing as it was written.)
        console.warn(`Lumovi stopped the plugin ${options.plugin}: ${taken.what}`)
        ended({ why: taken.why })
      } else if (taken) toDraw(taken.changed)
    },
    ended: (end) => ended(boxEnd(end)),
  })
  // A change the page proposes: checked by the door, then the person's to confirm in Lumovi's own
  // dialog. The page is told only what became of it.
  let refusalSaid = false
  const propose = async (said: object) => {
    const answer = (id: number, outcome: ProposalOutcome) => {
      if (!page.end) box.post(JSON.stringify({ proposed: id, outcome }))
    }
    const refuse = (id: number | undefined, why: string) => {
      // (For whoever writes the plugin, once a page; the line quotes nothing it wrote.)
      if (!refusalSaid) {
        refusalSaid = true
        console.warn(
          `Lumovi refused a change the page of the plugin ${options.plugin} proposed: ${why}`,
        )
      }
      if (id !== undefined) answer(id, 'refused')
    }
    const proposed = proposalProblem(said)
    if (typeof proposed === 'string') {
      const { propose: id } = said as { propose?: unknown }
      return refuse(
        typeof id === 'number' && Number.isSafeInteger(id) && id >= 1 ? id : undefined,
        proposed,
      )
    }
    if (!reading.tokens.spendPress(proposed.press, Date.now())) {
      return refuse(
        proposed.id,
        'it follows no press of the person’s, or one already spent or gone (a press is good once, for a moment)',
      )
    }
    const target =
      proposed.target === undefined ? undefined : reading.tokens.objectOf(proposed.target)
    const within = proposed.in === undefined ? undefined : reading.tokens.objectOf(proposed.in)
    if ((proposed.target !== undefined && !target) || (proposed.in !== undefined && !within)) {
      return refuse(proposed.id, 'it names an object this page doesn’t hold')
    }
    if (!options.propose) return refuse(proposed.id, 'nothing here asks the person')
    answer(
      proposed.id,
      await options.propose({ proposed, ...(target && { target }), ...(within && { within }) }),
    )
  }
  // A press is let go of once the page is hidden: nothing proposed after can follow it.
  const hidden = () => {
    if (document.visibilityState === 'hidden') reading.tokens.letPressGo()
  }
  document.addEventListener('visibilitychange', hidden)

  // What its code is told first: which page, or which tab and its object (read first, as its own
  // kind is). (Sent before the box is there, it waits in the box's channel for its code.)
  if (options.opening && 'page' in options.opening) {
    box.post(JSON.stringify({ open: { page: options.opening.page } }))
  } else if (options.opening) {
    reading.open(options.opening.tab, options.opening.object)
  }
  // The desktop measures a plugin's process, and says when it ended one.
  const stopEnded = api.desktop?.onPluginEnded((plugin, over) => {
    if (plugin === options.plugin) ended({ why: over })
  })
  // A server says when this browser's check failed after all: no plugin's code runs here then.
  const stopFailed = api.kube.onBoxCheckFailed?.(() => ended({ why: 'check-failed' }))
  stopListening = () => {
    stopEnded?.()
    stopFailed?.()
    document.removeEventListener('visibilitychange', hidden)
  }
  return page
}

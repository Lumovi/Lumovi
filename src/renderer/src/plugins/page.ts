/**
 * A plugin's page, open: its code in its box, what it sends taken by the door (its page's
 * commits by the tree, its asks to read by the reads), and the tree the door keeps for Lumovi to
 * draw. Whatever ends it (the box, the door, the main process) ends it once, with the reason a
 * person is told; its box is taken away with it, and its reads.
 */
import type { ComponentType, ReactNode } from 'react'
import type { Part } from '@shared/kit/declare'
import { DoorPage } from '@shared/plugin-door'
import type { PageEnd } from '@shared/plugin-ended'
import { api } from '@renderer/lib/api'
import { openBox, type BoxEnd } from './box'
import { PageReading } from './reads'

/** A part of Lumovi's a plugin may name: how it's declared, and what draws it. */
export interface KitPart {
  declared: Part
  /** Drawn with the properties the door checked, and what's inside it already drawn. */
  draw: ComponentType<{ props: Readonly<Record<string, unknown>>; children?: ReactNode }>
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
  /** Takes the page away: its box and its worker with it. */
  close(): void
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

/** Longer than any ask can be: its kind, its namespace and its name at their longest. */
const ASK_AT_MOST = 1024

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
}): OpenPage {
  const declared = Object.fromEntries(
    Object.entries(options.parts).map(([name, part]) => [name, part.declared]),
  )
  const listeners = new Set<() => void>()
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
    close() {
      stopListening?.()
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
  // The desktop measures a plugin's process, and says when it ended one.
  const stopListening = api.desktop?.onPluginEnded((plugin, over) => {
    if (plugin === options.plugin) ended({ why: over })
  })
  return page
}

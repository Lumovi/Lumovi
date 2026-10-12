/**
 * A plugin's page, open: its code in its box, what it sends taken by the door, and the tree the
 * door keeps for Lumovi to draw. Whatever ends it (the box, the door, the main process) ends it
 * once, with the reason a person is told; its box is taken away with it.
 */
import type { ComponentType, ReactNode } from 'react'
import type { Part } from '@shared/kit/declare'
import { DoorPage } from '@shared/plugin-door'
import type { PageEnd } from '@shared/plugin-ended'
import { api } from '@renderer/lib/api'
import { openBox, type BoxEnd } from './box'

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
  /**
   * Counts up when there's something new to draw: once a frame at most, however many commits
   * came in it, and at once when the page ends.
   */
  readonly version: number
  subscribe(changed: () => void): () => void
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

/** Opens the page of the plugin named `plugin` (its box's address), from its `code`. */
export function openPage(options: {
  plugin: string
  code: string
  parts: Readonly<Record<string, KitPart>>
}): OpenPage {
  const declared = Object.fromEntries(
    Object.entries(options.parts).map(([name, part]) => [name, part.declared]),
  )
  const listeners = new Set<() => void>()
  const page = {
    tree: new DoorPage(declared),
    parts: options.parts,
    end: undefined as PageEnd | undefined,
    version: 0,
    subscribe(changed: () => void) {
      listeners.add(changed)
      return () => void listeners.delete(changed)
    },
    fault() {
      ended({ why: 'drawing' })
    },
    close() {
      stopListening?.()
      cancelAnimationFrame(telling)
      box.close()
    },
  }
  const changed = () => {
    page.version++
    listeners.forEach((listener) => listener())
  }
  // What a plugin sends is drawn once a frame, however many commits a frame brings.
  let telling = 0
  const toDraw = () => {
    if (telling) return
    telling = requestAnimationFrame(() => {
      telling = 0
      if (!page.end) changed()
    })
  }
  const ended = (end: PageEnd) => {
    if (page.end) return
    page.end = end
    page.close()
    telling = 0
    changed()
  }
  const box = openBox({
    plugin: options.plugin,
    code: options.code,
    heard(text) {
      if (page.end) return
      const taken = page.tree.take(text)
      if ('why' in taken) {
        // (For whoever writes the plugin: the line quotes nothing as it was written.)
        console.warn(`Lumovi stopped the plugin ${options.plugin}: ${taken.what}`)
        ended({ why: taken.why })
      } else toDraw()
    },
    ended: (end) => ended(boxEnd(end)),
  })
  // The desktop measures a plugin's process, and says when it ended one.
  const stopListening = api.desktop?.onPluginEnded((plugin, over) => {
    if (plugin === options.plugin) ended({ why: over })
  })
  return page
}

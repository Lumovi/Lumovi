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
  /** Counts up with every change to the tree or its end: what a drawing subscribes to. */
  readonly version: number
  subscribe(changed: () => void): () => void
  /** Takes the page away: its box and its worker with it. */
  close(): void
}

/** What a box's end is to a person. */
const boxEnd = (end: BoxEnd): PageEnd =>
  end.why === 'failed'
    ? { why: 'failed', said: end.said }
    : end.why === 'silent'
      ? { why: 'silent' }
      : { why: end.over === 'not-text' ? 'not-allowed' : 'too-much' }

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
    end: undefined as PageEnd | undefined,
    version: 0,
    subscribe(changed: () => void) {
      listeners.add(changed)
      return () => void listeners.delete(changed)
    },
    close() {
      stopListening?.()
      box.close()
    },
  }
  const changed = () => {
    page.version++
    listeners.forEach((listener) => listener())
  }
  const ended = (end: PageEnd) => {
    if (page.end) return
    page.end = end
    page.close()
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
      } else changed()
    },
    ended: (end) => ended(boxEnd(end)),
  })
  // The desktop measures a plugin's process, and says when it ended one.
  const stopListening = api.desktop?.onPluginEnded((plugin, over) => {
    if (plugin === options.plugin) ended({ why: over })
  })
  return page
}

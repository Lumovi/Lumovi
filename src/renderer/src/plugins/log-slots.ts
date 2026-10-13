/**
 * Which of the Logs parts on plugins' pages stream now: at most `DOOR_LIMITS.logStreamsPage` on
 * a page, and `logStreamsPlugin` of a plugin's on all its pages and tabs open. The rest wait, and
 * start by themselves as others close, the first drawn first. Each part asks while it's drawn,
 * and gives its place back when it goes.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { DOOR_LIMITS } from '@shared/plugin-door'

/** Where a part stands: streaming, or waiting for a place on its page, or of its plugin. */
export type Slot = 'open' | 'page' | 'plugin'

interface Asked {
  plugin: string
  page: string
}

const asked: Asked[] = []
const heard = new Set<() => void>()
let version = 0

function changed() {
  version++
  for (const listener of heard) listener()
}

/** Where `one` stands among those asking, in the order they were drawn. */
export function slotOf(one: Asked, all: readonly Asked[] = asked): Slot {
  const onPage = new Map<string, number>()
  const ofPlugin = new Map<string, number>()
  for (const each of all) {
    const page = onPage.get(each.page) ?? 0
    const plugin = ofPlugin.get(each.plugin) ?? 0
    const fits = page < DOOR_LIMITS.logStreamsPage && plugin < DOOR_LIMITS.logStreamsPlugin
    if (each === one) {
      if (fits) return 'open'
      return page >= DOOR_LIMITS.logStreamsPage ? 'page' : 'plugin'
    }
    // (One waiting holds no place: only those streaming are counted.)
    if (fits) {
      onPage.set(each.page, page + 1)
      ofPlugin.set(each.plugin, plugin + 1)
    }
  }
  return 'open'
}

/** A Logs part's place: asked for while it's drawn, given back when it goes. */
export function useLogSlot(plugin: string, page: string, wanted: boolean): Slot {
  const [one] = useState<Asked>(() => ({ plugin, page }))
  useEffect(() => {
    if (!wanted) return
    asked.push(one)
    changed()
    return () => {
      asked.splice(asked.indexOf(one), 1)
      changed()
    }
  }, [one, wanted])
  useSyncExternalStore(
    (listener) => {
      heard.add(listener)
      return () => heard.delete(listener)
    },
    () => version,
  )
  // (Before it's taken its place, as if it had: it never streams for a moment it shouldn't.)
  return wanted ? slotOf(one, asked.includes(one) ? asked : [...asked, one]) : 'open'
}

/** Pages whose author has been told some of their Logs parts wait: once a page. */
const told = new Set<string>()
export function toldOnce(page: string): boolean {
  if (told.has(page)) return false
  told.add(page)
  return true
}

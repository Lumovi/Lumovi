/**
 * How much room the page has, and what it's used with. Only a browser's page (a server's) is
 * ever narrow: the desktop app's window stops at 1024 px, and it lays out as it always has.
 *
 *   wide    1024 px and up   the sidebar, a list, and a detail beside it
 *   tablet  640–1023 px      the sidebar is a drawer; a detail opens over the list
 *   phone   under 640 px     one column: two-line rows, sheets, a top bar
 *
 * Touch is its own question, asked of the pointer and not of the width: a tablet held sideways
 * is wide, and used with a finger. The stylesheet's `phone:`, `narrow:` and `touch:` variants
 * say the same in CSS (styles/index.css): these are for what CSS can't do, like which
 * component is there at all.
 */
import { useSyncExternalStore } from 'react'
import { api } from './api'

export type Layout = 'wide' | 'tablet' | 'phone'

/** Where each layout starts, in CSS pixels: the stylesheet's variants use the same. */
export const LAYOUT_WIDTHS = { phone: 640, wide: 1024 } as const

const NARROWS = api.host === 'server'
const PHONE = `(width < ${LAYOUT_WIDTHS.phone}px)`
const NARROW = `(width < ${LAYOUT_WIDTHS.wide}px)`
/** A finger, or anything else that can't hover or point finely. */
const TOUCH = '(hover: none), (pointer: coarse)'

function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (changed) => {
      if (!NARROWS) return () => undefined
      const media = window.matchMedia(query)
      media.addEventListener('change', changed)
      return () => media.removeEventListener('change', changed)
    },
    () => NARROWS && window.matchMedia(query).matches,
  )
}

/** The layout the page has room for now. */
export function useLayout(): Layout {
  const phone = useMedia(PHONE)
  const narrow = useMedia(NARROW)
  return phone ? 'phone' : narrow ? 'tablet' : 'wide'
}

/** Whether the page is used by touch: nothing may need a hover, and targets are a finger's size. */
export function useTouch(): boolean {
  return useMedia(TOUCH)
}

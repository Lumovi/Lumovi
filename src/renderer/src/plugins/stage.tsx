/**
 * A stage for a plugin's page, in the tests' build only (`main.tsx`): nothing in Lumovi shows a
 * plugin's page yet. The tests put a plugin's code on it and see what Lumovi draws: the page
 * through the box and the door, the strip above it, and what stands in its place once it ends.
 *
 * Its parts are the stage's own, as plain as parts can be; Lumovi's real ones come with the kit.
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { number, oneOf, text, yesOrNo, type PropsOf } from '@shared/kit/declare'
import type { PageEnd } from '@shared/plugin-ended'
import { openPage, type KitPart, type OpenPage } from './page'
import { PluginFrame } from './PluginFrame'
import { PluginSurface } from './Surface'
import { TheirText } from './TheirText'

const stack = {
  name: 'Stack',
  holds: 'parts',
  props: { gap: number(0, 8, true) },
} as const
const label = {
  name: 'Label',
  holds: 'text',
  props: { tone: oneOf(['plain', 'quiet']) },
} as const
const field = {
  name: 'Field',
  holds: 'nothing',
  props: { name: text(80), value: text(4000), lines: yesOrNo },
  required: ['name', 'value'],
} as const
/** A part of Lumovi's with a fault in it: it fails as it draws, whatever it's given. */
const faulty = { name: 'Faulty', holds: 'nothing', props: {} } as const

const PARTS: Record<string, KitPart> = {
  Stack: {
    declared: stack,
    draw: ({ props, children }) => (
      <div
        data-part="Stack"
        className="flex flex-col"
        style={{ gap: ((props as PropsOf<typeof stack>).gap ?? 2) * 4 }}
      >
        {children}
      </div>
    ),
  },
  Label: {
    declared: label,
    draw: ({ props, children }) => (
      <div
        data-part="Label"
        className={(props as PropsOf<typeof label>).tone === 'quiet' ? 'text-ink-3' : 'text-ink-1'}
      >
        {children}
      </div>
    ),
  },
  Field: {
    declared: field,
    draw: ({ props }) => {
      const { name, value, lines } = props as PropsOf<typeof field>
      return (
        <div data-part="Field" className="flex items-baseline gap-3 border-b border-line py-1.5">
          <TheirText text={name} className="w-40 shrink-0 text-ink-3" />
          <TheirText text={value} lines={lines} className="min-w-0 flex-1 text-ink-1" />
          {/* Lumovi's own, beside a plugin's text: nothing in that text may turn this round. */}
          <span data-testid="beside" className="shrink-0 text-ink-3">
            3 minutes ago
          </span>
        </div>
      )
    },
  },
  Faulty: {
    declared: faulty,
    draw: () => {
      throw new Error('a fault in a part of Lumovi’s own')
    },
  },
}

interface Shown {
  /** The plugin's name as its box is addressed, and as a person reads it. */
  plugin: string
  name: string
  version: string
  code: string
  /** An ending to show without waiting for it to happen (for a picture of each). */
  ended?: PageEnd
}

function Stage({ shown }: { shown: Shown }) {
  const [opened, setOpened] = useState(0)
  const [forced, setForced] = useState(shown.ended)
  const again = () => {
    setForced(undefined)
    setOpened((n) => n + 1)
  }
  return (
    <div
      data-testid="plugin-stage"
      data-opened={opened}
      className="fixed inset-0 z-[1000] flex flex-col bg-surface text-[13px]"
    >
      {forced ? (
        <PluginFrame name={shown.name} version={shown.version} end={forced} onAgain={again}>
          {null}
        </PluginFrame>
      ) : (
        <Opened key={opened} shown={shown} onAgain={again} />
      )}
    </div>
  )
}

/** The page, opened once for as long as this is shown: opening it again makes this anew. */
function Opened({ shown, onAgain }: { shown: Shown; onAgain: () => void }): ReactNode {
  const [page] = useState<OpenPage>(() =>
    openPage({ plugin: shown.plugin, code: shown.code, parts: PARTS }),
  )
  useEffect(() => () => page.close(), [page])
  const end = useSyncExternalStore(page.subscribe, () => page.end)
  return (
    <PluginFrame name={shown.name} version={shown.version} end={end} onAgain={onAgain}>
      <PluginSurface page={page} parts={PARTS} />
    </PluginFrame>
  )
}

let root: Root | undefined
let host: HTMLElement | undefined

/** What the tests reach (`window.__lumoviDoor`). */
export const stage = {
  show(shown: Shown): void {
    stage.hide()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    root.render(<Stage shown={shown} />)
  },
  hide(): void {
    root?.unmount()
    host?.remove()
    root = host = undefined
  },
}

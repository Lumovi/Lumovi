/**
 * A stage for a plugin's page, in the tests' build only (`main.tsx`): nothing in Lumovi shows a
 * plugin's page yet. The tests put a plugin's code on it and see what Lumovi draws: the page
 * through the box and the door, the strip above it, and what stands in its place once it ends.
 *
 * Its parts are the stage's own, as plain as parts can be; Lumovi's real ones come with the kit.
 */
import { useLayoutEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  choice,
  handed,
  handedFields,
  number,
  oneOf,
  record,
  text,
  wrongWith,
  wrongWithFields,
  wrongWithPart,
  wrongWithParts,
  yesOrNo,
  type PropsOf,
} from '@shared/kit/declare'
import { inPieces, shortInPieces, spelled } from '@shared/kit/characters'
import { tableProblem } from '@shared/kit/table'
import { placed } from '@shared/plugin-box'
import { DoorPage } from '@shared/plugin-door'
import { notHandedLine } from '@shared/plugin-hand-over'
import { changeProblem, parsePlugin } from '@shared/plugins'
import { asks } from '@shared/plugin-asks'
import { settle } from '@shared/plugin-loading'
import { callOf, mayStart, swapFor, Tokens } from '@shared/plugin-presses'
import { PLUGIN_SINCE } from '@shared/plugin-since'
import {
  granted,
  handedWhole,
  kindAsked,
  PageReads,
  picked,
  pickedRefusal,
  readable,
  readAsk,
  readQuery,
  resolvedAs,
  secretsNamed,
  selectors,
} from '@shared/plugin-reads'
import type { PageEnd } from '@shared/plugin-ended'
import { TooltipProvider } from '@renderer/components/Tooltip'
import { cn } from '@renderer/lib/cn'
import { elsewhere, linesAt, removeAt, renameAt, setAt } from '@renderer/lib/yaml-edit'
import { codeOf } from './box-check'
import { KIT_PARTS } from './kit'
import { Opened } from './opened'
import type { KitPart } from './page'
import { PluginFrame } from './PluginFrame'
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

/**
 * Says on the element it's given how many times its part has been drawn (`data-drawn`): for the
 * tests to see that a commit draws again only what it changed.
 */
function useDrawn<T extends HTMLElement>() {
  const element = useRef<T>(null)
  const times = useRef(0)
  useLayoutEffect(() => {
    times.current += 1
    if (element.current) element.current.dataset.drawn = String(times.current)
  })
  return element
}

const PARTS: Record<string, KitPart> = {
  Stack: {
    declared: stack,
    draw: function Stack({ props, children }) {
      const drawn = useDrawn<HTMLDivElement>()
      return (
        <div
          data-part="Stack"
          ref={drawn}
          className="flex flex-col"
          style={{ gap: ((props as PropsOf<typeof stack>).gap ?? 2) * 4 }}
        >
          {children}
        </div>
      )
    },
  },
  Label: {
    declared: label,
    draw: function Label({ props, children }) {
      const drawn = useDrawn<HTMLDivElement>()
      return (
        <div
          data-part="Label"
          ref={drawn}
          className={cn(
            'overflow-clip',
            (props as PropsOf<typeof label>).tone === 'quiet' ? 'text-ink-3' : 'text-ink-1',
          )}
        >
          {children}
        </div>
      )
    },
  },
  Field: {
    declared: field,
    draw: function Field({ props }) {
      const { name, value, lines } = props as PropsOf<typeof field>
      const drawn = useDrawn<HTMLDivElement>()
      return (
        <div
          data-part="Field"
          ref={drawn}
          className="flex items-baseline gap-3 border-b border-line py-1.5"
        >
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
  // Lumovi's own Table, for what's said with it (how a read was cut).
  Table: KIT_PARTS.Table!,
}

interface Shown {
  /** The plugin's name as its box is addressed, and as a person reads it. */
  plugin: string
  name: string
  version: string
  /** The test's own code; none, and the plugin's own is taken as Lumovi hands it over. */
  code?: string
  /** The cluster its reads are made in: none, and each is refused. */
  context?: string
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
        <PluginFrame
          name={shown.name}
          version={shown.version}
          end={forced}
          onAgain={again}
          onFault={() => undefined}
        >
          {null}
        </PluginFrame>
      ) : (
        <Opened
          key={opened}
          shown={{ ...shown, context: shown.context ?? '', parts: PARTS }}
          onAgain={again}
        />
      )}
    </div>
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
    // (Under the provider Lumovi's own page has: a kit part's tooltips need one.)
    root.render(
      <TooltipProvider delayDuration={500} skipDelayDuration={200}>
        <Stage shown={shown} />
      </TooltipProvider>,
    )
  },
  hide(): void {
    root?.unmount()
    host?.remove()
    root = host = undefined
  },
  /** A plugin's code as Lumovi hands it over: a server's check of this browser first, if due. */
  codeOf,
  /**
   * The door's own checks, a plugin file's, and how a text that isn't Lumovi's is drawn in
   * pieces, for the tests to try door.spec's, reads.spec's,
   * presses.spec's and plugins.spec's cases in this built page: what's measured of them is then
   * what ran in a page. With the release that first carried each thing a plugin can use of the
   * door, as this page holds it (plugin-since.spec's).
   */
  doorChecks: {
    DoorPage,
    wrongWith,
    wrongWithFields,
    wrongWithPart,
    wrongWithParts,
    handedFields,
    handed,
    number,
    record,
    choice,
    tableProblem,
    inPieces,
    shortInPieces,
    spelled,
    placed,
    notHandedLine,
    granted,
    handedWhole,
    kindAsked,
    PageReads,
    picked,
    pickedRefusal,
    readable,
    readAsk,
    readQuery,
    resolvedAs,
    secretsNamed,
    selectors,
    Tokens,
    swapFor,
    callOf,
    mayStart,
    parsePlugin,
    changeProblem,
    asks,
    settle,
    PLUGIN_SINCE,
  },
  /**
   * The edits Create's form makes to YAML text, for the tests to try yaml-edit.spec's cases in
   * this built page, as with the door's: what's measured of them is then what ran in a page.
   */
  yamlChecks: { setAt, removeAt, renameAt, elsewhere, linesAt },
}

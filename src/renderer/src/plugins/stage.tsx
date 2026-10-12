/**
 * A stage for a plugin's page, in the tests' build only (`main.tsx`): nothing in Lumovi shows a
 * plugin's page yet. The tests put a plugin's code on it and see what Lumovi draws: the page
 * through the box and the door, the strip above it, and what stands in its place once it ends.
 *
 * Its parts are the stage's own, as plain as parts can be; Lumovi's real ones come with the kit.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  handedFields,
  number,
  oneOf,
  text,
  wrongWith,
  wrongWithFields,
  wrongWithPart,
  wrongWithParts,
  yesOrNo,
  type PropsOf,
} from '@shared/kit/declare'
import { DoorPage } from '@shared/plugin-door'
import type { PageEnd } from '@shared/plugin-ended'
import type { PluginCode } from '@shared/plugin-hand-over'
import { cn } from '@renderer/lib/cn'
import { codeOf } from './box-check'
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
        <Opened key={opened} shown={shown} onAgain={again} />
      )}
    </div>
  )
}

/**
 * The page, opened once for as long as this is shown: opening it again makes this anew. With the
 * test's own code, as it's given; without, the plugin's code as Lumovi hands it over (or why
 * not), which is the only way a page outside the tests is ever given any.
 */
function Opened({ shown, onAgain }: { shown: Shown; onAgain: () => void }): ReactNode {
  const [handed, setHanded] = useState<PluginCode | undefined>(() =>
    shown.code === undefined
      ? undefined
      : { ok: true, code: shown.code, digest: '', codeDigest: '' },
  )
  useEffect(() => {
    if (shown.code !== undefined) return
    let here = true
    void codeOf(shown.plugin).then((answer) => here && setHanded(answer))
    return () => void (here = false)
  }, [shown])
  if (handed === undefined) return null
  if (!handed.ok) {
    return (
      <PluginFrame
        name={shown.name}
        version={shown.version}
        end={{ why: 'not-handed', refused: handed.refused }}
        onAgain={onAgain}
        onFault={() => undefined}
      >
        {null}
      </PluginFrame>
    )
  }
  return (
    <Running
      shown={shown}
      code={handed.code}
      handed={shown.code === undefined ? handed : undefined}
      onAgain={onAgain}
    />
  )
}

function Running({
  shown,
  code,
  handed,
  onAgain,
}: {
  shown: Shown
  code: string
  handed?: { digest: string; codeDigest: string }
  onAgain: () => void
}): ReactNode {
  const [page] = useState<OpenPage>(() =>
    openPage({
      plugin: shown.plugin,
      context: shown.context ?? '',
      code,
      ...(handed ? { handed: { digest: handed.digest, codeDigest: handed.codeDigest } } : {}),
      parts: PARTS,
    }),
  )
  useEffect(() => () => page.close(), [page])
  const end = useSyncExternalStore(page.subscribe, () => page.end)
  return (
    <PluginFrame
      name={shown.name}
      version={shown.version}
      end={end}
      onAgain={onAgain}
      onFault={page.fault}
    >
      <PluginSurface page={page} />
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
  /** A plugin's code as Lumovi hands it over: a server's check of this browser first, if due. */
  codeOf,
  /**
   * The door's own checks, for the tests to try door.spec's cases in this built page: what's
   * measured of them is then what ran in a page.
   */
  doorChecks: {
    DoorPage,
    wrongWith,
    wrongWithFields,
    wrongWithPart,
    wrongWithParts,
    handedFields,
  },
}

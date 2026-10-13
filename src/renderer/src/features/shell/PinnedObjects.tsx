/**
 * This cluster's pinned objects, in the sidebar under the pinned kinds: each its kind's icon, its
 * name (cut in its middle, its marks kept), its namespace quietly, its status now as a dot, and
 * the first nine their number key (⌥1–⌥9; none on a phone, nor in a browser on Linux, which keeps
 * Alt with a number for its tabs). Dragged to reorder, a 2 px line showing where. One that's gone
 * keeps its place and number, struck through and quiet; it and one the person may no longer read
 * say so, open their kind's list filtered to their name, and can be unpinned where they are. On a
 * phone a long press, or the row's "⋯", opens a sheet to open or unpin it.
 */
import { Ellipsis, PanelRightOpen, PinOff } from 'lucide-react'
import { useEffect, useRef, useState, type DragEvent } from 'react'
import { ContextMenu } from 'radix-ui'
import { create } from 'zustand'
import { useLocation } from 'react-router'
import { spelled } from '@shared/kit/characters'
import { MARKS_LIMITS, samePin, type Pin } from '@shared/marks'
import type { ResourceDefinition } from '@shared/resources'
import { IconButton } from '@renderer/components/Button'
import { KindIcon } from '@renderer/components/KindIcon'
import { ALT_KEY, Kbd } from '@renderer/components/Kbd'
import { Sheet } from '@renderer/components/Sheet'
import { StatusDot } from '@renderer/components/Status'
import { useGo } from '@renderer/hooks/go'
import { calledPin, useMarks, usePinning } from '@renderer/hooks/marks'
import { useObject } from '@renderer/hooks/queries'
import { MiddleCut } from '@renderer/kit/MiddleCut'
import { api, KubeApiError } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { statusOf } from '@renderer/lib/health'
import { useLayout } from '@renderer/lib/layout'
import { movingPin, repinning, unpinning } from '@renderer/lib/marks'
import { formatRef, kindPath } from '@renderer/lib/routes'
import { TheirText } from '@renderer/plugins/TheirText'
import { useCluster } from '@renderer/state/cluster'
import { useUi } from '@renderer/state/ui'
import { isEditable } from '../actions/ActionSurfaces'
import { menuContent, menuItem } from './menu-styles'
import { navItem } from './nav-style'

/** Whether pins have number keys here: not in a browser on Linux, where Alt+1–8 are its tabs'. */
export const PINS_NUMBERED = !(api.host === 'server' && api.platform === 'linux')

/** A pin's number key as it's written: "⌥1" on a Mac, "Alt+1" off one. */
export const pinKey = (number: number) => (ALT_KEY === '⌥' ? `⌥${number}` : `${ALT_KEY}+${number}`)

/** The pin a key opens (⌥1–⌥9, by the key's place: ⌥ with a number types a character on a Mac). */
export function pinNumber(
  event: Pick<KeyboardEvent, 'code' | 'altKey' | 'metaKey' | 'ctrlKey' | 'shiftKey'>,
): number | undefined {
  const digit = /^Digit([1-9])$/.exec(event.code)
  if (!digit || !event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return undefined
  return Number(digit[1])
}

/**
 * ⌥1–⌥9 open the first nine pins, where nothing is being typed and no dialog or menu is open (the
 * command palette has its own). None in a browser on Linux, nor on a phone.
 */
export function usePinKeys() {
  const { latest } = useMarks()
  const { context } = useCluster()
  const go = useGo()
  const phone = useLayout() === 'phone'
  useEffect(() => {
    if (!PINS_NUMBERED || phone) return
    const onKeyDown = (event: KeyboardEvent) => {
      const number = pinNumber(event)
      if (
        number === undefined ||
        isEditable(event.target) ||
        document.querySelector('[role="dialog"], [role="menu"]')
      )
        return
      const pin = latest().pins[number - 1]
      if (!pin) return
      event.preventDefault()
      go(pinPath(context, pin))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })
}

/** The cluster's pin keys, where it's open. */
export function PinKeys() {
  usePinKeys()
  return null
}

/** Where a pin opens: its object's detail, in its kind's list. */
export const pinPath = (context: string, pin: Pin) =>
  `${kindPath(context, pin.kind)}?open=${encodeURIComponent(formatRef(pin))}`

/** A kind's own name, as a sentence says it ("Deployment", "Widget"). */
export const kindName = (pin: Pin, served: ReadonlyMap<string, ResourceDefinition>) =>
  served.get(pin.kind)?.apiKind ?? pin.kind.split('.')[0]!

/** A pin unpinned in the drawer: shown where it was, with its Undo, until the drawer closes. */
interface Unpinned {
  pin: Pin
  kind: string
  at: number
}

/**
 * The pins unpinned in the drawer, which as a dialog keeps a screen reader in it, out of a
 * toast's reach: so the Undo is where the pin was. (Beside the page, it's the toast's.)
 */
export const useUnpinned = create<{
  list: Unpinned[]
  add(unpinned: Unpinned): void
  remove(pin: Pin): void
  clear(): void
}>((set) => ({
  list: [],
  add: (unpinned) => set((state) => ({ list: [...state.list, unpinned] })),
  remove: (pin) => set((state) => ({ list: state.list.filter((each) => !samePin(each.pin, pin)) })),
  clear: () => set({ list: [] }),
}))

export function PinnedObjects({ served }: { served: ReadonlyMap<string, ResourceDefinition> }) {
  const { marks, latest, save } = useMarks()
  const { unpin } = usePinning()
  const layout = useLayout()
  const phone = layout === 'phone'
  const drawer = layout !== 'wide'
  const numbered = PINS_NUMBERED && !phone
  const unpinned = useUnpinned((state) => state.list)
  const { add, remove, clear } = useUnpinned.getState()
  const open = useUi((ui) => ui.sidebar)
  // What a screen reader is told: an unpin, or why one wasn't.
  const [said, setSaid] = useState('')
  // Closed, the drawer's unpinned go with it (and with this cluster's sidebar).
  useEffect(() => {
    if (!open) clear()
  }, [open, clear])
  useEffect(() => clear, [clear])
  // Where a pin being dragged would go: before the pin at `to` (or last).
  const [drag, setDrag] = useState<{ from: number; to: number }>()
  const pins = marks.pins
  if (pins.length === 0 && unpinned.length === 0) return null
  const over = (event: DragEvent, index: number) => {
    if (!drag) return
    event.preventDefault()
    const box = event.currentTarget.getBoundingClientRect()
    const to = event.clientY < box.top + box.height / 2 ? index : index + 1
    if (to !== drag.to) setDrag({ ...drag, to })
  }
  const drop = () => {
    if (drag && drag.to !== drag.from && drag.to !== drag.from + 1) {
      const to = drag.to > drag.from ? drag.to - 1 : drag.to
      void save(movingPin(latest(), drag.from, to))
    }
    setDrag(undefined)
  }
  const unpinHere = async (pin: Pin, kind: string) => {
    const called = calledPin(kind, pin)
    if (!drawer) return unpin(pin, called)
    const { marks: next, at } = unpinning(latest(), pin)
    if (at < 0) return
    // (Its row turns unpinned in the same moment it leaves the pins.)
    add({ pin, kind, at })
    const why = await save(next)
    if (why) {
      remove(pin)
      return setSaid(why)
    }
    setSaid(`Unpinned ${called}.`)
  }
  const undo = async ({ pin, at }: Unpinned) => {
    const why = await save(repinning(latest(), pin, at))
    if (why) return setSaid(why)
    remove(pin)
  }
  // The pins in their order, each unpinned one back where it was.
  const rows: ({ pin: Pin; index: number } | { unpinned: Unpinned })[] = pins.map((pin, index) => ({
    pin,
    index,
  }))
  for (const each of [...unpinned].sort((a, b) => a.at - b.at)) {
    rows.splice(Math.min(each.at, rows.length), 0, { unpinned: each })
  }
  return (
    <>
      <div role="list" aria-label="Pinned objects">
        {rows.map((row) =>
          'unpinned' in row ? (
            <div key={`unpinned ${formatRef(row.unpinned.pin)}`} role="listitem">
              <UnpinnedRow unpinned={row.unpinned} onUndo={() => void undo(row.unpinned)} />
            </div>
          ) : (
            <div
              key={formatRef(row.pin)}
              role="listitem"
              className="relative"
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move'
                setDrag({ from: row.index, to: row.index })
              }}
              onDragOver={(event) => over(event, row.index)}
              onDrop={drop}
              onDragEnd={() => setDrag(undefined)}
            >
              {/* Where it would go: a 2 px line. */}
              {drag && drag.to === row.index && (
                <span
                  aria-hidden
                  className="absolute inset-x-2 -top-px z-10 h-0.5 rounded bg-accent"
                />
              )}
              {drag && row.index === pins.length - 1 && drag.to === pins.length && (
                <span
                  aria-hidden
                  className="absolute inset-x-2 -bottom-px z-10 h-0.5 rounded bg-accent"
                />
              )}
              <PinRow
                pin={row.pin}
                kind={kindName(row.pin, served)}
                number={numbered && row.index < MARKS_LIMITS.numbered ? row.index + 1 : undefined}
                onUnpin={() => void unpinHere(row.pin, kindName(row.pin, served))}
              />
            </div>
          ),
        )}
      </div>
      <p role="status" className="sr-only">
        {said}
      </p>
    </>
  )
}

/**
 * A pin just unpinned in the drawer: its crossed pin, its name quiet (not struck through, as one
 * that's gone is), and its Undo, a finger's size.
 */
function UnpinnedRow({ unpinned, onUndo }: { unpinned: Unpinned; onUndo: () => void }) {
  const { pin, kind } = unpinned
  return (
    <div className="flex items-center">
      <span className={cn(navItem(false), 'min-w-0 flex-1 text-ink-3 hover:bg-transparent')}>
        <PinOff aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 flex-1">
          <MiddleCut text={{ their: pin.name }} tip={false} />
        </span>
        <span className="shrink-0 text-xs">Unpinned</span>
      </span>
      <button
        type="button"
        aria-label={`Undo unpinning ${calledPin(kind, pin)}`}
        onClick={onUndo}
        className="h-11 shrink-0 rounded-lg px-3 text-[13px] font-medium text-accent-strong hover:bg-surface-3 active:bg-surface-3"
      >
        Undo
      </button>
    </div>
  )
}

/** How long a finger holds a pinned row for its sheet. */
const LONG_PRESS = 500

function PinRow({
  pin,
  kind,
  number,
  onUnpin,
}: {
  pin: Pin
  kind: string
  number?: number
  onUnpin: () => void
}) {
  const { context } = useCluster()
  const go = useGo()
  const location = useLocation()
  const phone = useLayout() === 'phone'
  const [sheet, setSheet] = useState(false)
  const held = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number }>(undefined)
  // A press that opened the sheet isn't also a tap on the row.
  const pressed = useRef(false)
  const object = useObject(pin.kind, pin.name, pin.namespace)
  const code = object.error instanceof KubeApiError ? object.error.code : undefined
  const gone = code === 'not-found'
  const unreadable = code === 'forbidden' || code === 'not-allowed'
  const status = object.data && statusOf(pin.kind, object.data)
  // As a screen reader and a tooltip say it: the cluster's text spelled.
  const where = pin.namespace ? ` in ${spelled(pin.namespace)}` : ''
  const called = `${kind} ${spelled(pin.name)}`
  // One that's gone, or can't be read, opens its kind's list filtered to its name.
  const to =
    gone || unreadable
      ? `${kindPath(context, pin.kind)}?q=${encodeURIComponent(pin.name)}`
      : pinPath(context, pin)
  const current = new URLSearchParams(location.search).get('open') === formatRef(pin)
  const said = gone
    ? `${called}${where} isn’t in the cluster any more.`
    : unreadable
      ? 'You can’t read it any more'
      : status
        ? `${called}${where}, ${status.label}`
        : `${called}${where}`
  const letGo = () => {
    if (held.current) clearTimeout(held.current.timer)
    held.current = undefined
  }
  const link = (
    <a
      href={to}
      title={gone || unreadable ? said : undefined}
      aria-label={
        gone
          ? `${called}${where}: not in the cluster any more`
          : unreadable
            ? `${called}${where}: you can’t read it any more`
            : said
      }
      aria-current={current ? 'page' : undefined}
      className={cn(navItem(current), 'min-w-0 flex-1')}
      onClick={(event) => {
        event.preventDefault()
        if (pressed.current) {
          pressed.current = false
          return
        }
        go(to)
      }}
      // On a phone, a long press opens its sheet (where the browser says so, a context menu's).
      onContextMenu={(event) => {
        if (!phone) return
        event.preventDefault()
        letGo()
        setSheet(true)
      }}
      onPointerDown={(event) => {
        if (!phone || event.pointerType !== 'touch') return
        pressed.current = false
        const timer = setTimeout(() => {
          held.current = undefined
          pressed.current = true
          setSheet(true)
        }, LONG_PRESS)
        held.current = { timer, x: event.clientX, y: event.clientY }
      }}
      onPointerMove={(event) => {
        const at = held.current
        if (at && Math.hypot(event.clientX - at.x, event.clientY - at.y) > 8) letGo()
      }}
      onPointerUp={letGo}
      onPointerCancel={letGo}
    >
      <KindIcon kind={pin.kind} className="size-4 shrink-0 text-ink-3" />
      {/* (Struck through to its drawn letters, which stand apart from the span: only one that's
          gone. One that can't be read is quiet.) */}
      <span
        className={cn(
          'min-w-0 flex-1',
          (gone || unreadable) && 'text-ink-3',
          gone && 'line-through [&_*]:line-through',
        )}
      >
        <MiddleCut text={{ their: pin.name }} tip={false} />
      </span>
      {pin.namespace && (
        <span className="max-w-[40%] shrink-[99] truncate text-xs text-ink-3">
          <TheirText text={{ their: pin.namespace }} inline />
        </span>
      )}
      {status && !gone && !unreadable && <StatusDot health={status.health} />}
      {number !== undefined && (
        <span aria-hidden className="shrink-0">
          <Kbd>{pinKey(number)}</Kbd>
        </span>
      )}
    </a>
  )
  return (
    <div className="flex items-center">
      {/* Where there's a pointer, its context menu opens or unpins it. */}
      {phone ? (
        link
      ) : (
        <ContextMenu.Root>
          <ContextMenu.Trigger asChild>{link}</ContextMenu.Trigger>
          <ContextMenu.Portal>
            <ContextMenu.Content className={menuContent}>
              <ContextMenu.Item className={menuItem} onSelect={() => go(to)}>
                <PanelRightOpen className="size-4 text-ink-3" /> Open
              </ContextMenu.Item>
              <ContextMenu.Item className={menuItem} onSelect={onUnpin}>
                <PinOff className="size-4 text-ink-3" /> Unpin
              </ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Portal>
        </ContextMenu.Root>
      )}
      {/* What a finger can't do by pressing and holding, a button does; and one that can't be
          opened any more can be unpinned where it is. */}
      {phone ? (
        <button
          type="button"
          aria-label={`More for ${called}`}
          onClick={() => setSheet(true)}
          className="grid size-11 shrink-0 place-items-center rounded-lg text-ink-3 active:bg-surface-3"
        >
          <Ellipsis className="size-4" />
        </button>
      ) : (
        (gone || unreadable) && (
          <IconButton
            label={`Unpin ${called} from the sidebar`}
            tipSide="right"
            onClick={onUnpin}
            className="size-7 text-ink-3"
          >
            <PinOff />
          </IconButton>
        )
      )}
      {sheet && (
        <Sheet title={called} onClose={() => setSheet(false)}>
          <div className="flex flex-col px-2 pb-3">
            <button
              type="button"
              onClick={() => {
                setSheet(false)
                go(to)
              }}
              className="flex h-11 items-center gap-3 rounded-lg px-2 text-[15px] text-ink-1 active:bg-surface-3"
            >
              <PanelRightOpen className="size-5 text-ink-3" /> Open
            </button>
            <button
              type="button"
              onClick={() => {
                setSheet(false)
                onUnpin()
              }}
              className="flex h-11 items-center gap-3 rounded-lg px-2 text-[15px] text-ink-1 active:bg-surface-3"
            >
              <PinOff className="size-5 text-ink-3" /> Unpin
            </button>
          </div>
        </Sheet>
      )}
    </div>
  )
}

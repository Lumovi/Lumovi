import { CircleAlert, CircleCheck, Info, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@renderer/lib/cn'
import { cutToFit } from '@renderer/lib/fit'
import { useToasts, type SheetKind, type Toast } from '@renderer/state/toasts'

/** How long a toast stays; longer for errors, which take a moment to read. */
const DURATION = { success: 6_000, info: 8_000, error: 10_000 }

const ICONS = {
  success: [CircleCheck, 'text-good-text'],
  info: [Info, 'text-ink-2'],
  error: [CircleAlert, 'text-critical-text'],
} as const

/** What a sheet must have to itself, in px, for a note to be shown in it: less, and the note waits. */
const ROOM_FOR_A_STRIP = 360
/** A sheet's top is this far under the screen's (components/Sheet.tsx). */
const SHEET_TOP = 24

/** Whether an open sheet has the height for a note's strip (a short window, a keyboard up: no). */
function useRoom(): boolean {
  return useSyncExternalStore(
    (changed) => {
      const viewport = window.visualViewport
      viewport?.addEventListener('resize', changed)
      window.addEventListener('resize', changed)
      return () => {
        viewport?.removeEventListener('resize', changed)
        window.removeEventListener('resize', changed)
      }
    },
    () => (window.visualViewport?.height ?? window.innerHeight) - SHEET_TOP >= ROOM_FOR_A_STRIP,
  )
}

/**
 * Outcomes of changes, stacked in the bottom-right corner. On a phone they're across the bottom,
 * above the pill of changes that wait when there is one (it says how far up: `--over-pill`). And
 * while a sheet is open on a phone a note isn't over it at all: it's the sheet's own first line
 * (`NoteStrip`, in the place `Sheet.tsx` keeps for it), or, where the sheet has too little
 * height, it waits until the sheet has closed.
 */
export function Toaster() {
  const toasts = useToasts((state) => state.toasts)
  const slot = useToasts((state) => state.slots.at(-1))
  const room = useRoom()
  const where = !slot ? 'floating' : room ? 'in the sheet' : 'waiting'
  const some = toasts.length > 0
  return (
    <>
      <section
        aria-label="Notifications"
        className={cn(
          'pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[380px] max-w-[calc(100vw-32px)] flex-col items-stretch gap-2 phone:bottom-[var(--over-pill,calc(env(safe-area-inset-bottom)+16px))] phone:left-4 phone:w-auto',
          where !== 'floating' && 'hidden',
        )}
      >
        {toasts.map((t) => (
          <ToastCard key={t.id} toast={t} where={where} />
        ))}
      </section>
      {where === 'in the sheet' &&
        some &&
        createPortal(
          <NoteStrip toasts={toasts} kind={slot!.dataset.noteSlot as SheetKind} />,
          slot!,
        )}
    </>
  )
}

/**
 * A note inside an open sheet: one line, or two where its sentence needs them, of a height
 * that's fixed once it shows. The newest failure if there is one, otherwise the newest, and
 * how many more there are (a number only). It leaves when its note's time is up.
 */
function NoteStrip({ toasts, kind }: { toasts: Toast[]; kind: SheetKind }) {
  const shown = toasts.findLast((t) => t.tone === 'error') ?? toasts.at(-1)!
  const more = toasts.length - 1
  const [Icon, color] = ICONS[shown.tone]
  const [lines, setLines] = useState<1 | 2>(1)
  const said = shown.inSheet?.[kind] ?? {
    lead: '',
    before: shown.title,
    name: '',
    after: '',
  }
  const whole = `${said.lead} ${said.before}${said.name}${said.after}`.trim()
  const box = useRef<HTMLSpanElement>(null)
  const rest = useRef<HTMLSpanElement>(null)
  // (Its words are written here, not by React: they're measured as they're tried. Its height
  // is decided once for a note and doesn't change while it shows; its words are fitted again
  // whenever the count beside them comes, grows or goes, since that's room taken or given back.)
  const decided = useRef<{ id: number; lines: 1 | 2 }>(undefined)
  useLayoutEffect(() => {
    const line = parseFloat(getComputedStyle(box.current!).lineHeight)
    const within = (most: number) => (candidate: string) => {
      rest.current!.textContent = candidate
      return box.current!.offsetHeight <= line * most + 1
    }
    const all = `${said.before}${said.name}${said.after}`
    if (decided.current?.id !== shown.id) {
      decided.current = { id: shown.id, lines: within(1)(all) ? 1 : 2 }
      setLines(decided.current.lines)
    }
    rest.current!.textContent = cutToFit({ ...said, fits: within(decided.current!.lines) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown.id, more, kind])
  return (
    <div
      role={shown.tone === 'error' ? 'alert' : 'status'}
      data-note-strip
      className={cn(
        'flex shrink-0 gap-2 overflow-hidden border-b border-line px-4 text-xs leading-4 transition-opacity duration-150 motion-reduce:transition-none',
        lines === 1 ? 'h-8 items-center' : 'h-12 items-start py-2',
        shown.leaving && 'opacity-0',
      )}
    >
      <Icon className={cn('size-3.5 shrink-0', lines === 2 && 'mt-px', color)} />
      {/* All of it, for a screen reader; what shows may have the name's middle cut. */}
      <span className="sr-only">{whole}</span>
      <span ref={box} aria-hidden className="min-w-0 flex-1 text-ink-2">
        {said.lead && <span className="font-medium text-ink-1">{said.lead} </span>}
        <span ref={rest} />
      </span>
      {more > 0 && <span className="shrink-0 text-ink-3">and {more} more</span>}
    </div>
  )
}

function ToastCard({ toast, where }: { toast: Toast; where: string }) {
  const dismiss = useToasts((state) => state.dismiss)
  const leave = useToasts((state) => state.leave)
  // A toast stays while it's pointed at or has focus (say, on its Undo button). Pointed at with
  // a mouse: a finger that tapped where one then appears isn't holding it there. And its time
  // doesn't run while it waits for a sheet to close: it counts from when it's shown.
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const floating = where === 'floating'
  const paused = (floating && (hovered || focused)) || where === 'waiting'
  const leaving = toast.leaving === true

  useEffect(() => {
    if (paused || leaving) return
    const timer = setTimeout(() => leave(toast.id), DURATION[toast.tone])
    return () => clearTimeout(timer)
  }, [paused, leaving, leave, toast.id, toast.tone])
  // (Floating, it's gone when its way out has been drawn; in a sheet, after the strip's fade.)
  useEffect(() => {
    if (!leaving || floating) return
    const timer = setTimeout(() => dismiss(toast.id), 150)
    return () => clearTimeout(timer)
  }, [leaving, floating, dismiss, toast.id])

  const [Icon, color] = ICONS[toast.tone]
  return (
    <div
      role={toast.tone === 'error' ? 'alert' : 'status'}
      data-paused={paused || undefined}
      onPointerEnter={(event) => setHovered(event.pointerType === 'mouse')}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
      }}
      onAnimationEnd={() => {
        if (leaving) dismiss(toast.id)
      }}
      className={cn(
        'pointer-events-auto flex items-start gap-3 rounded-xl border border-line-strong bg-surface-2 py-3 pr-2 pl-3.5 shadow-pop',
        leaving ? 'animate-toast-out' : 'animate-toast-in',
      )}
    >
      <Icon className={cn('mt-px size-[18px] shrink-0 animate-spin-once', color)} />
      <div className="min-w-0 flex-1 py-px">
        <p className="text-[13px] leading-snug font-medium text-ink-1">{toast.title}</p>
        {toast.description && (
          <p className="mt-0.5 line-clamp-3 text-xs leading-relaxed text-ink-2 selectable">
            {toast.description}
          </p>
        )}
      </div>
      {toast.action && (
        <button
          type="button"
          onClick={() => {
            toast.action!.run()
            leave(toast.id)
          }}
          className="shrink-0 rounded-md px-2 py-0.5 text-[13px] font-medium text-accent-strong hover:bg-accent-soft"
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => leave(toast.id)}
        className="grid size-6 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-surface-3 hover:text-ink-1"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}

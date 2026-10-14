/**
 * The second-level header of a plugin's page: what's picked, its status, and what can be done
 * with it. At most three buttons show, the one that matters most last: the last that changes
 * something stands at the end, filled, and the rest keep the plugin's order (none is filled
 * where none changes anything: a button that only reads or goes never is). With more, "…" stands
 * before the last and holds the rest. On a phone a plugin's buttons that change the cluster
 * aren't offered: one line says where they are. What a button does, where the plugin says, is
 * under them; and one it says can't be pressed now is off, and says why.
 */
import { Ellipsis, Info, LoaderCircle } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import {
  createContext,
  Fragment,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { spelled } from '@shared/kit/characters'
import type { Going } from '@shared/kit/declare'
import { BUTTONS_SHOWN, filledLast, type HeaderButton, type HeaderProps } from '@shared/kit/page'
import { BusyButton, Elapsed } from '@renderer/components/Busy'
import { Button } from '@renderer/components/Button'
import { Tooltip } from '@renderer/components/Tooltip'
import { cn } from '@renderer/lib/cn'
import { useLayout, useTouch } from '@renderer/lib/layout'
import { offered, REACH_ICONS, reachTip } from '@renderer/plugins/reach'
import { PageIdentity } from '@renderer/plugins/Surface'
import { TheirText } from '@renderer/plugins/TheirText'
import { menuContent, menuItem } from '../features/shell/menu-styles'
import { fitKey, fromFitKey } from './fit-key'
import { MiddleCut } from './MiddleCut'
import { keyOf, Pill } from './Table'

/**
 * Whether what's picked is named already, as the first line of its page (a split's second page,
 * on a phone): a header there doesn't say the name again.
 */
export const NamedAbove = createContext(false)

/** A button's name as a screen reader says it: spelled, and "…" where it asks first. */
const called = (button: HeaderButton) => `${spelled(button.name.their)}${button.asks ? '…' : ''}`

/**
 * A button's name as it's drawn, the plugin's in pieces: one that asks first ends in "…", right
 * against it (one text, so a button's gap never comes between them).
 */
const drawn = (button: HeaderButton) => {
  // (One that goes to a place of Lumovi's has Lumovi's icon for it before the plugin's word.)
  const Icon = button.goes?.to === 'reach' ? REACH_ICONS[button.goes.at] : undefined
  return (
    <>
      {Icon && <Icon aria-hidden />}
      <span>
        <TheirText text={button.name} inline />
        {button.asks && '…'}
      </span>
    </>
  )
}

/** Where a button that goes somewhere goes, in Lumovi's words: its tooltip. */
const goesTip = (button: HeaderButton) =>
  button.goes?.to === 'reach' ? reachTip(button.goes) : undefined

/** How many names the phone's line says before "and N more". */
const NAMED_AT_MOST = 5

/** A header with no buttons: the same none each time it's drawn. */
const NO_BUTTONS: readonly HeaderButton[] = []

/**
 * How many characters of its name a header keeps (all of a shorter one): its buttons fold into
 * "…" first, and where even that leaves less, the name takes a line of its own.
 */
const NAME_FLOOR = 12
/** A button's padding and border, beside its name; and the whole of "…"'s. */
const BUTTON_EDGES = 26
const MORE_WIDTH = 34

let canvas: CanvasRenderingContext2D | null | undefined

/** How wide a text is in `element`'s face. */
function widthIn(element: Element): (text: string) => number {
  canvas ??= document.createElement('canvas').getContext('2d')
  const style = getComputedStyle(element)
  if (canvas) {
    canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  }
  return (text) => (canvas ? canvas.measureText(text).width : 0)
}

/**
 * How a desktop header lays out its buttons (`labels`, as each is drawn) beside its name: how
 * many show, three at most (two, and "…", where it has more), fewer where they'd leave its name
 * less than its floor, down to the last alone; and whether, with that, the name still hasn't its
 * floor and takes a line of its own, its status and buttons on the next. The status and the
 * buttons are never cut; the rest are behind "…".
 */
function fitting(
  header: HTMLElement,
  name: string,
  labels: readonly string[],
): { shown: number; split: boolean } {
  const most = labels.length > BUTTONS_SHOWN ? BUTTONS_SHOWN - 1 : labels.length
  const heading = header.querySelector('h2')
  const button = header.querySelector('[data-buttons] button')
  if (!heading || !button) return { shown: most, split: false }
  const status = header.querySelector('[data-status]')?.getBoundingClientRect().width ?? 0
  const named = widthIn(button)
  const widths = labels.map((label) => named(label) + BUTTON_EDGES)
  const needs = (shown: number) => {
    const folds = shown < labels.length
    return (
      widths.slice(-shown).reduce((sum, each) => sum + each, 0) +
      (folds ? MORE_WIDTH : 0) +
      8 * (shown - (folds ? 0 : 1))
    )
  }
  const showing = (room: number) => {
    for (let shown = most; shown > 1; shown--) if (needs(shown) <= room) return shown
    return 1
  }
  const face = widthIn(heading)
  const floor = Math.min(face('0'.repeat(NAME_FLOOR)), face(name))
  // (Less the gaps: one after the name, one after a status, and the buttons' own inset.)
  const beside = header.clientWidth - floor - status - 28
  if (needs(1) <= beside) return { shown: showing(beside), split: false }
  // (Under the name: less the gap after a status, and the buttons' inset.)
  return { shown: showing(header.clientWidth - status - (status ? 18 : 8)), split: true }
}

type Variant = 'primary' | 'secondary' | 'ghost'

/**
 * Lumovi's word for a button it holds busy: the change its press led to was sent, and the plugin
 * hasn't drawn since. True of any change, whatever the tool then does.
 */
export const SENT = 'Sent'

/** A button at work, as it's drawn: the plugin's word and time, or Lumovi's while it holds it. */
function busyOf(
  button: HeaderButton,
  held: string | undefined,
): { word: string; text: ReactNode; since?: number } | undefined {
  if (button.busy) {
    const since = button.busy.since === undefined ? NaN : Date.parse(button.busy.since)
    return {
      word: spelled(button.busy.word.their),
      text: <TheirText text={button.busy.word} inline />,
      ...(Number.isFinite(since) ? { since } : {}),
    }
  }
  return keyOf(button) === held ? { word: SENT, text: SENT } : undefined
}

/** A button that's off: as a disabled one looks, its fill, border and text kept, and still. */
const OFF: Record<Variant, string> = {
  primary: 'cursor-default opacity-50 hover:bg-accent active:translate-y-0',
  secondary: 'cursor-default opacity-50 hover:bg-surface-2 active:translate-y-0',
  ghost: 'cursor-default opacity-50 hover:bg-transparent hover:text-ink-2',
}

/**
 * One of a header's buttons. Where the plugin says it can't be pressed now, it's off: in its
 * place, and found by the keyboard as any other, with why in its tooltip (on hover and on focus)
 * and in what a screen reader says of it; and a press of it goes nowhere.
 */
function Action({
  button,
  held,
  focusKey,
  variant,
  className,
  onPress,
}: {
  button: HeaderButton
  held: string | undefined
  /** Which button it is, the same busy or not: where the keyboard comes back to (lib/focus-back). */
  focusKey: string
  variant: Variant
  className?: string
  onPress: () => void
}) {
  const reason = useId()
  const tip = goesTip(button)
  // At work: where it was, busy, and a press of it goes nowhere.
  const busy = busyOf(button, held)
  if (busy) {
    return (
      <BusyButton
        name={spelled(button.name.their)}
        word={busy.word}
        {...(busy.since === undefined ? {} : { since: busy.since })}
        className={className}
        focusKey={focusKey}
      >
        {busy.text}
      </BusyButton>
    )
  }
  if (tip) {
    // (A link: never the filled one, and where it goes is Lumovi's to say.)
    return (
      <>
        <Tooltip content={tip}>
          <Button
            variant="secondary"
            className={className}
            aria-label={called(button)}
            aria-describedby={reason}
            data-focus-key={focusKey}
            onClick={onPress}
          >
            {drawn(button)}
          </Button>
        </Tooltip>
        <span id={reason} hidden>
          {tip}
        </span>
      </>
    )
  }
  if (!button.off) {
    return (
      <Button
        variant={variant}
        className={className}
        aria-label={called(button)}
        data-focus-key={focusKey}
        onClick={onPress}
      >
        {drawn(button)}
      </Button>
    )
  }
  return (
    <>
      <Tooltip content={<TheirText text={button.off} inline />}>
        <Button
          variant={variant}
          className={cn(className, OFF[variant])}
          aria-label={called(button)}
          aria-disabled="true"
          aria-describedby={reason}
        >
          {drawn(button)}
        </Button>
      </Tooltip>
      {/* (Beside it, not in it: its name is only its own.) */}
      <span id={reason} hidden>
        {spelled(button.off.their)}
      </span>
    </>
  )
}

/**
 * One of the buttons "…" holds, as Lumovi's own menu draws one. Off, it's dimmed and stays in the
 * keys' order, said off, with why on a line under its name (two lines at most, whole in its
 * tooltip): on screen, where nothing needs a pointer to find it. Choosing it does nothing.
 */
function Folded({
  button,
  held,
  onPress,
}: {
  button: HeaderButton
  held: string | undefined
  onPress: () => void
}) {
  const reason = useId()
  const busy = busyOf(button, held)
  if (busy) {
    return (
      <DropdownMenu.Item
        className={cn(menuItem, 'text-ink-2')}
        data-busy=""
        aria-label={`${called(button)}, busy: ${busy.word.toLowerCase()}`}
        aria-disabled="true"
        onSelect={(event) => event.preventDefault()}
      >
        <LoaderCircle aria-hidden className="animate-spin text-ink-3" />
        <span className="flex-1">{busy.text}</span>
        {busy.since !== undefined && (
          <span className="text-xs text-ink-3 tabular-nums">
            <Elapsed since={busy.since} />
          </span>
        )}
      </DropdownMenu.Item>
    )
  }
  if (!button.off) {
    return (
      <DropdownMenu.Item
        className={menuItem}
        aria-label={called(button)}
        {...(goesTip(button) ? { title: goesTip(button) } : {})}
        onSelect={onPress}
      >
        {drawn(button)}
      </DropdownMenu.Item>
    )
  }
  return (
    <DropdownMenu.Item
      className={cn(menuItem, 'h-auto flex-col items-start gap-0.5 py-1.5 touch:h-auto')}
      aria-label={called(button)}
      aria-disabled="true"
      aria-describedby={reason}
      // (Chosen, it does nothing, and the menu stays open.)
      onSelect={(event) => event.preventDefault()}
    >
      <span className="opacity-45">{drawn(button)}</span>
      <span
        id={reason}
        title={spelled(button.off.their)}
        className="line-clamp-2 max-w-64 text-xs leading-snug text-ink-3 touch:line-clamp-none"
      >
        <TheirText text={button.off} inline />
      </span>
    </DropdownMenu.Item>
  )
}

/**
 * What the buttons do, where the plugin says, in their order: quiet, each two lines at most and
 * whole in its tooltip. On a phone every button's, those it doesn't offer too: what a button
 * does is said even where it isn't (that deleting a thing deletes what it made, say). Where it
 * isn't plain which button a note is of (more than one, or a phone's, with no buttons over it),
 * Lumovi says: the button's name, then the plugin's words.
 *
 * Under a finger nothing hovers, so what a tooltip holds for a pointer is on the page: each line
 * wraps whole, and why a button here (`drawn`) is off stands with them, before what it does, in a
 * line that says so: the button's name, Lumovi's "is off", then the plugin's reason.
 */
function Notes({
  buttons,
  drawn,
  named,
  className,
}: {
  buttons: readonly HeaderButton[]
  /** The buttons drawn as buttons here: one that's off says why in its tooltip, to a pointer. */
  drawn: readonly HeaderButton[]
  named: boolean
  className?: string
}) {
  const touch = useTouch()
  const lines = buttons.flatMap((button) => [
    ...(touch && button.off && drawn.includes(button)
      ? [{ key: `${keyOf(button)} off`, button, text: button.off, off: true }]
      : []),
    ...(button.note ? [{ key: keyOf(button), button, text: button.note, off: false }] : []),
  ])
  if (lines.length === 0) return null
  const whose = named || lines.length > 1
  return (
    <div className={cn('flex flex-col gap-0.5', className)}>
      {lines.map(({ key, button, text, off }) => {
        // (Why one is off always names it: nothing else says which, or that it's a reason.)
        const before = off ? ' is off: ' : whose ? ': ' : undefined
        return (
          <p
            key={key}
            data-off-reason={off ? '' : undefined}
            title={`${before ? `${spelled(button.name.their)}${before}` : ''}${spelled(text.their)}`
              .replace(/\s+/g, ' ')
              .trim()}
            className="flex items-start gap-1.5 text-left text-xs leading-[17px] text-ink-2"
          >
            <Info aria-hidden className="mt-px size-3.5 shrink-0" />
            <span className="line-clamp-2 [overflow-wrap:anywhere] touch:line-clamp-none">
              {before && (
                <span className="font-medium text-ink-1">
                  <TheirText text={button.name} inline />
                  {before}
                </span>
              )}
              <TheirText text={text} inline />
            </span>
          </p>
        )
      })}
    </div>
  )
}

/**
 * Where a phone's missing buttons are, in Lumovi's words. Each name is the plugin's text inside
 * Lumovi's sentence: its own island of direction, so nothing in it can turn the sentence round.
 */
function OnALargerScreen({ buttons }: { buttons: readonly HeaderButton[] }) {
  const named = buttons.length > NAMED_AT_MOST ? buttons.slice(0, NAMED_AT_MOST - 1) : buttons
  const more = buttons.length - named.length
  return (
    <p className="text-xs leading-relaxed text-ink-3">
      Open Lumovi on a larger screen to use{' '}
      {named.map((button, i) => (
        <Fragment key={keyOf(button)}>
          {i > 0 && (i === named.length - 1 && !more ? ' and ' : ', ')}
          <span className="font-medium text-ink-2">
            <TheirText text={button.name} inline />
          </span>
        </Fragment>
      ))}
      {more > 0 && ` and ${more} more`}.
    </p>
  )
}

export function PageHeader({
  header,
  held,
  onPress,
  go,
}: {
  header: HeaderProps
  /** The key of a button Lumovi holds busy, the change its press led to sent. */
  held?: string
  onPress?: HeaderProps['onPress']
  /** Lumovi's own open of where a button goes: never told to the plugin. */
  go?: (to: Going) => void
}) {
  const layout = useLayout()
  const phone = layout === 'phone'
  const namedAbove = useContext(NamedAbove)
  const all = header.buttons ?? NO_BUTTONS
  // (One that goes to a place Lumovi doesn't have here isn't drawn: a forward on a server; on a
  // phone, a shell's joins the line that says where the changes are.)
  const elsewhereHere = (button: HeaderButton) =>
    button.goes?.to === 'reach' && button.goes.at === 'shell' && phone
  const buttons = useMemo(
    () =>
      all.filter(
        (button) =>
          button.goes?.to !== 'reach' || offered(button.goes.at, layout) || elsewhereHere(button),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- (`elsewhereHere` is of `phone`.)
    [all, layout, phone],
  )
  // The desktop's row, as it's drawn: the last that changes something moved to the end. It's the
  // filled one, off for now or not. (One that only reads or goes never is.)
  const ordered = useMemo(() => filledLast(buttons), [buttons])
  const filled = ordered.at(-1)?.changes === true ? ordered.at(-1) : undefined
  // (Which button it is, busy or not, for the keyboard to come back to: this header's, by its name.)
  const page = useContext(PageIdentity)
  const focusKeyOf = (button: HeaderButton) =>
    `header:${page}:${spelled(header.name.their)}:${keyOf(button)}`
  const press = (button: HeaderButton) =>
    button.goes ? go?.(button.goes) : onPress?.({ button: button.key })
  // How many buttons the desktop's row has room for, measured as it's laid out and whenever its
  // width changes.
  const groupRef = useRef<HTMLDivElement>(null)
  const [fits, setFits] = useState<{ shown: number; split: boolean }>()
  // (What it's measured by, as one key: a page drawn anew with the same buttons isn't remeasured.)
  const drawnAs = fitKey(
    spelled(header.name.their),
    `${header.status?.word.their ?? ''} ${header.secondStatus?.word.their ?? ''}`,
    ordered.map((button) => {
      const busy = busyOf(button, held)
      return busy
        ? `${busy.word}${busy.since === undefined ? '' : ' 00m 00s'}`
        : `${spelled(button.name.their)}${button.asks ? '…' : ''}`
    }),
  )
  useLayoutEffect(() => {
    const group = groupRef.current
    if (!group) return
    const { name, labels } = fromFitKey(drawnAs)
    const fit = () =>
      setFits((was) => {
        const now = fitting(group, name, labels)
        return was?.shown === now.shown && was.split === now.split ? was : now
      })
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(group)
    // Measured again once the page's own fonts are in.
    void document.fonts.ready.then(fit)
    return () => observer.disconnect()
  }, [drawnAs])
  // What it's of, as a screen reader says it: spelled.
  const named = spelled(header.name.their)
  const second = header.secondStatus
  const secondSince = second?.since === undefined ? NaN : Date.parse(second.since)
  const status = (header.status?.level || second) && (
    <span className="flex shrink-0 items-center gap-1.5">
      {header.status?.level && (
        <Pill level={header.status.level} word={header.status.word} className="shrink-0" />
      )}
      {second && (
        <Pill
          level={second.level}
          word={second.word}
          className="shrink-0"
          {...(Number.isFinite(secondSince) ? { after: <Elapsed since={secondSince} /> } : {})}
        />
      )}
    </span>
  )
  // Why it's so, where the plugin says: under the name and its words, two lines at most (what's
  // happening now, where it says, before the first's).
  const why = second?.detail ?? header.status?.detail
  const detail = why && (
    <p
      // (Whole in its tooltip, spelled: a line is 500 characters at most.)
      title={spelled(why.their).replace(/\s+/g, ' ').trim()}
      className="line-clamp-2 max-w-[640px] text-[13px] leading-5 [overflow-wrap:anywhere] text-ink-2 touch:line-clamp-none"
    >
      <TheirText text={why} inline />
    </p>
  )

  if (phone) {
    const here = buttons.filter((button) => !button.changes && !elsewhereHere(button))
    // (A button that changes and is busy is neither here nor elsewhere: nothing could be started
    // with it on a larger screen either, and the header's statuses say what's happening.)
    const elsewhere = buttons.filter(
      (button) => (button.changes && !busyOf(button, held)) || elsewhereHere(button),
    )
    return (
      <div role="group" aria-label={named} className="flex flex-col items-start gap-3">
        {!namedAbove && (
          <h2 className="w-full min-w-0 text-[17px] leading-6 font-semibold text-ink-1">
            <MiddleCut text={header.name} />
          </h2>
        )}
        {status}
        {detail}
        {elsewhere.length > 0 && <OnALargerScreen buttons={elsewhere} />}
        <Notes buttons={buttons} drawn={here} named />
        {here.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {here.map((button) => (
              <Action
                key={keyOf(button)}
                button={button}
                held={held}
                focusKey={focusKeyOf(button)}
                // (Filled only if it's the last that changes something.)
                variant={button === filled ? 'primary' : 'secondary'}
                className="h-11"
                onPress={() => press(button)}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  // More than fit: the last ones keep their places, and "…" before the last holds the rest.
  const shown = ordered.slice(
    -(fits?.shown ?? (ordered.length > BUTTONS_SHOWN ? 2 : ordered.length)),
  )
  const folded = ordered.slice(0, ordered.length - shown.length)
  // (The filled one, last; the rest by their places.)
  const variant = (index: number) =>
    shown[index] === filled ? 'primary' : index >= shown.length - 2 ? 'secondary' : 'ghost'
  const heading = (
    <h2 className="min-w-0 text-[17px] leading-6 font-semibold text-ink-1">
      <MiddleCut text={header.name} />
    </h2>
  )
  // The status and the buttons are never cut or wrapped: the name gives way, and past its floor,
  // buttons fold; past that, the name has a line of its own.
  const rest = (
    <>
      {status && <span data-status="">{status}</span>}
      <div data-buttons="" className="ml-auto flex shrink-0 items-center gap-2 pl-2">
        {shown.map((button, i) => (
          <Fragment key={keyOf(button)}>
            {folded.length > 0 && i === shown.length - 1 && (
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <Button aria-label={`More for ${named}`} className="px-2">
                    <Ellipsis />
                  </Button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content align="end" sideOffset={6} className={menuContent}>
                    {folded.map((more) => (
                      <Folded
                        key={keyOf(more)}
                        button={more}
                        held={held}
                        onPress={() => press(more)}
                      />
                    ))}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            )}
            <Action
              button={button}
              held={held}
              focusKey={focusKeyOf(button)}
              variant={variant(i)}
              onPress={() => press(button)}
            />
          </Fragment>
        ))}
      </div>
    </>
  )
  const row = fits?.split ? (
    <>
      <div className="flex h-8 items-center">{heading}</div>
      <div className="flex h-8 items-center gap-2.5">{rest}</div>
    </>
  ) : (
    <div className="flex h-8 items-center gap-2.5">
      {heading}
      {rest}
    </div>
  )
  return (
    <div ref={groupRef} role="group" aria-label={named} className="flex flex-col gap-1">
      {row}
      {/* Why it's so at the left, under the name; what the buttons do at the right, under them. */}
      <div className="flex items-start gap-6 empty:hidden">
        {detail}
        {/* (At most 480 px, and never past half the header.) */}
        <Notes
          buttons={ordered}
          drawn={shown}
          named={false}
          className="ml-auto max-w-[min(480px,50%)]"
        />
      </div>
    </div>
  )
}

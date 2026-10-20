import { cn } from '@renderer/lib/cn'
import { useLayout } from '@renderer/lib/layout'
import { menuContent, menuItem } from '@renderer/features/shell/menu-styles'
import { ChevronDown } from 'lucide-react'
import { DropdownMenu, Tabs as TabsPrimitive } from 'radix-ui'
import {
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { Sheet } from './Sheet'

/** The tab shown, and how to choose another: More's menu chooses from outside the list. */
const Chosen = createContext<{ value: string | undefined; choose: (value: string) => void }>({
  value: undefined,
  choose: () => {},
})

/** Radix's tabs, whose value More can read and set. */
export function Tabs({
  value,
  defaultValue,
  onValueChange,
  ...props
}: ComponentProps<typeof TabsPrimitive.Root>) {
  const [own, setOwn] = useState(defaultValue)
  const shown = value ?? own
  const choose = (next: string) => {
    if (value === undefined) setOwn(next)
    onValueChange?.(next)
  }
  return (
    <Chosen.Provider value={{ value: shown, choose }}>
      <TabsPrimitive.Root value={shown} onValueChange={choose} {...props} />
    </Chosen.Provider>
  )
}
export const TabContent = TabsPrimitive.Content

const tab =
  'flex h-9 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium whitespace-nowrap text-ink-3 transition-colors outline-none hover:text-ink-1 focus-visible:bg-surface-3 phone:h-11'
/** The gap between tabs, and before More. */
const GAP = 4

/** A label's words, as a key: what it says changes how wide it is (a count, say). */
function wordsOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(wordsOf).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return wordsOf(node.props.children)
  return ''
}

/**
 * Which tabs the row shows, by their widths, More's and the row's room: all where all fit; else
 * those that fit from the start with More after them, and the open one always, in the last place
 * before More where it wouldn't have one. The rest are More's, in their order.
 */
function fitting(widths: number[], more: number, room: number, open: number): number[] {
  const width = (shown: number[]) =>
    shown.reduce((sum, i) => sum + widths[i]!, 0) + GAP * Math.max(0, shown.length - 1)
  const all = widths.map((_, i) => i)
  if (width(all) <= room) return all
  const fits = (shown: number[]) => width(shown) + GAP + more <= room
  const shown: number[] = []
  for (const i of all) {
    if (!fits([...shown, i])) break
    shown.push(i)
  }
  if (open < 0 || shown.includes(open)) return shown
  while (shown.length > 0 && !fits([...shown, open])) shown.pop()
  return [...shown, open]
}

/**
 * Tab triggers with an underline that glides to the active tab, anchored to it with CSS anchor
 * positioning. They never scroll, wrap or get cut: where they don't all fit, those that fit stay
 * in their order and the rest go into More, the row's last stop, a menu (a sheet on a phone).
 * The open tab always has a place in the row. Which fit is measured, and again as the row's
 * room or its tabs change.
 */
export function TabList({
  tabs,
  aside,
}: {
  tabs: { value: string; label: ReactNode }[]
  /** What stands at the row's end, after the tabs (a kept object's status and actions). */
  aside?: ReactNode
}) {
  const { value, choose } = useContext(Chosen)
  const phone = useLayout() === 'phone'
  const row = useRef<HTMLDivElement>(null)
  const copies = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const moreButton = useRef<HTMLButtonElement>(null)
  const [room, setRoom] = useState(Infinity)
  const [sheet, setSheet] = useState(false)
  // A tab chosen from More: focus goes to it in the row once it's there (and not back to More).
  const picked = useRef<string>(undefined)
  // Each tab as wide as it's drawn, and More: measured from copies drawn for that alone, and gone
  // before anything is painted; again when what a tab says changes, and whenever fonts come in.
  // (To the fraction of a pixel, as text is drawn: rounded, eight tabs could be a few pixels out.)
  const [fonts, setFonts] = useState(0)
  useEffect(() => {
    const loaded = () => setFonts((n) => n + 1)
    void document.fonts.ready.then(loaded)
    document.fonts.addEventListener('loadingdone', loaded)
    return () => document.fonts.removeEventListener('loadingdone', loaded)
  }, [])
  const said = `${phone}:${fonts}:${tabs.map((each) => `${each.value}=${wordsOf(each.label)}`).join('\n')}`
  const [widths, setWidths] = useState<{ said: string; tabs: number[]; more: number }>()
  const measuring = widths?.said !== said
  useLayoutEffect(() => {
    if (!measuring || !copies.current) return
    const each = [...copies.current.children].map((copy) => copy.getBoundingClientRect().width)
    setWidths({ said, tabs: each.slice(0, -1), more: each.at(-1)! })
  }, [measuring, said])

  useLayoutEffect(() => {
    const measure = () => {
      const style = getComputedStyle(row.current!)
      setRoom(
        row.current!.getBoundingClientRect().width -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight),
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(row.current!)
    return () => observer.disconnect()
  }, [])
  const open = tabs.findIndex((each) => each.value === value)
  const shownAt = widths ? fitting(widths.tabs, widths.more, room, open) : tabs.map((_, i) => i)
  const shown = shownAt.map((i) => tabs[i]!)
  const more = tabs.filter((_, i) => !shownAt.includes(i))

  const pick = (next: string) => {
    picked.current = next
    choose(next)
  }
  // (A frame on, once it has its place in the row.)
  const focusPicked = () =>
    requestAnimationFrame(() => {
      const next = picked.current
      picked.current = undefined
      if (next)
        list.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(next)}"]`)?.focus()
    })
  // More is the row's last stop: past the last tab, or End. (Taken before the tab has it: Radix
  // would move to the last tab a moment later, and choose it.)
  const toMore = (event: KeyboardEvent) => {
    if (more.length === 0) return
    const triggers = list.current?.querySelectorAll('[role="tab"]')
    const last = triggers && event.target === triggers[triggers.length - 1]
    if (event.key === 'End' || (event.key === 'ArrowRight' && last)) {
      event.preventDefault()
      event.stopPropagation()
      moreButton.current?.focus()
    }
  }
  // And back: to the last tab, or the first.
  const fromMore = (event: KeyboardEvent) => {
    const triggers = list.current?.querySelectorAll<HTMLElement>('[role="tab"]')
    if (event.key === 'ArrowLeft') triggers?.[triggers.length - 1]?.focus()
    else if (event.key === 'Home') triggers?.[0]?.focus()
    else return
    event.preventDefault()
  }

  const moreFace = (
    <>
      More
      <ChevronDown className="size-3.5 text-ink-3" aria-hidden />
    </>
  )
  return (
    // The line under the tabs is the wrapper's. On a phone, where the page scrolls under them,
    // they stay at its top.
    <div
      className={cn(
        'shadow-[inset_0_-1px_0_var(--color-line)] phone:sticky phone:top-0 phone:z-10 phone:bg-surface',
        aside && 'flex min-w-0 items-center gap-2 pr-2',
      )}
    >
      <div ref={row} className="relative flex min-w-0 flex-1 items-center px-5 pb-px phone:px-2">
        <TabsPrimitive.List
          ref={list}
          loop={false}
          onKeyDownCapture={toMore}
          className="relative flex min-w-0 gap-1"
        >
          {shown.map((each) => (
            <TabsPrimitive.Trigger
              key={each.value}
              value={each.value}
              data-tab={each.value}
              className={cn(
                tab,
                'data-[state=active]:text-ink-1 data-[state=active]:[anchor-name:--active-tab]',
              )}
            >
              {each.label}
            </TabsPrimitive.Trigger>
          ))}
          <span
            aria-hidden
            className="pointer-events-none absolute [right:calc(anchor(right)+8px)] -bottom-px [left:calc(anchor(left)+8px)] h-0.5 rounded-full bg-accent transition-[left,right] duration-300 ease-out [position-anchor:--active-tab]"
          />
        </TabsPrimitive.List>
        {/* (Beside the list, not in it: a menu's button isn't a tab.) */}
        {more.length > 0 &&
          (phone ? (
            <button
              ref={moreButton}
              type="button"
              aria-label="More tabs"
              onClick={() => setSheet(true)}
              onKeyDown={fromMore}
              className={cn(tab, 'ml-1')}
            >
              {moreFace}
            </button>
          ) : (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger
                ref={moreButton}
                aria-label="More tabs"
                onKeyDown={fromMore}
                className={cn(tab, 'ml-1 data-[state=open]:text-ink-1')}
              >
                {moreFace}
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="end"
                  sideOffset={4}
                  className={cn(menuContent, 'min-w-40')}
                  // (A tab chosen gets the focus, in the row; else More keeps it.)
                  onCloseAutoFocus={(event) => {
                    if (!picked.current) return
                    event.preventDefault()
                    focusPicked()
                  }}
                >
                  {more.map((each) => (
                    <DropdownMenu.Item
                      key={each.value}
                      className={menuItem}
                      onSelect={() => pick(each.value)}
                    >
                      {each.label}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          ))}
        {/* What each is measured by: the tabs and More, as drawn, where no one sees them. */}
        {measuring && (
          <div
            ref={copies}
            aria-hidden
            className="pointer-events-none invisible absolute top-0 left-0 flex"
          >
            {tabs.map((each) => (
              <span key={each.value} className={tab}>
                {each.label}
              </span>
            ))}
            <span className={tab}>{moreFace}</span>
          </div>
        )}
      </div>
      {aside && <div className="flex shrink-0 items-center gap-1.5">{aside}</div>}
      {sheet && (
        <Sheet title="More tabs" onClose={() => setSheet(false)}>
          <div className="flex flex-col px-2 pb-3">
            {more.map((each) => (
              <button
                key={each.value}
                type="button"
                onClick={() => {
                  setSheet(false)
                  pick(each.value)
                  focusPicked()
                }}
                className="flex h-11 items-center gap-1.5 rounded-lg px-2 text-[15px] text-ink-1 active:bg-surface-3"
              >
                {each.label}
              </button>
            ))}
          </div>
        </Sheet>
      )}
    </div>
  )
}

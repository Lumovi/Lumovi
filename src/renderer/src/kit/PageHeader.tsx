/**
 * The second-level header of a plugin's page: what's picked, its status, and what can be done
 * with it. At most three buttons show, the one that matters most last and the only filled one;
 * with more, "…" stands before it and holds the rest. On a phone a plugin's buttons that change
 * the cluster aren't offered: one line says where they are.
 */
import { Ellipsis } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { createContext, Fragment, useContext } from 'react'
import { spelled } from '@shared/kit/characters'
import { BUTTONS_SHOWN, type HeaderButton, type HeaderProps } from '@shared/kit/page'
import { Button } from '@renderer/components/Button'
import { useLayout } from '@renderer/lib/layout'
import { TheirText } from '@renderer/plugins/TheirText'
import { menuContent, menuItem } from '../features/shell/menu-styles'
import { MiddleCut } from './MiddleCut'
import { keyOf, Pill } from './Table'

/** Whether the page's top bar already names what's picked (a split's second page, on a phone). */
export const NamedAbove = createContext(false)

/** A button's name as a screen reader says it: spelled, and "…" where it asks first. */
const called = (button: HeaderButton) => `${spelled(button.name.their)}${button.asks ? '…' : ''}`

/** A button's name as it's drawn, the plugin's in pieces: one that asks first ends in "…". */
const drawn = (button: HeaderButton) => (
  <>
    <TheirText text={button.name} inline />
    {button.asks && '…'}
  </>
)

/** How many names the phone's line says before "and N more". */
const NAMED_AT_MOST = 5

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
  onPress,
}: {
  header: HeaderProps
  onPress?: HeaderProps['onPress']
}) {
  const phone = useLayout() === 'phone'
  const namedAbove = useContext(NamedAbove)
  const buttons = header.buttons ?? []
  const press = (button: HeaderButton) => onPress?.({ button: button.key })
  // What it's of, as a screen reader says it: spelled.
  const named = spelled(header.name.their)
  const status = header.status?.level && (
    <Pill level={header.status.level} word={header.status.word} className="shrink-0" />
  )
  // Why it's so, where the plugin says: under the name and its word, two lines at most.
  const why = header.status?.detail
  const detail = why && (
    <p
      // (Whole in its tooltip, spelled: a line is 500 characters at most.)
      title={spelled(why.their).replace(/\s+/g, ' ').trim()}
      className="line-clamp-2 max-w-[640px] text-[13px] leading-5 [overflow-wrap:anywhere] text-ink-2"
    >
      <TheirText text={why} inline />
    </p>
  )

  if (phone) {
    const offered = buttons.filter((button) => !button.changes)
    const elsewhere = buttons.filter((button) => button.changes)
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
        {offered.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {offered.map((button) => (
              <Button
                key={keyOf(button)}
                // (Filled only if it's the one that matters most of them all: the header's last.)
                variant={button === buttons.at(-1) ? 'primary' : 'secondary'}
                className="h-11"
                aria-label={called(button)}
                onClick={() => press(button)}
              >
                {drawn(button)}
              </Button>
            ))}
          </div>
        )}
      </div>
    )
  }

  // More than fit: the last two keep their places, and "…" between them holds the rest.
  const folded = buttons.length > BUTTONS_SHOWN ? buttons.slice(0, -2) : []
  const shown = folded.length ? buttons.slice(-2) : buttons
  const variant = (index: number) =>
    index === shown.length - 1 ? 'primary' : index === shown.length - 2 ? 'secondary' : 'ghost'
  const row = (
    <div className="flex h-8 items-center gap-2.5">
      <h2 className="min-w-0 text-[17px] leading-6 font-semibold text-ink-1">
        <MiddleCut text={header.name} />
      </h2>
      {/* The status and the buttons are never cut or wrapped: the name gives way. */}
      {status}
      <div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
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
                      <DropdownMenu.Item
                        key={keyOf(more)}
                        className={menuItem}
                        aria-label={called(more)}
                        onSelect={() => press(more)}
                      >
                        {drawn(more)}
                      </DropdownMenu.Item>
                    ))}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            )}
            <Button variant={variant(i)} aria-label={called(button)} onClick={() => press(button)}>
              {drawn(button)}
            </Button>
          </Fragment>
        ))}
      </div>
    </div>
  )
  return (
    <div role="group" aria-label={named} className="flex flex-col gap-1">
      {row}
      {detail}
    </div>
  )
}

/**
 * The second-level header of a plugin's page: what's picked, its status, and what can be done
 * with it. At most three buttons show, the one that matters most last and the only filled one;
 * with more, "…" stands before it and holds the rest. On a phone a plugin's buttons that change
 * the cluster aren't offered: one line says where they are.
 */
import { Ellipsis } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { createContext, Fragment, useContext } from 'react'
import { BUTTONS_SHOWN, type FrameCarries, type Header, type HeaderButton } from '@shared/kit/page'
import { Button } from '@renderer/components/Button'
import { MiddleTruncate } from '@renderer/components/MiddleTruncate'
import { StatusPill } from '@renderer/components/Status'
import { useLayout } from '@renderer/lib/layout'
import { menuContent, menuItem } from '../features/shell/menu-styles'

/** Whether the page's top bar already names what's picked (a split's second page, on a phone). */
export const NamedAbove = createContext(false)

/** A button's name as it's drawn: one that asks first ends in "…". */
const drawn = (button: HeaderButton) => (button.asks ? `${button.name}…` : button.name)

/** How many names the phone's line says before "and N more". */
const NAMED_AT_MOST = 5

/**
 * Where a phone's missing buttons are, in Lumovi's words. Each name is the plugin's text inside
 * Lumovi's sentence: its own island of direction, so nothing in it can turn the sentence round.
 */
function OnALargerScreen({ buttons }: { buttons: HeaderButton[] }) {
  const named = buttons.length > NAMED_AT_MOST ? buttons.slice(0, NAMED_AT_MOST - 1) : buttons
  const more = buttons.length - named.length
  return (
    <p className="text-xs leading-relaxed text-ink-3">
      Open Lumovi on a larger screen to use{' '}
      {named.map((button, i) => (
        <Fragment key={button.key}>
          {i > 0 && (i === named.length - 1 && !more ? ' and ' : ', ')}
          <bdi className="font-medium text-ink-2">{button.name}</bdi>
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
  header: Header
  onPress?: (carries: FrameCarries['press']) => void
}) {
  const phone = useLayout() === 'phone'
  const namedAbove = useContext(NamedAbove)
  const buttons = header.buttons ?? []
  const press = (button: HeaderButton) => onPress?.({ button: button.key })

  if (phone) {
    const offered = buttons.filter((button) => !button.changes)
    const elsewhere = buttons.filter((button) => button.changes)
    return (
      <div role="group" aria-label={header.name} className="flex flex-col items-start gap-3">
        {!namedAbove && (
          <h2 className="w-full min-w-0 text-[17px] leading-6 font-semibold text-ink-1">
            <MiddleTruncate text={header.name} />
          </h2>
        )}
        {header.status && (
          <StatusPill status={{ health: header.status.level, label: header.status.word }} />
        )}
        {elsewhere.length > 0 && <OnALargerScreen buttons={elsewhere} />}
        {offered.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {offered.map((button) => (
              <Button
                key={button.key}
                // (Filled only if it's the one that matters most of them all: the header's last.)
                variant={button === buttons.at(-1) ? 'primary' : 'secondary'}
                className="h-11"
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
  return (
    <div role="group" aria-label={header.name} className="flex h-8 items-center gap-2.5">
      <h2 className="min-w-0 text-[17px] leading-6 font-semibold text-ink-1">
        <MiddleTruncate text={header.name} />
      </h2>
      {/* The status and the buttons are never cut or wrapped: the name gives way. */}
      {header.status && (
        <StatusPill
          status={{ health: header.status.level, label: header.status.word }}
          className="shrink-0"
        />
      )}
      <div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
        {shown.map((button, i) => (
          <Fragment key={button.key}>
            {folded.length > 0 && i === shown.length - 1 && (
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <Button aria-label={`More for ${header.name}`} className="px-2">
                    <Ellipsis />
                  </Button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content align="end" sideOffset={6} className={menuContent}>
                    {folded.map((more) => (
                      <DropdownMenu.Item
                        key={more.key}
                        className={menuItem}
                        onSelect={() => press(more)}
                      >
                        {drawn(more)}
                      </DropdownMenu.Item>
                    ))}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            )}
            <Button variant={variant(i)} onClick={() => press(button)}>
              {drawn(button)}
            </Button>
          </Fragment>
        ))}
      </div>
    </div>
  )
}

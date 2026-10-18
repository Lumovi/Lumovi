/**
 * An object's detail's "Pin", before its "…": pinned, it reads "Pinned" in the accent's soft fill.
 * ⌥P pins or unpins the object that's open, where nothing is being typed. At the cap it can't pin,
 * and says why.
 */
import { Pin as PinIcon } from 'lucide-react'
import { useEffect } from 'react'
import { spelled } from '@shared/kit/characters'
import { apiKindOf } from '@shared/resources'
import { tooManyPins, MARKS_LIMITS, type Pin } from '@shared/marks'
import { Button } from '@renderer/components/Button'
import { Tooltip } from '@renderer/components/Tooltip'
import { usePinning } from '@renderer/hooks/marks'
import { cn } from '@renderer/lib/cn'
import { pressed, useClaim, useKeys } from '@renderer/lib/shortcuts'
import { isEditable } from '../actions/ActionSurfaces'

export function PinButton({ pin }: { pin: Pin }) {
  const { pinned, toggle, marks } = usePinning()
  const on = pinned(pin)
  const called = `${apiKindOf(pin.kind)} ${spelled(pin.name)}`
  const full = !on && marks.pins.length >= MARKS_LIMITS.pins
  const keys = useKeys()

  useClaim('object.pin', () => void toggle(pin, called))
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // (By the key's place: ⌥P types a character of its own on a Mac.)
      if (
        !pressed(event, 'object.pin') ||
        isEditable(event.target) ||
        document.querySelector('[role="dialog"], [role="menu"]')
      )
        return
      event.preventDefault()
      void toggle(pin, called)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  const said = full
    ? tooManyPins(called)
    : on
      ? `Unpin ${called} from the sidebar`
      : `Pin ${called} to the sidebar`
  const button = (
    <Button
      aria-pressed={on}
      disabled={full}
      onClick={() => void toggle(pin, called)}
      className={cn(
        'h-7 px-2.5 text-xs phone:h-11 phone:px-4 phone:text-[13px]',
        on &&
          'border-transparent bg-accent-soft text-accent-strong hover:bg-accent-soft/60 hover:text-accent-strong',
      )}
    >
      <PinIcon className={cn('!size-3.5 phone:!size-4', on && 'fill-current')} />
      {on ? 'Pinned' : 'Pin'}
    </Button>
  )
  return (
    <Tooltip
      content={
        full || !keys.text('object.pin') ? (
          said
        ) : (
          <span className="flex items-center gap-1.5">
            {said}
            <kbd className="inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-[5px] bg-surface/20 px-1 font-sans text-[11px] font-medium text-surface">
              {keys.text('object.pin')}
            </kbd>
          </span>
        )
      }
    >
      {/* A disabled button gets no pointer events: a wrapper carries its reason. */}
      {full ? <span tabIndex={0}>{button}</span> : button}
    </Tooltip>
  )
}

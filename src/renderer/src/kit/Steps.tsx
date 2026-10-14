/**
 * Where a run is (`@shared/kit/page`'s `steps`): its steps in order on one line, each a dot and
 * its name with a few words under, joined where one leads to the next. Done is a check on the
 * good colour, running a turning ring, to come an empty ring, failed a cross on the critical
 * colour: never colour alone, and each said in words to a screen reader. Under them, what the
 * step running now waits on: its lead and what it says, which Lumovi opens. On a phone the steps
 * are one sentence (which step it is, between which), and what it waits on is a card.
 */
import { Check, LoaderCircle, X } from 'lucide-react'
import { useRef } from 'react'
import { spelled } from '@shared/kit/characters'
import type { ListDestination, ReachDestination } from '@shared/kit/declare'
import type { Step, StepsProps } from '@shared/kit/page'
import type { ObjectRef } from '@shared/kit/table'
import { Tooltip } from '@renderer/components/Tooltip'
import { cn } from '@renderer/lib/cn'
import { useLayout } from '@renderer/lib/layout'
import { TheirText } from '@renderer/plugins/TheirText'
import { Lead } from './Lead'

/** How a step stands, in Lumovi's words: what a screen reader says after its name. */
const STATE_WORDS: Record<Step['state'], string> = {
  done: 'done',
  running: 'running now',
  next: 'to come',
  failed: 'failed',
}

/** A step's dot: the state's mark, and its colours. */
const DOT: Record<Step['state'], string> = {
  done: 'border-good bg-good text-white',
  running: 'border-ink-2 bg-surface-2 text-ink-2',
  next: 'border-line-strong bg-surface-2 text-ink-3',
  failed: 'border-critical bg-critical text-white',
}

/** The line into a step from the one before: reached once the one before is done. */
const REACHED = 'bg-good/55'

export function Steps({
  steps,
  waiting,
  go,
}: StepsProps & {
  /** Opens what it waits on: Lumovi's own to do, never the plugin's (and not declared). */
  go?: (to: ObjectRef | ListDestination | ReachDestination) => void
}) {
  const phone = useLayout() === 'phone'
  const opens = waiting?.opens
  const wait = waiting && (
    <Waiting
      lead={waiting.lead}
      said={waiting.said}
      {...(opens && go ? { onOpen: () => go(opens) } : {})}
    />
  )
  if (phone) {
    return (
      <div className="flex min-w-0 flex-col gap-2.5">
        <p className="text-[13px] leading-5 text-ink-1">{sentence(steps)}</p>
        {wait}
      </div>
    )
  }
  return (
    <div className="flex min-w-0 flex-col gap-3.5">
      <ol aria-label="Steps" className="flex items-start">
        {steps.map((step, index) => {
          const before = steps[index - 1]
          const after = steps[index + 1]
          return (
            <li
              key={step.key.their}
              data-state={step.state}
              className="relative flex min-w-0 flex-1 flex-col items-center gap-1.5 px-1"
            >
              {/* The line in from the step before, and out to the next: each half its own. */}
              {before && (
                <span
                  aria-hidden
                  className={cn(
                    'absolute top-[9px] right-1/2 left-0 h-0.5',
                    before.state === 'done' ? REACHED : 'bg-line-strong',
                  )}
                />
              )}
              {after && (
                <span
                  aria-hidden
                  className={cn(
                    'absolute top-[9px] right-0 left-1/2 h-0.5',
                    step.state === 'done' ? REACHED : 'bg-line-strong',
                  )}
                />
              )}
              <span
                aria-hidden
                className={cn(
                  'relative z-10 grid size-5 place-items-center rounded-full border-2',
                  DOT[step.state],
                )}
              >
                {step.state === 'done' && <Check className="size-3" strokeWidth={3} />}
                {step.state === 'running' && (
                  <LoaderCircle
                    className="size-3 animate-spin motion-reduce:animate-none"
                    strokeWidth={2.5}
                  />
                )}
                {step.state === 'failed' && <X className="size-3" strokeWidth={3} />}
              </span>
              <b
                className={cn(
                  'max-w-full truncate text-center text-[12.5px] font-semibold',
                  step.state === 'next' ? 'text-ink-2' : 'text-ink-1',
                  step.state === 'failed' && 'text-critical-text',
                )}
              >
                <TheirText text={step.name} inline />
                <span className="sr-only">, {STATE_WORDS[step.state]}</span>
              </b>
              {step.detail?.their && <Detail text={step.detail} />}
            </li>
          )
        })}
      </ol>
      {wait}
    </div>
  )
}

/** A step's few words under it: two lines, then cut at their end, whole in Lumovi's tooltip. */
function Detail({ text }: { text: NonNullable<Step['detail']> }) {
  const words = useRef<HTMLElement>(null)
  return (
    <Tooltip
      content={<TheirText text={text} inline />}
      when={() => {
        const shown = words.current
        return shown !== null && shown.scrollHeight > shown.clientHeight + 1
      }}
    >
      <small
        ref={words}
        className="line-clamp-2 max-w-full text-center text-xs leading-4 text-ink-3"
      >
        <TheirText text={text} inline />
      </small>
    </Tooltip>
  )
}

/**
 * What the step running now waits on: its lead and what it says, in a box under the steps.
 * Pressed, Lumovi opens it, where the plugin read it.
 */
function Waiting({
  lead,
  said,
  onOpen,
}: {
  lead: NonNullable<StepsProps['waiting']>['lead']
  said: NonNullable<StepsProps['waiting']>['said']
  onOpen?: () => void
}) {
  const body = (
    <>
      <span className="w-[220px] max-w-[45%] shrink-0 phone:w-auto phone:max-w-full">
        <Lead lead={lead} />
      </span>
      <span className="line-clamp-2 min-w-0 text-left text-[13px] leading-[19px] text-ink-2 touch:line-clamp-none">
        <TheirText text={said} inline />
      </span>
    </>
  )
  const box =
    'flex w-full min-w-0 items-start gap-2.5 rounded-[10px] border border-line bg-surface px-3 py-2.5 phone:flex-col phone:gap-1.5'
  return onOpen ? (
    <button
      type="button"
      aria-label={`Waiting on ${spelled(lead.name.their)}: ${spelled(said.their)}`}
      onClick={onOpen}
      className={cn(box, 'hover:bg-surface-3/60 active:bg-surface-3 phone:min-h-11')}
    >
      {body}
    </button>
  ) : (
    <div className={box}>{body}</div>
  )
}

/**
 * The steps as one sentence, as a phone says them: the step that's running (or failed), with
 * which it comes after and which before; every one done; or the next to come.
 */
export function sentence(steps: readonly Step[]): string {
  const name = (step: Step | undefined) => (step ? spelled(step.name.their) : '')
  const total = steps.length
  const at = steps.findIndex((step) => step.state === 'running' || step.state === 'failed')
  if (at >= 0) {
    const step = steps[at]!
    const around = [
      ...(at > 0 ? [`after ${name(steps[at - 1])}`] : []),
      ...(at < total - 1 ? [`before ${name(steps[at + 1])}`] : []),
    ]
    return `Step ${at + 1} of ${total}, ${name(step)}, ${step.state === 'failed' ? 'failed' : 'running'}${around.length ? `: ${around.join(', ')}` : ''}.`
  }
  if (steps.every((step) => step.state === 'done')) return `All ${total} steps done.`
  const next = steps.findIndex((step) => step.state === 'next')
  return `Step ${next + 1} of ${total}, ${name(steps[next])}, to come.`
}

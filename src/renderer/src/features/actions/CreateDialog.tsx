import { CircleCheck, CircleX, FilePlus2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { CodeEditor } from '@renderer/components/CodeEditor'
import { useResources } from '@renderer/hooks/resources'
import { useReadOnly } from '@renderer/hooks/settings'
import { cn } from '@renderer/lib/cn'
import { useCluster } from '@renderer/state/cluster'
import { usePrefs } from '@renderer/state/prefs'
import { useUi } from '@renderer/state/ui'
import { ActionDialog } from './ActionDialog'
import { CreateForm } from './CreateForm'
import { TEMPLATES, useCreating, type Outcome } from './create-run'

/**
 * Create: one or more objects, checked by the cluster before any is created. Two ways to say
 * what: a form for the common kinds, with the YAML it writes beside it, or YAML alone.
 */
export function CreateDialog() {
  const open = useUi((ui) => ui.create)
  const setOpen = useUi((ui) => ui.setCreate)
  return open ? <Create onClose={() => setOpen(false)} /> : null
}

function Create({ onClose }: { onClose: () => void }) {
  // The side used last opens first; the first time, the form.
  const side = usePrefs((prefs) => prefs.createSide)
  const setSide = usePrefs((prefs) => prefs.setCreateSide)
  // What the cluster serves decides what can be created.
  useResources()
  // Chosen by the arrows, the switch keeps the focus as the dialog changes around it (each
  // side is a dialog of its own, which would take the focus to its first field).
  const byKeys = useRef(false)
  useEffect(() => {
    if (!byKeys.current) return
    byKeys.current = false
    const timer = setTimeout(() =>
      document.querySelector<HTMLElement>('[data-create-sides] [aria-checked="true"]')?.focus(),
    )
    return () => clearTimeout(timer)
  }, [side])
  const sides = (
    <Sides
      side={side}
      onChange={(next, keys) => {
        byKeys.current = keys
        setSide(next)
      }}
    />
  )
  return side === 'form' ? (
    <CreateForm sides={sides} onClose={onClose} />
  ) : (
    <CreateYaml sides={sides} onClose={onClose} />
  )
}

/** The switch between the two ways. */
function Sides({
  side,
  onChange,
}: {
  side: 'form' | 'yaml'
  onChange: (side: 'form' | 'yaml', byKeys: boolean) => void
}) {
  const options = [
    ['form', 'Form'],
    ['yaml', 'YAML'],
  ] as const
  return (
    <div
      role="radiogroup"
      data-create-sides
      aria-label="How to create"
      className="inline-flex rounded-lg bg-surface-3 p-0.5"
      onKeyDown={(event) => {
        // As a group of radios goes: the arrows choose.
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
        event.preventDefault()
        onChange(side === 'form' ? 'yaml' : 'form', true)
      }}
    >
      {options.map(([value, label]) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={side === value}
          tabIndex={side === value ? 0 : -1}
          onClick={() => onChange(value, false)}
          className={cn(
            'h-7 rounded-md px-3 text-[13px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent',
            side === value ? 'bg-surface text-ink-1 shadow-xs' : 'text-ink-2 hover:text-ink-1',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

/** What each object came to, as a list: created, or not and what the cluster said. */
export function Results({ outcomes }: { outcomes: Outcome[] }) {
  // In view as it comes (the editor above can push it past the fold): where it's said, not
  // where the focus is.
  const results = useRef<HTMLUListElement>(null)
  useEffect(() => {
    if (outcomes.length > 0) results.current?.scrollIntoView({ block: 'nearest' })
  }, [outcomes])
  if (outcomes.length === 0) return null
  return (
    <ul
      ref={results}
      aria-label="Results"
      className="scroll-mb-5 divide-y divide-line rounded-xl border border-line"
    >
      {outcomes.map((outcome, i) => (
        <li key={i} className="flex gap-2.5 px-3 py-2 text-xs">
          {outcome.ok ? (
            <CircleCheck className="mt-px size-3.5 shrink-0 text-good-text" />
          ) : (
            <CircleX className="mt-px size-3.5 shrink-0 text-critical-text" />
          )}
          <span className="min-w-0">
            <span className="block font-mono text-ink-1">{outcome.label}</span>
            {!outcome.ok && (
              <span className={cn('block break-words text-critical-text selectable')}>
                {outcome.error}
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** YAML alone: any kind, several at once, from a template or from nothing. */
function CreateYaml({ sides, onClose }: { sides: React.ReactNode; onClose: () => void }) {
  const { namespace } = useCluster()
  const { readOnly, why: readOnlyWhy } = useReadOnly()
  const target = namespace ?? 'default'
  const [text, setText] = useState(() => TEMPLATES.Deployment!(target))
  const { outcomes, setOutcomes, pending, command, create } = useCreating(target, onClose)

  return (
    <ActionDialog
      icon={FilePlus2}
      title="Create"
      subject={`New objects go to ${target} unless they name a namespace`}
      command={command}
      confirmLabel="Create"
      wide
      ready={!readOnly}
      pending={pending}
      error={readOnly ? readOnlyWhy : undefined}
      onClose={onClose}
      onSubmit={() => void create(text)}
    >
      <div>{sides}</div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Templates">
        {Object.entries(TEMPLATES).map(([kind, template]) => (
          <button
            key={kind}
            type="button"
            onClick={() => {
              setText(template(target))
              setOutcomes([])
            }}
            className="h-6 rounded-md border border-line px-2 text-xs font-medium text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink-1"
          >
            {kind}
          </button>
        ))}
      </div>
      <div className="h-[40vh] overflow-hidden rounded-xl border border-line bg-surface-2/60">
        <CodeEditor
          value={text}
          onChange={(next) => {
            setText(next)
            setOutcomes([])
          }}
          onSave={() => void create(text)}
          label="YAML to create"
        />
      </div>
      <p className="text-xs text-ink-3">
        Several objects can be created at once: separate them with a line of <code>---</code>.
      </p>
      <Results outcomes={outcomes} />
    </ActionDialog>
  )
}

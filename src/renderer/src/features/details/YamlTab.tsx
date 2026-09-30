import { Eye, EyeOff, Pencil } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { KubeObject } from '@shared/api'
import { Button } from '@renderer/components/Button'
import { CopyButton } from '@renderer/components/CopyButton'
import { Tooltip } from '@renderer/components/Tooltip'
import { cn } from '@renderer/lib/cn'
import { formatRef } from '@renderer/lib/routes'
import { toYaml, tokenizeYamlLine, type YamlTokenType } from '@renderer/lib/yaml'
import { useActionsUi } from '@renderer/state/actions'
import { kindOf } from '../actions/common'
import { useObjectActions } from '../actions/use-actions'
import { YamlEditor } from './YamlEditor'

const TOKEN_CLASS: Record<YamlTokenType, string> = {
  key: 'text-accent-strong',
  string: 'text-good-text',
  number: 'text-serious-text',
  literal: 'text-serious-text',
  punct: 'text-ink-3',
  plain: 'text-ink-1',
}

export const MASK = '••••••••'

/** Secret values stay hidden until the user asks to see them. */
export function maskSecret(secret: KubeObject): KubeObject {
  const data = Object.fromEntries(
    Object.keys((secret.data as object | undefined) ?? {}).map((key) => [key, MASK]),
  )
  return { ...secret, data }
}

export function YamlTab({ object }: { object: KubeObject }) {
  const ref = formatRef({
    kind: kindOf(object),
    name: object.metadata.name,
    namespace: object.metadata.namespace,
  })
  const editing = useActionsUi((state) => state.editing === ref)
  const edit = useActionsUi((state) => state.edit)
  if (editing) return <YamlEditor object={object} onDone={() => edit(null)} />
  return <YamlView object={object} onEdit={() => edit(ref)} />
}

function EditButton({ object, onEdit }: { object: KubeObject; onEdit: () => void }) {
  const action = useObjectActions(object).find(({ action }) => action.id === 'edit-yaml')
  if (!action) return null
  const button = (
    <Button variant="ghost" disabled={action.disabled !== undefined} onClick={onEdit}>
      <Pencil /> Edit
    </Button>
  )
  return action.disabled ? (
    <Tooltip content={action.disabled}>
      <span tabIndex={0}>{button}</span>
    </Tooltip>
  ) : (
    button
  )
}

function YamlView({ object, onEdit }: { object: KubeObject; onEdit: () => void }) {
  const isSecret = object.kind === 'Secret'
  const [revealed, setRevealed] = useState(false)
  const yaml = useMemo(
    () => toYaml(isSecret && !revealed ? maskSecret(object) : object),
    [object, isSecret, revealed],
  )
  const lines = yaml.trimEnd().split('\n')

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-5 py-2">
        <span className="flex-1 text-xs text-ink-3">{lines.length} lines · read-only</span>
        {isSecret && (
          <Button variant="ghost" onClick={() => setRevealed(!revealed)}>
            {revealed ? <EyeOff /> : <Eye />}
            {revealed ? 'Hide values' : 'Reveal values'}
          </Button>
        )}
        <CopyButton text={yaml} label="Copy YAML" />
        <EditButton object={object} onEdit={onEdit} />
      </div>
      <pre
        aria-label="YAML"
        className="min-h-0 flex-1 overflow-auto bg-surface-2/60 py-3 font-mono text-[12px] leading-[1.7] select-text selectable"
      >
        <code className="grid grid-cols-[auto_1fr]">
          {lines.map((line, index) => (
            <span key={index} className="contents">
              <span className="pr-4 pl-5 text-right text-ink-3/60 select-none">{index + 1}</span>
              <span className="pr-5 whitespace-pre">
                {tokenizeYamlLine(line).map((token, i) => (
                  <span key={i} className={cn(TOKEN_CLASS[token.type])}>
                    {token.text}
                  </span>
                ))}
              </span>
            </span>
          ))}
        </code>
      </pre>
    </div>
  )
}

import { Eye, EyeOff, Lock, Pencil } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { KubeObject } from '@shared/api'
import { Button } from '@renderer/components/Button'
import { CopyButton } from '@renderer/components/CopyButton'
import { Tooltip } from '@renderer/components/Tooltip'
import { YamlText } from '@renderer/components/YamlText'
import { formatRef } from '@renderer/lib/routes'
import { toYaml } from '@renderer/lib/yaml'
import { useActionsUi } from '@renderer/state/actions'
import { useAccessHere } from '../access/use-access'
import { kindOf } from '../actions/common'
import { useObjectActions } from '../actions/use-actions'
import { YamlEditor } from './YamlEditor'

export const MASK = '••••••••'

/** Secret values stay hidden until the user asks to see them. */
/** `kubectl apply` keeps what it applied here: for a Secret, its values in plain text. */
export const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration'

export function maskSecret(secret: KubeObject): KubeObject {
  const data = Object.fromEntries(
    Object.keys((secret.data as object | undefined) ?? {}).map((key) => [key, MASK]),
  )
  const annotations = secret.metadata.annotations ?? {}
  const metadata =
    LAST_APPLIED in annotations
      ? { ...secret.metadata, annotations: { ...annotations, [LAST_APPLIED]: MASK } }
      : secret.metadata
  return { ...secret, metadata, data }
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
  // (On a phone it isn't among an object's actions: YAML is read there.)
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
  const withheld = useAccessHere().whyNot(
    'secrets',
    'values',
    object.metadata.namespace,
    'see Secrets’ values',
  )
  const yaml = useMemo(
    () => toYaml(isSecret && !revealed ? maskSecret(object) : object),
    [object, isSecret, revealed],
  )
  const lines = yaml.trimEnd().split('\n')

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-5 py-2">
        <span className="flex-1 text-xs text-ink-3">{lines.length} lines · read-only</span>
        {isSecret &&
          (withheld ? (
            <Tooltip content={withheld}>
              <span tabIndex={0} className="flex items-center gap-1.5 text-xs text-ink-3">
                <Lock className="size-3.5" aria-hidden /> Values hidden by your access
              </span>
            </Tooltip>
          ) : (
            <Button variant="ghost" onClick={() => setRevealed(!revealed)}>
              {revealed ? <EyeOff /> : <Eye />}
              {revealed ? 'Hide values' : 'Reveal values'}
            </Button>
          ))}
        <CopyButton text={yaml} label="Copy YAML" />
        <EditButton object={object} onEdit={onEdit} />
      </div>
      <YamlText text={yaml} label="YAML" />
    </div>
  )
}

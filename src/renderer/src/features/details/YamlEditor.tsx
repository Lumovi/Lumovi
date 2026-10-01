import { CircleAlert, CircleCheck, LoaderCircle } from 'lucide-react'
import { useState } from 'react'
import { parse } from 'yaml'
import type { KubeObject } from '@shared/api'
import { Button } from '@renderer/components/Button'
import { CodeEditor } from '@renderer/components/CodeEditor'
import { DiffView, unifiedDiff } from '@renderer/components/DiffView'
import { Kbd, MOD_KEY } from '@renderer/components/Kbd'
import { useChange } from '@renderer/hooks/change'
import { api } from '@renderer/lib/api'
import { kubectl, objectArg } from '@renderer/lib/kubectl'
import { toYaml } from '@renderer/lib/yaml'
import { useCluster } from '@renderer/state/cluster'
import { kindOf, target } from '../actions/common'

const utf8 = new TextDecoder('utf-8', { fatal: true })

function decode(base64: string): string | undefined {
  try {
    return utf8.decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)))
  } catch {
    return undefined
  }
}

function encode(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)))
}

/**
 * What the editor shows: no status or server-managed metadata, and a
 * Secret's text values decoded into `stringData` (binary ones stay encoded).
 */
function forEditing(object: KubeObject): object {
  const { status: _status, ...rest } = object
  const {
    uid: _uid,
    creationTimestamp: _created,
    generation: _generation,
    resourceVersion: _version,
    managedFields: _managed,
    ...metadata
  } = rest.metadata
  const editable: KubeObject = { ...rest, metadata }
  if (object.kind === 'Secret') {
    const data: Record<string, string> = {}
    const stringData: Record<string, string> = {}
    for (const [key, value] of Object.entries((object.data ?? {}) as Record<string, string>)) {
      const text = decode(value)
      if (text === undefined) data[key] = value
      else stringData[key] = text
    }
    delete editable.data
    if (Object.keys(data).length) editable.data = data
    editable.stringData = stringData
  }
  return editable
}

/** The object to save: the edit, plus the version it was based on, with Secret values encoded again. */
function fromEditing(edited: Record<string, unknown>, base: KubeObject): KubeObject {
  const object = edited as KubeObject
  const saved: KubeObject = {
    ...object,
    metadata: { ...object.metadata, resourceVersion: base.metadata.resourceVersion },
  }
  if (base.kind === 'Secret') {
    const stringData = (object.stringData ?? {}) as Record<string, string>
    saved.data = {
      ...(object.data as Record<string, string> | undefined),
      ...Object.fromEntries(Object.entries(stringData).map(([k, v]) => [k, encode(String(v))])),
    }
    delete saved.stringData
  }
  return saved
}

/**
 * Edits an object as YAML, like `kubectl edit`: the change is validated by
 * the cluster (a dry run) and shown as a diff before it is saved, and a
 * conflicting change made meanwhile is caught rather than overwritten.
 */
export function YamlEditor({ object, onDone }: { object: KubeObject; onDone: () => void }) {
  const { context } = useCluster()
  const change = useChange()
  const { name, namespace } = object.metadata
  // Edits apply to the version they started from, even as the panel refreshes.
  const [base, setBase] = useState(object)
  const initial = toYaml(forEditing(base))
  const [text, setText] = useState(initial)
  const [reviewed, setReviewed] = useState<KubeObject>()
  const [error, setError] = useState<{ message: string; conflict: boolean }>()
  const [pending, setPending] = useState(false)
  const command = kubectl(context, namespace, 'edit', objectArg(kindOf(object), name))

  const review = async () => {
    if (text === initial) return
    let edited: unknown
    try {
      edited = parse(text)
    } catch (e) {
      setError({ message: (e as Error).message, conflict: false })
      return
    }
    if (typeof edited !== 'object' || edited === null || Array.isArray(edited)) {
      setError({ message: 'The YAML must describe a single object.', conflict: false })
      return
    }
    const saved = fromEditing(edited as Record<string, unknown>, base)
    setPending(true)
    const result = await api.kube.change({
      context,
      ...target(base),
      change: { action: 'replace', object: saved },
      dryRun: true,
    })
    setPending(false)
    if (!result.ok) {
      setError({ message: result.error.message, conflict: result.error.code === 'conflict' })
      return
    }
    setError(undefined)
    setReviewed(saved)
  }

  const apply = async () => {
    setPending(true)
    const result = await change(
      { ...target(base), change: { action: 'replace', object: reviewed! } },
      { title: `Updated ${kindOf(base).toLowerCase()} ${name}`, command },
    )
    setPending(false)
    if (result.ok) {
      onDone()
      return
    }
    setError({ message: result.error.message, conflict: result.error.code === 'conflict' })
    setReviewed(undefined)
  }

  const startOver = async () => {
    const latest = await api.kube.get({ context, ...target(base), name })
    if (!latest.ok) {
      setError({ message: latest.error.message, conflict: true })
      return
    }
    setBase(latest.data)
    setText(toYaml(forEditing(latest.data)))
    setError(undefined)
  }

  const diff = reviewed ? unifiedDiff(initial, text) : undefined

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      // Escape shouldn't close the panel (and lose the edit) while typing.
      onKeyDown={(event) => {
        if (event.key === 'Escape') event.stopPropagation()
      }}
    >
      <div className="flex items-center gap-2 border-b border-line px-5 py-2">
        {diff ? (
          <span className="flex flex-1 items-center gap-1.5 text-xs text-ink-2">
            <CircleCheck className="size-3.5 text-good-text" />
            The cluster accepts this change ·
            <span className="font-medium text-good-text tabular-nums">+{diff.added}</span>
            <span className="font-medium text-critical-text tabular-nums">−{diff.removed}</span>
          </span>
        ) : (
          <span className="flex flex-1 items-center gap-1.5 text-xs text-ink-3">
            Editing · <Kbd>{MOD_KEY}</Kbd>
            <Kbd>S</Kbd> to review
          </span>
        )}
        {diff ? (
          <>
            <Button variant="ghost" onClick={() => setReviewed(undefined)} disabled={pending}>
              Back to editing
            </Button>
            <Button variant="primary" onClick={() => void apply()} disabled={pending}>
              {pending && <LoaderCircle className="animate-spin" />}
              Apply
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onDone}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void review()}
              disabled={text === initial || pending}
            >
              {pending && <LoaderCircle className="animate-spin" />}
              Review changes
            </Button>
          </>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2.5 border-b border-critical/25 bg-critical/8 px-5 py-2.5 text-[13px] text-critical-text"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <p className="min-w-0 flex-1 break-words whitespace-pre-wrap selectable">
            {error.message}
          </p>
          {error.conflict && (
            <Button
              variant="secondary"
              className="h-7 shrink-0 text-xs"
              onClick={() => void startOver()}
            >
              Start over from the latest
            </Button>
          )}
        </div>
      )}

      {diff ? (
        <DiffView diff={diff} label="Changes" />
      ) : (
        <div className="min-h-0 flex-1 bg-surface-2/60">
          <CodeEditor
            value={text}
            onChange={(next) => {
              setText(next)
              setError(undefined)
            }}
            onSave={() => void review()}
            label={`YAML of ${name}`}
          />
        </div>
      )}
    </div>
  )
}

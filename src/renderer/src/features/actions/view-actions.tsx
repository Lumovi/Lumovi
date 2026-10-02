import { Zap } from 'lucide-react'
import { useState } from 'react'
import type { KubeObject } from '@shared/api'
import { kindFor } from '@shared/resources'
import { VIEW_ICONS } from '@renderer/components/KindIcon'
import { Stepper } from '@renderer/components/Stepper'
import { YamlText } from '@renderer/components/YamlText'
import { useChange, type ClusterChange, type ChangeMeta } from '@renderer/hooks/change'
import { useGo } from '@renderer/hooks/go'
import { resourceFor } from '@renderer/hooks/resources'
import { cn } from '@renderer/lib/cn'
import { kubectl, objectArg } from '@renderer/lib/kubectl'
import { formatRef, kindPath } from '@renderer/lib/routes'
import {
  inputOptions,
  render,
  renderPatch,
  viewFor,
  type InputValues,
  type ViewAction,
  type ViewInput,
} from '@renderer/lib/views'
import { toYaml } from '@renderer/lib/yaml'
import { useActionsUi } from '@renderer/state/actions'
import { useCluster } from '@renderer/state/cluster'
import { ActionDialog, useSubmit } from './ActionDialog'
import type { InstantChange } from './catalog'
import { kindOf, subjectOf, target, type ActionProps } from './common'

/** The change a view's patch makes, with its kubectl command and its undo. */
export function viewChange(
  action: ViewAction,
  object: KubeObject,
  context: string,
  inputs: InputValues = {},
  now = Date.now(),
): InstantChange {
  const { name, namespace } = object.metadata
  const step = (patch: NonNullable<ViewAction['patch']>, title: string) => {
    const body = renderPatch(patch, object, now, inputs)
    return {
      change: {
        ...target(object),
        change: {
          action: 'patch' as const,
          patchType: action.type,
          patch: body,
          ...(action.subresource ? { subresource: action.subresource } : {}),
        },
      },
      meta: {
        title,
        command: kubectl(
          context,
          namespace,
          'patch',
          objectArg(kindOf(object), name),
          `--type=${action.type}`,
          '-p',
          JSON.stringify(body),
          ...(action.subresource ? [`--subresource=${action.subresource}`] : []),
        ),
      },
    }
  }
  const done = step(
    action.patch!,
    action.done ? render(action.done, object, now, inputs) : `${action.name}: ${name}`,
  )
  return {
    change: done.change,
    meta: {
      ...done.meta,
      ...(action.undo
        ? { undo: step(action.undo, `Undid ${action.name.toLowerCase()} on ${name}`) }
        : {}),
    },
  }
}

/** Five random characters, as the API server adds to a `generateName`. */
function nameSuffix(): string {
  const characters = 'bcdfghjklmnpqrstvwxz2456789'
  return Array.from({ length: 5 }, () => characters[Math.floor(Math.random() * 27)]).join('')
}

/**
 * The object a view's action creates, with its templates filled in. A
 * generated name is chosen here, so it can be shown and opened afterwards;
 * it lands in the object's namespace unless it says otherwise.
 */
function createdObject(
  action: ViewAction,
  object: KubeObject,
  inputs: InputValues,
  suffix: string,
  now: number,
) {
  const created = renderPatch(action.create!, object, now, inputs) as KubeObject
  const kind = kindFor(created.apiVersion, created.kind!)
  const { generateName, ...metadata } = created.metadata as KubeObject['metadata'] & {
    generateName?: string
  }
  const namespaced = resourceFor(kind)?.namespaced ?? true
  const namespace = metadata.namespace ?? (namespaced ? object.metadata.namespace : undefined)
  return {
    kind,
    object: {
      ...created,
      metadata: {
        ...metadata,
        name: metadata.name || `${generateName}${suffix}`,
        ...(namespace ? { namespace } : {}),
      },
    } as KubeObject,
  }
}

/** A patch's change and what's said about it, as the dialog submits them. */
function instantChange({ change, meta }: InstantChange) {
  return { request: change, meta }
}

/** Creating what a view's action makes, then offering to open it. */
function createChange(
  action: ViewAction,
  object: KubeObject,
  context: string,
  inputs: InputValues,
  { suffix, now }: { suffix: string; now: number },
  go: (to: string) => void,
): { request: ClusterChange; meta: ChangeMeta; created: KubeObject } {
  const { kind, object: created } = createdObject(action, object, inputs, suffix, now)
  const { name, namespace } = created.metadata
  return {
    request: { kind, namespace, change: { action: 'create', object: created } },
    meta: {
      title: action.done
        ? render(action.done, object, now, inputs)
        : `${action.name}: ${object.metadata.name}`,
      command: kubectl(context, namespace, 'create', '-f', `${name}.yaml`),
      action: {
        label: 'Open',
        run: () =>
          go(
            `${kindPath(context, kind)}?open=${encodeURIComponent(formatRef({ kind, name, namespace }))}`,
          ),
      },
    },
    created,
  }
}

export function viewActionIcon(action: ViewAction) {
  return action.icon ? VIEW_ICONS[action.icon] : Zap
}

/** The value an input starts with: its default, or a choice's first option. */
function initial(input: ViewInput, object: KubeObject): string {
  const value = input.default ? render(input.default, object) : ''
  if (input.type === 'number') return String(Number(value) || 0)
  return value || (input.type === 'choice' ? (inputOptions(input, object)[0] ?? '') : '')
}

/**
 * A view's action that asks first: with the view's own words, the values it
 * asks for, and what it would create.
 */
export function ViewActionDialog({ object, onClose }: ActionProps) {
  const { context } = useCluster()
  const change = useChange()
  const go = useGo()
  const { pending, error, submit } = useSubmit(onClose)
  const id = useActionsUi((state) => state.active!.id)
  const action = viewFor(kindOf(object))!.actions![Number(id.slice('view:'.length))]!
  // What's typed and picked, as text; numbers count as numbers once there's one.
  const [typed, setTyped] = useState<Record<string, string>>(() =>
    Object.fromEntries((action.inputs ?? []).map((input) => [input.name, initial(input, object)])),
  )
  const inputs: InputValues = Object.fromEntries(
    (action.inputs ?? []).map(({ name, type }) => {
      const value = typed[name]!
      return [name, type === 'number' && value !== '' ? Number(value) : value]
    }),
  )
  // Chosen once, so what's shown is what's created: a name, and the time templates say.
  const [once] = useState(() => ({ suffix: nameSuffix(), now: Date.now() }))
  const ready = Object.values(typed).every((value) => value.trim() !== '')

  const { request, meta, created } = action.create
    ? createChange(action, object, context, inputs, once, go)
    : {
        ...instantChange(viewChange(action, object, context, inputs, once.now)),
        created: undefined,
      }

  return (
    <ActionDialog
      icon={viewActionIcon(action)}
      tone={action.danger ? 'danger' : 'default'}
      title={`${action.name} ${object.metadata.name}?`}
      subject={subjectOf(object)}
      command={meta.command}
      confirmLabel={action.name}
      ready={ready}
      pending={pending}
      error={error}
      wide={Boolean(created)}
      onClose={onClose}
      onSubmit={() => void submit(() => change(request, meta))}
    >
      {action.confirm && (
        <p className="text-[13px] leading-relaxed text-ink-2">
          {render(action.confirm, object, once.now, inputs)}
        </p>
      )}
      {action.inputs?.map((input) => (
        <InputField
          key={input.name}
          input={input}
          object={object}
          value={typed[input.name]!}
          onChange={(value) => setTyped({ ...typed, [input.name]: value })}
        />
      ))}
      {created && (
        <div>
          <p className="mb-1.5 text-xs font-medium text-ink-2">
            Creates {created.kind} {created.metadata.name}
          </p>
          <div className="flex max-h-60 overflow-hidden rounded-lg border border-line">
            <YamlText text={toYaml(created)} label={`${created.kind} to create`} />
          </div>
        </div>
      )}
    </ActionDialog>
  )
}

/** A value an action asks for: text, a number, or one of a few choices. */
function InputField({
  input,
  object,
  value,
  onChange,
}: {
  input: ViewInput
  object: KubeObject
  value: string
  onChange: (value: string) => void
}) {
  if (input.type === 'choice') {
    const options = inputOptions(input, object)
    return (
      <div role="radiogroup" aria-label={input.label}>
        <p className="mb-1.5 text-xs font-medium text-ink-2">{input.label}</p>
        {options.length === 0 && (
          <p className="text-xs text-ink-3">There’s nothing to choose from.</p>
        )}
        <div className="space-y-1">
          {options.map((option) => (
            <label
              key={option}
              className={cn(
                'flex cursor-default items-center gap-3 rounded-lg border px-3 py-1.5 font-mono text-xs transition-colors',
                value === option
                  ? 'border-accent bg-accent-soft/60 text-ink-1'
                  : 'border-line text-ink-2',
              )}
            >
              <input
                type="radio"
                name={input.name}
                checked={value === option}
                onChange={() => onChange(option)}
                className="accent-[var(--accent)]"
              />
              {option}
            </label>
          ))}
        </div>
      </div>
    )
  }
  if (input.type === 'number') {
    return (
      <div>
        <p className="mb-1.5 text-xs font-medium text-ink-2">{input.label}</p>
        <Stepper
          label={input.label}
          value={value === '' ? Number.NaN : Number(value)}
          onChange={(next) => onChange(Number.isNaN(next) ? '' : String(next))}
        />
      </div>
    )
  }
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-ink-2">{input.label}</span>
      <input
        aria-label={input.label}
        value={value}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-[13px] text-ink-1 outline-none focus:border-accent focus:ring-3 focus:ring-accent-soft"
      />
    </label>
  )
}

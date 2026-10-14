import { Zap } from 'lucide-react'
import { useState } from 'react'
import type { KubeObject } from '@shared/api'
import { jsonPath } from '@shared/jsonpath'
import { kindFor } from '@shared/resources'
import { harmedVerb } from '@shared/plugin-changes'
import { VIEW_ICONS } from '@renderer/components/KindIcon'
import { Stepper } from '@renderer/components/Stepper'
import { YamlText } from '@renderer/components/YamlText'
import {
  atVersion,
  useChange,
  type ClusterChange,
  type PluginChangeMeta,
} from '@renderer/hooks/change'
import { useGo } from '@renderer/hooks/go'
import { resourceFor } from '@renderer/hooks/resources'
import { Switch } from '@renderer/components/Switch'
import { cn } from '@renderer/lib/cn'
import { kubectl, objectArg } from '@renderer/lib/kubectl'
import { formatRef, kindPath } from '@renderer/lib/routes'
import { api } from '@renderer/lib/api'
import {
  actionHarms,
  harmsFor,
  holds,
  inputOptions,
  render,
  renderPatch,
  viewFor,
  type InputValues,
  type ViewAction,
  type ViewInput,
} from '@renderer/lib/plugins'
import { toYaml } from '@renderer/lib/yaml'
import { useActionsUi } from '@renderer/state/actions'
import { useCluster } from '@renderer/state/cluster'
import { ActionDialog, useSubmit } from './ActionDialog'
import { HarmLines } from './HarmLines'
import type { InstantChange } from './catalog'
import { kindOf, subjectOf, target, type ActionProps } from './common'

/**
 * The change a view's patch makes, with its kubectl command and its undo. Shown, it has no
 * version: one judged on a condition is read again as it's sent (`judgedNow`), and goes with the
 * version read then (`version`), which its command and Lumovi's history then say.
 */
export function viewChange(
  action: ViewAction,
  object: KubeObject,
  context: string,
  inputs: InputValues = {},
  now = Date.now(),
  version?: string,
): InstantChange & { meta: PluginChangeMeta } {
  const { name, namespace } = object.metadata
  const step = (patch: NonNullable<ViewAction['patch']>, title: string, at?: string) => {
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
        plugin: true as const,
        title,
        ...(at === undefined ? {} : { atVersion: at }),
        command: kubectl(
          context,
          namespace,
          'patch',
          objectArg(kindOf(object), name),
          `--type=${action.type}`,
          '-p',
          JSON.stringify(at === undefined ? body : atVersion(body, at)),
          ...(action.subresource ? [`--subresource=${action.subresource}`] : []),
        ),
      },
    }
  }
  const done = step(
    action.patch!,
    action.done ? render(action.done, object, now, inputs) : `${action.name}: ${name}`,
    version,
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

/** Whether a view's action is judged again as it's sent: it's offered on a condition, or says what has to stay the same. */
export const judgedAtSend = (action: ViewAction) =>
  !action.create && (action.when !== undefined || action.same !== undefined)

/**
 * What a change judged on an object's version says when the cluster refused it because the
 * object had changed since: Lumovi's words, the same for every plugin.
 */
export const changedSince = (object: KubeObject) =>
  `${object.metadata.name} changed while you looked at it, so nothing was changed. Look at it again.`

/** What a change says when, read again as it's sent, the object isn't as the person saw it. */
export const notSent = (action: ViewAction, object: KubeObject) =>
  `${object.metadata.name} has changed since you looked at it, so ${action.name} wasn’t sent and nothing changed. Look at it again.`

/**
 * Just before a change judged on its object is sent: the object read again, and what the person
 * saw held to it. Its condition holds there still; what its file says has to stay the same is as
 * the person saw it; and its patch (and its undo), filled from what's there now, is what they
 * read. Then it goes with the version read now: what that guards is one round trip, never their
 * reading time (a tool can rewrite an object's status every few seconds). Else nothing's sent.
 */
export async function judgedNow(
  action: ViewAction,
  object: KubeObject,
  context: string,
  inputs: InputValues = {},
  now = Date.now(),
): Promise<
  | { ok: true; version: string; object: KubeObject }
  | { ok: false; message: string; object?: KubeObject }
> {
  const read = await api.kube.get({ context, ...target(object), name: object.metadata.name })
  if (!read.ok) return { ok: false, message: read.error.message }
  const fresh = read.data
  // (Refused, it says what it read too: what's busy already is said as that, not as a change.)
  if (action.when !== undefined && !holds(action.when, fresh)) {
    return { ok: false, message: notSent(action, object), object: fresh }
  }
  const at = (from: KubeObject, path: string) => JSON.stringify(jsonPath(from, path))
  if ((action.same ?? []).some((path) => at(object, path) !== at(fresh, path))) {
    return { ok: false, message: notSent(action, object), object: fresh }
  }
  // What it would send now, filled from what's there now, is what the person read, or nothing.
  const filled = (from: KubeObject) =>
    JSON.stringify([action.patch, action.undo].map((p) => p && renderPatch(p, from, now, inputs)))
  const version = fresh.metadata.resourceVersion
  if (filled(fresh) !== filled(object) || !version) {
    return { ok: false, message: changedSince(object), object: fresh }
  }
  return { ok: true, version, object: fresh }
}

/** A file's line as filled from an object: what the object holds can't make it two. */
const oneLine = (text: string) => text.replace(/\s*[\r\n]+\s*/g, ' ')

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
): { request: ClusterChange; meta: PluginChangeMeta; created: KubeObject } {
  const { kind, object: created } = createdObject(action, object, inputs, suffix, now)
  const { name, namespace } = created.metadata
  return {
    request: { kind, namespace, change: { action: 'create', object: created } },
    meta: {
      plugin: true,
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

/**
 * The value an input starts with, as it's typed or picked: its default, or a choice's first
 * option; a switch's `true` or `false`; a labelled choice's place among its choices.
 */
export function initial(input: ViewInput, object: KubeObject): string {
  if (input.type === 'switch') return input.default === 'true' ? 'true' : 'false'
  if (input.type === 'choice' && input.choices) return '0'
  const value = input.default ? render(input.default, object) : ''
  if (input.type === 'number') return String(Number(value) || 0)
  return value || (input.type === 'choice' ? (inputOptions(input, object)[0] ?? '') : '')
}

/** An action's inputs as their defaults fill them, from `object`: what's sent where none is asked. */
export const defaultInputs = (action: ViewAction, object: KubeObject): InputValues =>
  Object.fromEntries(
    (action.inputs ?? []).map((input) => [input.name, inputValue(input, initial(input, object))]),
  )

/**
 * What an input gives its templates, from what's typed or picked: a number, yes or no, a
 * labelled choice's value as it is, or the text.
 */
export function inputValue(input: ViewInput, typed: string): unknown {
  if (input.type === 'number') return typed === '' ? '' : Number(typed)
  if (input.type === 'switch') return typed === 'true'
  if (input.type === 'choice' && input.choices) return input.choices[Number(typed)]?.value ?? ''
  return typed
}

/** Whether an input has what it needs: a text that starts empty may stay so. */
export const inputReady = (input: ViewInput, typed: string) =>
  input.type === 'switch' ||
  (input.type === 'choice' && input.choices !== undefined) ||
  typed.trim() !== '' ||
  (input.type === 'text' && input.default === '')

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
    (action.inputs ?? []).map((input) => [input.name, inputValue(input, typed[input.name]!)]),
  )
  // Chosen once, so what's shown is what's created: a name, and the time templates say.
  const [once] = useState(() => ({ suffix: nameSuffix(), now: Date.now() }))
  const ready = (action.inputs ?? []).every((input) => inputReady(input, typed[input.name]!))

  const { request, meta, created } = action.create
    ? createChange(action, object, context, inputs, once, go)
    : {
        ...instantChange(viewChange(action, object, context, inputs, once.now)),
        created: undefined,
      }
  // What it harms, as its kind's file says, judged on what it sends (every input asked here).
  const kindHarms = action.create ? [] : harmsFor(kindOf(object))
  const harms =
    kindHarms.length && request.change.action === 'patch'
      ? actionHarms(action, request.change.patch, kindHarms, () => true)
      : []
  const label = action.confirmButton
    ? oneLine(render(action.confirmButton, object, once.now, inputs))
    : action.name

  return (
    <ActionDialog
      icon={viewActionIcon(action)}
      tone={action.danger || harms.length ? 'danger' : 'default'}
      title={
        action.confirmTitle
          ? oneLine(render(action.confirmTitle, object, once.now, inputs))
          : `${action.name} ${object.metadata.name}?`
      }
      name={object.metadata.name}
      subject={subjectOf(object)}
      command={meta.command}
      confirmLabel={harmedVerb(label, harms)}
      ready={ready}
      pending={pending}
      error={error}
      wide={Boolean(created)}
      onClose={onClose}
      onSubmit={() =>
        void submit(async () => {
          // (One its file says can harm is judged too: what it sends is what was shown, harm and all.)
          if (!judgedAtSend(action) && kindHarms.length === 0) return change(request, meta)
          // Judged on its object: held, as it's sent, to what's there now, and sent with the
          // version read then, or not at all.
          const now = await judgedNow(action, object, context, inputs, once.now)
          if (!now.ok) return { ok: false, error: { message: now.message } }
          const sent = viewChange(action, object, context, inputs, once.now, now.version)
          const result = await change(sent.change, sent.meta)
          return !result.ok && result.error.code === 'conflict'
            ? { ...result, error: { ...result.error, message: changedSince(object) } }
            : result
        })
      }
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
      <HarmLines harms={harms} />
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
export function InputField({
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
  if (input.type === 'switch') {
    return (
      <label className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-ink-2">{input.label}</span>
        <Switch
          label={input.label}
          checked={value === 'true'}
          onCheckedChange={(on) => onChange(on ? 'true' : 'false')}
        />
      </label>
    )
  }
  // Labelled choices: the person picks a label, and its value is what's filled in.
  if (input.type === 'choice' && input.choices) {
    return (
      <div role="radiogroup" aria-label={input.label}>
        <p className="mb-1.5 text-xs font-medium text-ink-2">{input.label}</p>
        <div className="space-y-1">
          {input.choices.map((choice, index) => (
            <label
              key={index}
              className={cn(
                'flex cursor-default items-center gap-3 rounded-lg border px-3 py-1.5 text-xs transition-colors',
                value === String(index)
                  ? 'border-accent bg-accent-soft/60 text-ink-1'
                  : 'border-line text-ink-2',
              )}
            >
              <input
                type="radio"
                name={input.name}
                checked={value === String(index)}
                onChange={() => onChange(String(index))}
                className="accent-[var(--accent)]"
              />
              {choice.label}
            </label>
          ))}
        </div>
      </div>
    )
  }
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

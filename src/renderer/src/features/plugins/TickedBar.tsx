/**
 * Lumovi's own bar for the rows a person ticked on a plugin's page, and its dialog for doing one of
 * the plugin's file's actions (`bulk`) to all of them: the plugin's code never picks the rows nor
 * starts the change, and isn't told of it.
 *
 * The dialog reads each object afresh and judges the action on it, as its own button would be:
 * one it isn't offered for, or one it's busy with already, is left out and says why. It asks the
 * action's inputs once (those that say `bulk: false` are their defaults), sends a change to each,
 * four at a time, each read and judged again as it goes and sent with the version read then, and
 * then follows each to how it ended (the file's `ends`), failures first, until it's closed.
 */
import { Layers, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { KubeObject } from '@shared/api'
import type { ObjectRef } from '@shared/kit/declare'
import {
  EXPRESSION,
  INPUT_PATH,
  PLACEHOLDER,
  type InputValues,
  type ViewAction,
} from '@shared/plugins'
import type { ResourceKind } from '@shared/resources'
import { Button } from '@renderer/components/Button'
import { useChange } from '@renderer/hooks/change'
import { labelFor } from '@renderer/hooks/resources'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { objectArg } from '@renderer/lib/kubectl'
import {
  actionBusy,
  actionEnded,
  actionHarms,
  harmsFor,
  holds,
  viewFor,
} from '@renderer/lib/plugins'
import { harmedVerb } from '@shared/plugin-changes'
import { useCluster } from '@renderer/state/cluster'
import { HEALTH_STYLE } from '@renderer/components/Status'
import { ActionDialog } from '../actions/ActionDialog'
import { HarmLines } from '../actions/HarmLines'
import { kindOf } from '../actions/common'
import {
  InputField,
  initial,
  inputReady,
  inputValue,
  changedSince,
  judgedNow,
  viewActionIcon,
  viewChange,
} from '../actions/view-actions'

/** How many changes are in flight at once, as Lumovi's own bulk changes go. */
const AT_ONCE = 4
/** How often what was sent is read again, while it's followed. */
const FOLLOW_MS = 2_000

/** A ticked object's kind, as Lumovi names it. */
const kindOfRef = (object: ObjectRef) => object.kind as ResourceKind

/** The file's actions for a kind that may be done to several: by their place in its view. */
function bulkActions(kind: ResourceKind): { action: ViewAction; at: number }[] {
  return (viewFor(kind)?.actions ?? []).flatMap((action, at) =>
    action.bulk === true && action.patch !== undefined ? [{ action, at }] : [],
  )
}

/**
 * Whether what an action sends is filled in from its object: its patch or undo reads a path of
 * it, or an input that isn't asked of several (whose default may read it). Then each object is
 * sent its own filling, and the command shown is the first's.
 */
function readsItsObject(action: ViewAction): boolean {
  const unasked = new Set(
    (action.inputs ?? []).filter((input) => input.bulk === false).map((input) => input.name),
  )
  const reads = (value: unknown): boolean => {
    if (typeof value === 'string') {
      return [...value.matchAll(PLACEHOLDER)].some(([, expression]) => {
        const [, path, , fallback] = EXPRESSION.exec(expression!) ?? []
        return [path, fallback].some(
          (each) =>
            each !== undefined &&
            each !== 'now' &&
            (!INPUT_PATH.test(each) || unasked.has(each.slice('input.'.length))),
        )
      })
    }
    if (Array.isArray(value)) return value.some(reads)
    return value !== null && typeof value === 'object' && Object.values(value).some(reads)
  }
  return reads(action.patch) || reads(action.undo)
}

export function TickedBar({
  ticked,
  onLetGo,
}: {
  ticked: readonly ObjectRef[]
  onLetGo: () => void
}) {
  const [running, setRunning] = useState<{ action: ViewAction; objects: ObjectRef[] }>()
  if (ticked.length === 0) return null
  // Of one kind, the file's own actions for it; of several, none (one change is one kind's).
  const kinds = new Set(ticked.map(kindOfRef))
  const kind = kinds.size === 1 ? [...kinds][0]! : undefined
  const actions = kind ? bulkActions(kind) : []
  return (
    <>
      <div
        role="toolbar"
        aria-label="Selected rows"
        className="absolute bottom-14 left-1/2 z-20 flex -translate-x-1/2 animate-toast-in items-center gap-1 rounded-xl border border-line-strong bg-surface-2 py-1.5 pr-1.5 pl-3.5 shadow-pop"
      >
        <span className="mr-2 text-[13px] font-medium whitespace-nowrap text-ink-1 tabular-nums">
          {ticked.length} selected
        </span>
        {actions.map(({ action, at }) => {
          const Icon = viewActionIcon(action)
          return (
            <Button
              key={at}
              variant="ghost"
              onClick={() => setRunning({ action, objects: [...ticked] })}
              className={cn(
                'h-7 px-2.5 text-xs',
                action.danger && 'text-critical-text hover:bg-critical/10',
              )}
            >
              <Icon className="!size-3.5" />
              {action.name}…
            </Button>
          )
        })}
        <Button variant="ghost" aria-label="Clear selection" onClick={onLetGo} className="h-7 px-2">
          <X className="!size-3.5" />
        </Button>
      </div>
      {running && (
        <BulkDialog
          action={running.action}
          objects={running.objects}
          onClose={() => setRunning(undefined)}
        />
      )}
    </>
  )
}

/** Each object, as read and judged: to be sent, or left out and why. */
type Judged =
  | { ref: ObjectRef; object: KubeObject; left?: undefined }
  | { ref: ObjectRef; object?: KubeObject; left: string }

/** What became of one sent: still going (the file's word), how it ended, or why it failed. */
interface Going {
  ref: ObjectRef
  state: 'sending' | 'busy' | 'ended' | 'failed' | 'left' | 'unknown'
  word?: string
  level?: keyof typeof HEALTH_STYLE
  message?: string
}

function BulkDialog({
  action,
  objects,
  onClose,
}: {
  action: ViewAction
  objects: readonly ObjectRef[]
  onClose: () => void
}) {
  const { context } = useCluster()
  const change = useChange()
  const [judged, setJudged] = useState<Judged[]>()
  const [typed, setTyped] = useState<Record<string, string>>({})
  const [going, setGoing] = useState<Going[]>()
  const [now] = useState(() => Date.now())
  const asked = (action.inputs ?? []).filter((input) => input.bulk !== false)

  // Each read afresh, and judged as its own button would be.
  useEffect(() => {
    let gone = false
    void Promise.all(
      objects.map(async (ref): Promise<Judged> => {
        const read = await api.kube.get({
          context,
          kind: ref.kind as ResourceKind,
          name: ref.name,
          namespace: ref.namespace,
        })
        if (!read.ok) return { ref, left: `it couldn’t be read: ${read.error.message}` }
        const busy = actionBusy(action, read.data)
        if (busy) return { ref, object: read.data, left: `${busy.word.toLowerCase()} already` }
        if (action.when && !holds(action.when, read.data)) {
          return { ref, object: read.data, left: `${action.name} isn’t offered for it now` }
        }
        return { ref, object: read.data }
      }),
    ).then((all) => {
      if (gone) return
      setJudged(all)
      // Inputs start as they would for the first that's sent.
      const first = all.find((each) => !each.left)?.object
      if (first) {
        setTyped(Object.fromEntries(asked.map((input) => [input.name, initial(input, first)])))
      }
    })
    return () => {
      gone = true
    }
    // (Once, as the dialog opens: what was ticked then.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sending = (judged ?? []).filter(
    (each): each is Judged & { object: KubeObject } => !each.left,
  )
  const left = (judged ?? []).filter((each) => each.left)
  /** The values the change is filled in with: those asked, and the defaults of those that aren't. */
  const valuesFor = (object: KubeObject): InputValues =>
    Object.fromEntries(
      (action.inputs ?? []).map((input) => [
        input.name,
        input.bulk === false
          ? inputValue(input, initial(input, object))
          : inputValue(input, typed[input.name] ?? ''),
      ]),
    )
  const ready =
    judged !== undefined &&
    sending.length > 0 &&
    asked.every((input) => inputReady(input, typed[input.name] ?? ''))
  const kind = objects[0] ? kindOfRef(objects[0]) : ('Pod' as ResourceKind)
  const plural = labelFor(kind)
  const first = sending[0]?.object
  // One command per namespace, each object by its own kind and name; the patch is the first's of
  // each (filled from it, where it reads its object: said under it).
  const byNamespace = new Map<string, KubeObject[]>()
  for (const { object } of sending) {
    const at = object.metadata.namespace ?? ''
    byNamespace.set(at, [...(byNamespace.get(at) ?? []), object])
  }
  const command = [...byNamespace.values()]
    .map((each) => {
      const lead = each[0]!
      const arg = (object: KubeObject) => objectArg(kindOf(object), object.metadata.name)
      return viewChange(action, lead, context, valuesFor(lead), now).meta.command.replace(
        arg(lead),
        each.map(arg).join(' '),
      )
    })
    .join('\n')
  // What it harms, as its kind's file says: judged on each one's own filled patch, and drawn where
  // it holds for any of them. (Only what's asked of the person quiets one; a default never does.)
  // At the send each is judged again, its patch the one it was shown, so no other harm goes.
  const kindHarms = harmsFor(kind)
  const sentPatch = (object: KubeObject) => {
    const sent = viewChange(action, object, context, valuesFor(object), now).change.change
    return sent.action === 'patch' ? sent.patch : undefined
  }
  const fired = kindHarms.filter((harm) =>
    sending.some(
      ({ object }) =>
        actionHarms(action, sentPatch(object), [harm], (input) => input.bulk !== false).length > 0,
    ),
  )

  // Sent four at a time, each judged again as it goes; then each is followed.
  const send = async () => {
    // (Each named as it was ticked: by Lumovi's own name for its kind.)
    const order = sending
    setGoing(order.map((each) => ({ ref: each.ref, state: 'sending' })))
    const set = (index: number, next: Partial<Going>) =>
      setGoing((was) => was?.map((each, i) => (i === index ? { ...each, ...next } : each)))
    let next = 0
    const worker = async () => {
      while (next < order.length) {
        const index = next++
        const { object } = order[index]!
        // Judged again as it's sent, as its own button's change is; busy with it already by
        // then, left out. It goes with the version read now, which guards one round trip, never
        // the person's reading time (a tool can rewrite its objects' status every few seconds).
        const values = valuesFor(object)
        const sentAt = Date.now()
        const now = await judgedNow(action, object, context, values, sentAt)
        // Busy with it already by then is said as that first, refused or not: an action offered
        // only while it isn't (Argo CD's Sync) is refused by its condition too.
        const busy = now.object && actionBusy(action, now.object)
        if (busy) {
          set(index, { state: 'left', message: `${busy.word.toLowerCase()} already` })
          continue
        }
        if (!now.ok) {
          set(index, { state: 'failed', message: now.message })
          continue
        }
        const sent = viewChange(action, object, context, values, sentAt, now.version)
        const result = await change(sent.change, sent.meta)
        set(
          index,
          result.ok
            ? { state: 'busy' }
            : {
                state: 'failed',
                message:
                  result.error.code === 'conflict' ? changedSince(object) : result.error.message,
              },
        )
      }
    }
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, order.length) }, worker))
  }

  // Followed until it's closed: each one's file's busy state, then how it ended.
  useEffect(() => {
    if (!going?.some((each) => each.state === 'busy')) return
    const timer = setInterval(() => {
      going.forEach((each, index) => {
        if (each.state !== 'busy') return
        void api.kube
          .get({
            context,
            kind: each.ref.kind as ResourceKind,
            name: each.ref.name,
            namespace: each.ref.namespace,
          })
          .then((read) => {
            if (!read.ok) return
            const busy = actionBusy(action, read.data)
            if (busy) {
              setGoing((was) =>
                was?.map((one, i) => (i === index ? { ...one, word: busy.word } : one)),
              )
              return
            }
            const ended = actionEnded(action, read.data)
            setGoing((was) =>
              was?.map((one, i) =>
                i !== index
                  ? one
                  : ended
                    ? { ...one, state: 'ended', ...ended }
                    : action.ends
                      ? one
                      : { ...one, state: 'unknown' },
              ),
            )
          })
      })
    }, FOLLOW_MS)
    return () => clearInterval(timer)
  }, [going, action, context])

  const started = going?.filter(
    (each) => each.state !== 'failed' && each.state !== 'left' && each.state !== 'sending',
  )
  return (
    <ActionDialog
      icon={Layers}
      title={
        going
          ? `${action.name}: started ${started?.length ?? 0} of ${going.length}`
          : `${action.name} ${sending.length || objects.length} ${plural}?`
      }
      subject={`${plural}${objects[0]?.namespace ? ` · ${objects[0].namespace}` : ''}`}
      command={command}
      {...(first && readsItsObject(action)
        ? {
            commandNote: `Shown for ${[...byNamespace.values()].map((each) => each[0]!.metadata.name).join(', ')}: each is filled in from its own object.`,
          }
        : {})}
      confirmLabel={`${harmedVerb(action.name, fired)} ${sending.length} ${plural}`}
      tone={action.danger || fired.length ? 'danger' : 'default'}
      ready={ready && !going}
      pending={false}
      wide
      {...(going
        ? {
            footer: (
              <Button variant="secondary" onClick={onClose}>
                Close
              </Button>
            ),
          }
        : {})}
      onSubmit={() => void send()}
      onClose={onClose}
    >
      {judged === undefined ? (
        <p className="text-[13px] text-ink-3">Reading them…</p>
      ) : going ? (
        <ul aria-label="How each is going" className="space-y-1">
          {[...going]
            // Failures first, then those still going, then the rest.
            .sort((a, b) => rankOf(a) - rankOf(b))
            .map((each) => (
              <li
                key={`${each.ref.namespace}/${each.ref.name}`}
                className="flex items-baseline gap-2 text-[13px]"
              >
                <span className="min-w-0 flex-1 truncate text-ink-1">{each.ref.name}</span>
                <span
                  className={cn(
                    'shrink-0 text-xs',
                    each.state === 'failed'
                      ? 'text-critical-text'
                      : each.level
                        ? HEALTH_STYLE[each.level].text
                        : 'text-ink-2',
                  )}
                >
                  {each.state === 'sending'
                    ? 'Sending'
                    : each.state === 'left'
                      ? `Left out: ${each.message ?? ''}`
                      : each.state === 'failed'
                        ? `Not started: ${each.message ?? ''}`
                        : each.state === 'unknown'
                          ? 'Started'
                          : each.state === 'ended'
                            ? `${each.word}${each.message ? `: ${each.message}` : ''}`
                            : (each.word ?? 'Started')}
                </span>
              </li>
            ))}
        </ul>
      ) : (
        <>
          <HarmLines harms={fired} />
          <div>
            <p className="mb-1.5 text-xs font-medium text-ink-2">
              {action.name} for these {sending.length}:
            </p>
            <ul aria-label="What it changes" className="max-h-40 space-y-0.5 overflow-y-auto">
              {sending.map((each) => (
                <li
                  key={`${each.ref.namespace}/${each.ref.name}`}
                  className="text-[13px] text-ink-1"
                >
                  {each.ref.name}
                </li>
              ))}
            </ul>
          </div>
          {left.length > 0 && (
            <ul aria-label="Left out" className="space-y-0.5 text-xs text-ink-2">
              {left.map((each) => (
                <li key={`${each.ref.namespace}/${each.ref.name}`}>
                  Left out: {each.ref.name}, {each.left}.
                </li>
              ))}
            </ul>
          )}
          {first &&
            asked.map((input) => (
              <InputField
                key={input.name}
                input={input}
                object={first}
                value={typed[input.name] ?? ''}
                onChange={(value) => setTyped({ ...typed, [input.name]: value })}
              />
            ))}
          <p className="text-xs text-ink-3">
            Lumovi sends each with the version it judged it on, which the command can’t say.
          </p>
        </>
      )}
    </ActionDialog>
  )
}

/** Failures first, then those still going, then those that ended. */
function rankOf(each: Going): number {
  if (each.state === 'failed' || each.state === 'left' || each.level === 'critical') return 0
  if (each.state === 'busy' || each.state === 'sending') return 1
  return 2
}

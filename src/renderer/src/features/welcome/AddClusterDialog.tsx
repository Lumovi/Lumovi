/**
 * Adding a cluster (⌘N, or Add cluster), or editing one added in Lumovi: a kubeconfig pasted, or
 * a file dropped or chosen, then checked (it reads as a kubeconfig; each context's server
 * answers, and its credentials work), then kept in Lumovi's own folder. What its credentials
 * would do here that the person agrees to first (go to a server not verified, run a program,
 * send a file, or send what Lumovi kept to somewhere new) is shown exactly, and nothing is done
 * until the person allows it. Done, it's named, colored and grouped, and the line for kubectl
 * given.
 */
import { useQueryClient } from '@tanstack/react-query'
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  ClipboardPaste,
  FileUp,
  LoaderCircle,
  Pencil,
  Plus,
  RotateCw,
  ShieldAlert,
  TriangleAlert,
} from 'lucide-react'
import { Fragment, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import type { ClusterCheck, PastedKubeconfig } from '@shared/api'
import { Button } from '@renderer/components/Button'
import { CodeEditor } from '@renderer/components/CodeEditor'
import { CopyButton } from '@renderer/components/CopyButton'
import { useGo } from '@renderer/hooks/go'
import { useSettings } from '@renderer/hooks/settings'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { hostOf } from '@renderer/lib/format'
import { clusterPath } from '@renderer/lib/routes'
import { toast } from '@renderer/state/toasts'
import { Combo, Swatches } from './ClusterSettingsDialog'
import { DialogIcon, PageDialog } from './PageDialog'

/** How Lumovi names the clusters and users in its own files. */
const OWN_NAME = /^lumovi-[0-9a-f]{12}$/

/** The largest kubeconfig read (as the main process reads it). */
const MAX_TEXT = 1024 * 1024

/** How long a credentials step shows its spinner, at least, and between one step and the next. */
const CREDENTIALS_SHOWN_MS = 300
const STEP_MS = 80

type Stage = 'input' | 'checking' | 'agree' | 'failed' | 'done'

/** A context's check, as shown: the server's first, then (a moment later) the credentials'. */
interface Checked {
  result: ClusterCheck
  credentialsShown: boolean
}

/** What a run of the check came to, kept for what follows it. */
interface Run {
  inspected: PastedKubeconfig
  agreed: string[]
}

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms))

/** Everything its credentials would do that's agreed to first: the server's, then the rest. */
function consentsOf(inspected: PastedKubeconfig) {
  return {
    servers: inspected.unverified.map(({ consent }) => consent),
    rest: [
      ...inspected.commands.map(({ consent }) => consent),
      ...inspected.tokenFiles.map(({ consent }) => consent),
      ...inspected.keptCredentials.map(({ consent }) => consent),
    ],
  }
}

export function AddClusterDialog({
  editing,
  groups,
  onDone,
  onClose,
}: {
  /** One added in Lumovi, its connection edited: its file, and the context it was opened for. */
  editing?: { path: string; context: string }
  groups: string[]
  /** Added (or saved): the context to show, and whether to open it. */
  onDone: (context: string, open: boolean) => void
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [mode, setMode] = useState<'paste' | 'file'>('paste')
  const [text, setText] = useState('')
  const [from, setFrom] = useState<string>()
  const [stage, setStage] = useState<Stage>('input')
  const [inspected, setInspected] = useState<PastedKubeconfig>()
  const [readError, setReadError] = useState<string>()
  const [checks, setChecks] = useState<Record<string, Checked>>({})
  const [checking, setChecking] = useState<string>()
  const [agreed, setAgreed] = useState<string[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [anyway, setAnyway] = useState(false)
  const [added, setAdded] = useState<{ path: string; context: string; line?: string }>()
  const [error, setError] = useState<string>()
  // Each run of the check, and whether the dialog's still open: a late answer is dropped.
  const runs = useRef(0)
  const open = useRef(true)
  // The names as typed now: one typed while it's checked is the one it's added as.
  const namesNow = useRef(names)
  useEffect(() => {
    namesNow.current = names
  })
  useEffect(
    () => () => {
      open.current = false
    },
    [],
  )
  const current = (run: number) => open.current && runs.current === run

  // Editing: its kubeconfig as kept (its secrets as placeholders, which stay as they were).
  useEffect(() => {
    if (!editing) return
    void api.addedClusters!.read(editing.path).then((result) => {
      if (result.ok) setText(result.data)
      else setError(result.error.message)
    })
  }, [editing])

  // The context shown and opened: the one being edited, or the first added (as named).
  const shownContext = (found: PastedKubeconfig, renamed: Record<string, string>) => {
    const name =
      editing && found.contexts.some((context) => context.name === editing.context)
        ? editing.context
        : found.contexts[0]!.name
    return renamed[name] ?? name
  }

  const keep = async (run: Run, runId: number) => {
    setError(undefined)
    const result = editing
      ? await api.addedClusters!.edit(editing.path, text, run.agreed)
      : await api.addedClusters!.add(text, {
          names: Object.fromEntries(
            Object.entries(namesNow.current).filter(([name]) =>
              run.inspected.conflicts.includes(name),
            ),
          ),
          agreed: run.agreed,
        })
    if (!current(runId)) return
    if (!result.ok) {
      // Said where it can be seen, and what to do next: never left checking.
      setError(result.error.message)
      setStage('failed')
      return
    }
    setAdded({
      path: editing ? editing.path : (result.data as { path: string }).path,
      context: shownContext(run.inspected, namesNow.current),
    })
    await queryClient.invalidateQueries({ queryKey: ['contexts'] })
    if (current(runId)) setStage('done')
  }

  useEffect(() => {
    if (!added || added.line) return
    void api.addedClusters!.forKubectl(added.path).then((result) => {
      if (result.ok) setAdded((now) => now && { ...now, line: result.data })
    })
  }, [added])

  const run = async (agreedNow: string[]) => {
    const runId = ++runs.current
    setStage('checking')
    setError(undefined)
    setChecks({})
    setReadError(undefined)
    setInspected(undefined)
    const read = await api.addedClusters!.inspect(text, editing?.path)
    if (!current(runId)) return
    if (!read.ok) {
      setReadError(read.error.message)
      setStage('failed')
      return
    }
    const found = read.data
    setInspected(found)
    // A context named as one already read is added under another name (kubectl would take the other).
    const renamed = Object.fromEntries(
      found.conflicts.map((name) => [name, names[name] ?? `${name}-2`]),
    )
    setNames(renamed)
    namesNow.current = renamed
    const thisRun: Run = { inspected: found, agreed: agreedNow }

    // Each context, one after another: its server, then a moment later its credentials.
    const results: ClusterCheck[] = []
    for (const context of found.contexts) {
      setChecking(context.name)
      const checked = await api.addedClusters!.check(text, context.name, agreedNow, editing?.path)
      if (!current(runId)) return
      if (!checked.ok) {
        setChecking(undefined)
        setError(`${context.name}: ${checked.error.message}`)
        setStage('failed')
        return
      }
      results.push(checked.data)
      setChecks((now) => ({
        ...now,
        [context.name]: { result: checked.data, credentialsShown: false },
      }))
      await wait(CREDENTIALS_SHOWN_MS)
      if (!current(runId)) return
      setChecks((now) => ({
        ...now,
        [context.name]: { result: checked.data, credentialsShown: true },
      }))
      await wait(STEP_MS)
    }
    setChecking(undefined)
    if (!current(runId)) return

    // What's agreed to first, decided from what it holds: for any context, before anything goes.
    const { servers, rest } = consentsOf(found)
    if ([...servers, ...rest].some((consent) => !agreedNow.includes(consent))) {
      return setStage('agree')
    }
    if (results.some(({ server }) => !server.ok)) return setStage('failed')
    if (results.some(({ credentials }) => !credentials.ok)) return setStage('failed')
    await keep(thisRun, runId)
  }

  const pending = inspected
    ? (() => {
        const { servers, rest } = consentsOf(inspected)
        const unagreed = (consents: string[]) => consents.filter((c) => !agreed.includes(c))
        // The server's first; then the rest, one panel after the other.
        return unagreed(servers).length > 0
          ? { kind: 'servers' as const, consents: unagreed(servers) }
          : { kind: 'rest' as const, consents: unagreed(rest) }
      })()
    : undefined

  const allow = () => {
    if (!inspected || !pending) return
    const now = [...agreed, ...pending.consents]
    setAgreed(now)
    const { servers, rest } = consentsOf(inspected)
    // More to agree to: its panel next.
    if ([...servers, ...rest].some((consent) => !now.includes(consent))) return
    if (anyway) {
      const runId = ++runs.current
      setStage('checking')
      void keep({ inspected, agreed: now }, runId)
    } else void run(now)
  }

  const addAnyway = () => {
    if (!inspected) return
    setAnyway(true)
    const { servers, rest } = consentsOf(inspected)
    if ([...servers, ...rest].some((consent) => !agreed.includes(consent))) setStage('agree')
    else {
      const runId = ++runs.current
      setStage('checking')
      void keep({ inspected, agreed }, runId)
    }
  }

  // Edited again: what was checked (and "anyway") no longer holds.
  const backToInput = () => {
    runs.current++
    setAnyway(false)
    setStage('input')
    setMode(from ? 'file' : 'paste')
  }

  const serverFailed = Object.values(checks).some(({ result }) => !result.server.ok)
  // Held back only by plain HTTP, which Lumovi won't connect over: trying again can't help, adding
  // it anyway (for kubectl) can.
  const onlyPlain =
    serverFailed &&
    !readError &&
    !error &&
    Object.entries(checks).every(([name, { result }]) =>
      result.server.ok
        ? result.credentials.ok
        : unreached(inspected?.contexts.find((context) => context.name === name) ?? {}),
    )
  const footer = (() => {
    const cancel = (
      <Button variant="ghost" onClick={onClose}>
        Cancel
      </Button>
    )
    switch (stage) {
      case 'input':
        return (
          <>
            <span className="ml-auto" />
            {cancel}
            <Button type="submit" variant="primary" disabled={!text.trim()}>
              Check it
            </Button>
          </>
        )
      case 'checking':
        return (
          <>
            <span className="ml-auto" />
            {cancel}
            <Button variant="primary" aria-disabled className="pointer-events-none opacity-50">
              <LoaderCircle className="animate-spin" /> Checking
            </Button>
          </>
        )
      case 'agree':
        return (
          <>
            <span className="ml-auto" />
            <Button variant="ghost" onClick={onClose}>
              Don’t add it
            </Button>
            <Button type="submit" variant="primary">
              Allow and continue
            </Button>
          </>
        )
      case 'failed':
        if (onlyPlain) {
          return (
            <>
              <span className="ml-auto" />
              <Button variant="secondary" onClick={backToInput}>
                Back
              </Button>
              <Button type="submit" variant="primary">
                Add it anyway
              </Button>
            </>
          )
        }
        return (
          <>
            {serverFailed && !readError && !error && (
              <Button variant="ghost" className="-ml-2" onClick={addAnyway}>
                Add it anyway
              </Button>
            )}
            <span className="ml-auto" />
            <Button variant="secondary" onClick={backToInput}>
              Back
            </Button>
            <Button type="submit" variant="primary">
              <RotateCw /> Try again
            </Button>
          </>
        )
      case 'done':
        return null
    }
  })()

  if (stage === 'done' && added && inspected) {
    return (
      <Ready
        context={added.context}
        line={added.line}
        groups={groups}
        checks={checks}
        inspected={inspected}
        names={names}
        editing={!!editing}
        onDone={(openIt) => onDone(added.context, openIt)}
      />
    )
  }

  return (
    <PageDialog
      leading={<DialogIcon>{editing ? <Pencil /> : <Plus />}</DialogIcon>}
      title={editing ? 'Edit connection' : 'Add a cluster'}
      subtitle="Lumovi keeps it in its own folder. Your kubeconfig stays as it is."
      error={error}
      onSubmit={() => {
        if (stage === 'agree') allow()
        else if (stage === 'failed' && onlyPlain) addAnyway()
        else if (stage === 'input' || stage === 'failed') void run(agreed)
      }}
      onClose={() => {
        // Closed: nothing that was under way adds it.
        runs.current++
        onClose()
      }}
      footer={footer}
    >
      {stage === 'input' ? (
        <Input
          mode={mode}
          onMode={setMode}
          text={text}
          onText={(value, name) => {
            setText(value)
            setFrom(name)
          }}
          from={from}
          onError={setError}
        />
      ) : (
        <>
          <Pasted from={from} inspected={inspected} onEdit={backToInput} />
          <Steps
            stage={stage}
            inspected={inspected}
            readError={readError}
            checks={checks}
            checking={checking}
            names={names}
            onName={(name, value) => setNames((now) => ({ ...now, [name]: value }))}
          />
          {stage === 'agree' && inspected && pending && (
            <Agreement inspected={inspected} kind={pending.kind} />
          )}
        </>
      )}
    </PageDialog>
  )
}

/** Pasting a kubeconfig, or a file: dropped, or chosen. */
function Input({
  mode,
  onMode,
  text,
  onText,
  from,
  onError,
}: {
  mode: 'paste' | 'file'
  onMode: (mode: 'paste' | 'file') => void
  text: string
  onText: (text: string, from?: string) => void
  from?: string
  onError: (error?: string) => void
}) {
  const [over, setOver] = useState(false)
  const drop = async (event: DragEvent) => {
    event.preventDefault()
    setOver(false)
    const file = event.dataTransfer.files[0]
    if (!file) return
    if (file.size > MAX_TEXT) return onError('It’s larger than any kubeconfig (over 1 MB).')
    onError(undefined)
    onText(await file.text(), file.name)
  }
  const choose = async () => {
    const result = await api.addedClusters!.import()
    if (!result.ok) return onError(result.error.message)
    if (result.data !== null) onText(result.data, 'the file chosen')
  }
  return (
    <>
      <div
        role="group"
        aria-label="From"
        className="mb-3 inline-flex gap-0.5 rounded-lg bg-surface-3 p-0.5"
      >
        {(
          [
            ['paste', 'Paste', ClipboardPaste],
            ['file', 'A file', FileUp],
          ] as const
        ).map(([value, label, Icon]) => (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            onClick={() => onMode(value)}
            className={cn(
              'flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs whitespace-nowrap transition-colors',
              mode === value
                ? 'bg-surface font-semibold text-ink-1 shadow-xs ring-1 ring-line'
                : 'font-medium text-ink-2 hover:text-ink-1',
            )}
          >
            <Icon className="size-3.5" /> {label}
          </button>
        ))}
      </div>
      {mode === 'paste' ? (
        <>
          <div className="h-[300px] overflow-hidden rounded-lg border border-line-strong bg-surface focus-within:border-accent focus-within:ring-3 focus-within:ring-accent-soft [&_.cm-editor]:h-full">
            <CodeEditor
              label="Kubeconfig"
              value={text}
              onChange={(value) => onText(value)}
              onSave={() => undefined}
            />
          </div>
          <p className="mt-2 text-xs text-ink-3">
            A whole kubeconfig, or one context from one, with its cluster and user.
          </p>
        </>
      ) : (
        <>
          <div
            onDragOver={(event) => {
              event.preventDefault()
              setOver(true)
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(event) => void drop(event)}
            className={cn(
              'flex flex-col items-center gap-1.5 rounded-xl border-[1.5px] border-dashed px-5 py-10 text-center transition-colors',
              over ? 'border-accent bg-accent-soft' : 'border-line-strong',
            )}
          >
            <span
              className={cn(
                'mb-1.5 grid size-10 place-items-center rounded-xl transition-colors',
                over ? 'bg-surface text-accent-strong' : 'bg-surface-3 text-ink-2',
              )}
            >
              <FileUp className="size-5" />
            </span>
            <span className="text-[13px] font-medium text-ink-1">
              {from ? 'Ready to check' : over ? 'Drop it to add it' : 'Drop a kubeconfig here'}
            </span>
            {from && <span className="text-xs text-ink-3">{from}</span>}
          </div>
          <p className="mt-3 text-xs text-ink-3">
            Or{' '}
            <button
              type="button"
              className="font-medium text-accent-strong hover:underline"
              onClick={() => void choose()}
            >
              choose a file…
            </button>{' '}
            Lumovi copies what it needs, so the file can move or go.
          </p>
        </>
      )}
    </>
  )
}

/** What's being checked: pasted, or from a file, and what's in it. */
function Pasted({
  from,
  inspected,
  onEdit,
}: {
  from?: string
  inspected?: PastedKubeconfig
  onEdit: () => void
}) {
  const contexts = inspected?.contexts ?? []
  return (
    <div className="mb-4 flex items-center gap-2.5 rounded-lg bg-surface-3 px-3 py-2 text-xs text-ink-2">
      {from ? (
        <FileUp className="size-3.5 shrink-0" />
      ) : (
        <ClipboardPaste className="size-3.5 shrink-0" />
      )}
      <span className="min-w-0 truncate">
        {from ? 'From a file' : 'Pasted'}
        {contexts.length > 0 && (
          <>
            {' '}
            · {contexts.length} {contexts.length === 1 ? 'context' : 'contexts'},{' '}
            <span className="font-mono text-ink-1">
              {contexts.map((context) => context.name).join(', ')}
            </span>
          </>
        )}
      </span>
      <button
        type="button"
        onClick={onEdit}
        className="ml-auto shrink-0 font-medium text-accent-strong hover:underline"
      >
        Edit
      </button>
    </div>
  )
}

type StepState = 'ok' | 'failed' | 'warn' | 'checking' | 'waiting'

function Step({
  state,
  title,
  detail,
  hint,
  index,
  mono = false,
  children,
}: {
  state: StepState
  title: string
  detail?: ReactNode
  /** Its detail is names or addresses (mono), not a sentence. */
  mono?: boolean
  hint?: ReactNode
  /** Where it is in the list: each comes a moment after the one before. */
  index: number
  children?: ReactNode
}) {
  const Icon = {
    ok: CircleCheck,
    failed: CircleX,
    warn: CircleAlert,
    checking: LoaderCircle,
    waiting: CircleDashed,
  }[state]
  return (
    <li
      className="flex animate-fade-in gap-2.5"
      style={{ animationDelay: `${index * STEP_MS}ms`, animationFillMode: 'both' }}
    >
      <Icon
        aria-hidden
        className={cn(
          'mt-0.5 size-4 shrink-0',
          state === 'ok' && 'animate-spin-once text-good-text',
          state === 'failed' && 'text-critical-text',
          state === 'warn' && 'text-warn-text',
          state === 'checking' && 'animate-spin text-ink-3',
          state === 'waiting' && 'text-ink-3',
        )}
      />
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block text-[13px]',
            // Still to come: regular, and quiet.
            state === 'waiting' ? 'font-normal text-ink-3' : 'font-medium text-ink-1',
          )}
        >
          {title}
        </span>
        {detail && (
          <span className={cn('block truncate text-xs text-ink-3', mono && 'font-mono')}>
            {detail}
          </span>
        )}
        {hint && <span className="mt-0.5 block text-xs text-ink-2">{hint}</span>}
        {children}
      </span>
    </li>
  )
}

/** A user's name, unless it's one Lumovi gave in its own files (lumovi-…), which means nothing. */
const userOf = (user?: string) => (user && !OWN_NAME.test(user) ? user : undefined)

/** The check, step by step: it reads; then each context's server answers, and it signs in. */
function Steps({
  stage,
  inspected,
  readError,
  checks,
  checking,
  names,
  onName,
}: {
  stage: Stage
  inspected?: PastedKubeconfig
  readError?: string
  checks: Record<string, Checked>
  /** The context being checked now. */
  checking?: string
  names: Record<string, string>
  /** A conflict's name, typed: none once it's added. */
  onName?: (name: string, value: string) => void
}) {
  const contexts = inspected?.contexts ?? []
  const one = contexts.length === 1
  const reads: StepState = readError ? 'failed' : inspected ? 'ok' : 'checking'
  let index = 0
  return (
    <ol className="space-y-3">
      <Step
        index={index++}
        state={reads}
        mono={reads !== 'failed'}
        title={reads === 'failed' ? 'It doesn’t read as a kubeconfig' : 'It reads as a kubeconfig'}
        detail={
          reads === 'failed'
            ? readError
            : one
              ? `${contexts[0]!.name}${userOf(contexts[0]!.user) ? ` · user ${userOf(contexts[0]!.user)}` : ''}`
              : contexts.length > 0
                ? `${contexts.length} contexts: ${contexts.map((context) => context.name).join(', ')}`
                : undefined
        }
      >
        {inspected?.conflicts.map((name) =>
          onName ? (
            <label key={name} className="mt-1.5 flex items-center gap-2 text-xs text-ink-2">
              <span>
                <span className="font-mono">{name}</span> is already read, so it’s added as
              </span>
              <input
                value={names[name] ?? ''}
                onChange={(event) => onName(name, event.target.value)}
                aria-label={`Add ${name} as`}
                className="h-7 w-44 rounded-md border border-line-strong bg-surface px-2 font-mono text-xs text-ink-1 outline-none focus:border-accent focus:ring-3 focus:ring-accent-soft"
              />
            </label>
          ) : (
            <span key={name} className="mt-0.5 block text-xs text-ink-2">
              <span className="font-mono">{name}</span> was already read, so it’s added as{' '}
              <span className="font-mono">{names[name]}</span>
            </span>
          ),
        )}
      </Step>
      {contexts.map((context) => {
        const checked = checks[context.name]
        const result = checked?.result
        const host = hostOf(context.server) ?? context.server
        const plain = /^http:/i.test(context.server ?? '')
        const server: StepState = !result
          ? checking === context.name
            ? 'checking'
            : 'waiting'
          : !result.server.ok
            ? 'failed'
            : context.insecure
              ? 'warn'
              : 'ok'
        // Not tried at all: Lumovi won't, though kubectl will.
        const refused = server === 'failed' && unreached(context)
        const credentials: StepState =
          !result || !checked.credentialsShown
            ? result?.server.ok && stage === 'checking'
              ? 'checking'
              : 'waiting'
            : result.credentials.ok
              ? 'ok'
              : 'notTried' in result.credentials
                ? result.credentials.notTried === 'agreement'
                  ? 'warn'
                  : 'waiting'
                : 'failed'
        const user = userOf(context.user)
        return (
          <Fragment key={context.name}>
            {!one && (
              <li className="pt-1 font-mono text-2xs tracking-wide text-ink-3">{context.name}</li>
            )}
            <Step
              index={index++}
              state={server}
              // Its address and version; what went wrong, as a sentence.
              mono={server !== 'failed'}
              title={
                refused
                  ? 'This cluster uses plain HTTP'
                  : server === 'failed'
                    ? 'The server didn’t answer'
                    : 'The server answers'
              }
              detail={
                refused
                  ? 'Lumovi doesn’t connect over plain HTTP. Add it anyway to use it with kubectl.'
                  : result && !result.server.ok
                    ? result.server.message
                    : result?.server.ok
                      ? [
                          [
                            host,
                            result.server.version,
                            result.server.latencyMs !== undefined &&
                              `${result.server.latencyMs} ms`,
                          ]
                            .filter(Boolean)
                            .join(' · '),
                          // What isn't safe about it, as a sentence.
                          (plain || context.insecure) && (
                            <span key="unsafe" className="font-sans">
                              {' · '}
                              {plain ? 'not encrypted' : 'its certificate isn’t checked'}
                            </span>
                          ),
                        ]
                      : server === 'checking'
                        ? `Asking ${host}…`
                        : undefined
              }
              hint={
                server === 'failed' && !refused
                  ? 'Is it on a network you’re not on, like a VPN? Connect to it and try again.'
                  : undefined
              }
            >
              {context.proxy && (
                <span className="mt-1 flex items-start gap-1.5 text-xs text-warn-text">
                  <CircleAlert className="mt-0.5 size-3 shrink-0" />
                  <span>
                    Everything to it goes through{' '}
                    <span className="font-mono">
                      <Visible text={context.proxy} />
                    </span>
                    .
                  </span>
                </span>
              )}
            </Step>
            <Step
              index={index++}
              state={credentials}
              title={
                credentials === 'failed' ? 'The credentials didn’t work' : 'The credentials work'
              }
              detail={
                result?.credentials.ok && checked?.credentialsShown
                  ? `Signed in${user ? ` as ${user}` : ''} · ${result.credentials.allowed ? 'can list namespaces' : 'can’t list namespaces'}`
                  : result && checked?.credentialsShown && 'message' in result.credentials
                    ? result.credentials.message
                    : credentials === 'warn'
                      ? 'Waiting for you'
                      : undefined
              }
            />
          </Fragment>
        )
      })}
    </ol>
  )
}

/** Characters that change how text reads without being seen: bidi controls, and zero-width ones. */
const UNSEEN = /([\u202A-\u202E\u2066-\u2069\u200B-\u200F\uFEFF])/

/**
 * Text as it is, its unseen characters shown escaped (⟨U+202E⟩): where the person decides what
 * runs, nothing can make it read as other than it is.
 */
export function Visible({ text }: { text: string }) {
  return text.split(UNSEEN).map((part, index) =>
    index % 2 === 1 ? (
      <span
        key={index}
        className="rounded bg-critical/10 px-0.5 text-critical-text"
        title="A character that changes how the text reads, without being seen"
      >
        ⟨U+{part.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟩
      </span>
    ) : (
      part
    ),
  )
}

/** A word of a command, kept whole on its line (one longer than the line, broken within). */
const WORD = 'inline-block max-w-full [overflow-wrap:anywhere]'

/** Over plain HTTP without insecure-skip-tls-verify: Lumovi won't connect to it; kubectl will. */
function unreached(context: { server?: string; insecure?: boolean }): boolean {
  return /^http:/i.test(context.server ?? '') && !context.insecure
}

/** A command's words, as a shell would split them (each kept whole when shown). */
function wordsOf(line: string): string[] {
  return line.match(/'[^']*'|"[^"]*"|\S+/g) ?? [line]
}

/**
 * What its credentials would do here, exactly, to be allowed or not: first a server not
 * verified, then the rest (a program run, a file sent, what Lumovi kept sent somewhere new).
 */
function Agreement({ inspected, kind }: { inspected: PastedKubeconfig; kind: 'servers' | 'rest' }) {
  if (kind === 'servers') {
    // Plain HTTP isn't encrypted at all; the others only skip the certificate check.
    const http = inspected.unverified.filter(({ server }) => /^http:/i.test(server))
    const plain = http.length > 0
    const unchecked = inspected.unverified.length > http.length
    // Without insecure-skip-tls-verify, Lumovi won't connect to it; kubectl will.
    const kubectlOnly =
      plain &&
      http.every(
        ({ context }) => !inspected.contexts.find(({ name }) => name === context)?.insecure,
      )
    return (
      <Panel
        icon={ShieldAlert}
        title={
          plain
            ? 'Its credentials would travel unencrypted'
            : 'Lumovi can’t check it’s the right server'
        }
      >
        {plain && (
          <p>
            The server’s address starts with http://, not https://, so anyone on the network in
            between can read {kubectlOnly ? 'what’s sent to it' : 'what Lumovi sends it'},
            credentials too.
            {kubectlOnly
              ? ' Lumovi won’t connect to it like this, but kubectl will, in Lumovi’s terminals or from its kubectl line. Allow it only if that’s what you want.'
              : unchecked
                ? ''
                : ' Allow sends them now and each time Lumovi connects.'}
          </p>
        )}
        {unchecked && (
          <p className={cn(plain && 'mt-1.5')}>
            This kubeconfig turns off the server’s certificate check (
            <code className="font-mono">insecure-skip-tls-verify</code>), so whatever answers at
            that address gets its credentials. Allow sends them now and each time Lumovi connects;
            with the server’s CA in the kubeconfig, Lumovi checks it instead.
          </p>
        )}
      </Panel>
    )
  }
  const runs = inspected.commands.length > 0
  const sends = inspected.tokenFiles.length > 0
  const kept = inspected.keptCredentials.length > 0
  const doing = [
    runs && 'runs a program on this computer',
    sends && 'sends a file to its server',
    kept && 'sends what Lumovi kept to somewhere new',
  ].filter(Boolean)
  return (
    <Panel
      icon={TriangleAlert}
      title={`Signing in ${doing.slice(0, -1).join(', ')}${doing.length > 1 ? ', and ' : ''}${doing.at(-1)}`}
    >
      {runs && (
        <p>
          This kubeconfig gets its credentials from the command below. Lumovi would run it each time
          it connects, as kubectl does.
        </p>
      )}
      {sends && (
        <p className={cn(runs && 'mt-1.5')}>
          It signs in with the text of the file below, sent to its server each time it connects.
        </p>
      )}
      {kept && (
        <p className={cn((runs || sends) && 'mt-1.5')}>
          Its credentials, kept in Lumovi, would go to the server below, which they weren’t kept
          for.
        </p>
      )}
      <p className="mt-1.5">Allow it only if you trust where the kubeconfig came from.</p>
      {inspected.commands.map((command) => {
        const env = command.env.map(({ name, value }) => `${name}=${value}`)
        return (
          <Box
            key={command.consent}
            label={[
              command.shell ? 'The command, run in a shell' : 'The command',
              command.movedTo && `now for ${command.movedTo}`,
            ]
              .filter(Boolean)
              .join(', ')}
            copy={[...env, command.line].join(' ')}
          >
            {env.map((variable) => (
              <Fragment key={variable}>
                <span className={cn(WORD, 'text-ink-3')}>
                  <Visible text={variable} />
                </span>{' '}
              </Fragment>
            ))}
            {wordsOf(command.line).map((word, index) => (
              <Fragment key={index}>
                <span className={WORD}>
                  <Visible text={word} />
                </span>{' '}
              </Fragment>
            ))}
          </Box>
        )
      })}
      {inspected.tokenFiles.map((file) => (
        <Box
          key={file.consent}
          label={`The file, sent to ${hostOf(file.server) ?? file.server}`}
          copy={file.path}
        >
          <Visible text={file.path} />
        </Box>
      ))}
      {inspected.keptCredentials.map((entry) => (
        <Box
          key={entry.consent}
          label={`Its kept credentials, for ${entry.context}`}
          copy={entry.server}
        >
          <Visible text={entry.server} />
        </Box>
      ))}
    </Panel>
  )
}

function Panel({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof ShieldAlert
  title: string
  children: ReactNode
}) {
  return (
    <div className="mt-4 rounded-xl border border-warn/30 bg-warn/9 px-3.5 py-3">
      <p className="flex items-center gap-2.5 text-[13px] font-semibold text-ink-1">
        <Icon className="size-4 shrink-0 text-warn-text" />
        {title}
      </p>
      <div className="mt-1 ml-[26px] text-xs leading-relaxed text-ink-2">{children}</div>
    </div>
  )
}

/** A command or path, shown whole, with a way to copy it. */
function Box({ label, copy, children }: { label: string; copy: string; children: ReactNode }) {
  return (
    <div className="group relative mt-2.5 rounded-lg bg-surface px-3 py-2.5 shadow-[inset_0_0_0_1px_var(--line)]">
      <p className="mb-1 text-2xs font-medium tracking-wider text-ink-3 uppercase">{label}</p>
      <code className="block font-mono text-xs leading-relaxed whitespace-normal text-ink-1 selectable">
        {children}
      </code>
      <span className="absolute top-1.5 right-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <CopyButton text={copy} label="Copy" />
      </span>
    </div>
  )
}

/** Added: what it's called, its color and group, and the line for kubectl. */
function Ready({
  context,
  line,
  groups,
  checks,
  inspected,
  names,
  editing,
  onDone,
}: {
  context: string
  line?: string
  groups: string[]
  checks: Record<string, Checked>
  inspected: PastedKubeconfig
  names: Record<string, string>
  editing: boolean
  onDone: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const go = useGo()
  const stored = useSettings().data?.clusters?.[context] ?? {}
  const [name, setName] = useState(stored.name ?? '')
  const [color, setColor] = useState(stored.color)
  const [group, setGroup] = useState(stored.group ?? '')
  const [error, setError] = useState<string>()
  const title = name.trim() || context

  const finish = async (open: boolean) => {
    const result = await api.app.setCluster!(context, {
      ...stored,
      name: name.trim() || undefined,
      color,
      group: group.trim() || undefined,
    })
    // Said, not dropped: its name, color and group weren't kept.
    if (!result.ok) return setError(result.error.message)
    queryClient.setQueryData(['settings'], result.data)
    if (!editing && !open) {
      toast({
        tone: 'success',
        title: `${title} is added`,
        description: 'It’s in Lumovi’s own folder. Your kubeconfig is as it was.',
        action: { label: 'Open', run: () => go(clusterPath(context)) },
      })
    }
    onDone(open)
  }

  return (
    <PageDialog
      leading={
        <DialogIcon tone="good">
          <CircleCheck />
        </DialogIcon>
      }
      title={`${title} is ${editing ? 'saved' : 'ready'}`}
      subtitle="It’s in Lumovi’s own folder. Your kubeconfig stays as it is."
      error={error}
      onSubmit={() => void finish(true)}
      onClose={() => void finish(false)}
      footer={
        <>
          <span className="ml-auto" />
          <Button variant="ghost" onClick={() => void finish(false)}>
            Close
          </Button>
          <Button type="submit" variant="primary">
            Open {title}
          </Button>
        </>
      }
    >
      <Steps stage="done" inspected={inspected} checks={checks} names={names} />
      <div className="mt-5 grid grid-cols-[128px_1fr] items-center gap-x-4 gap-y-3">
        <label htmlFor="added-name" className="text-xs font-medium text-ink-2">
          Name
        </label>
        <input
          id="added-name"
          data-autofocus
          value={name}
          placeholder={context}
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
          className="h-8 w-full rounded-lg border border-line-strong bg-surface px-2.5 text-[13px] text-ink-1 outline-none placeholder:text-ink-3 focus:border-accent focus:ring-3 focus:ring-accent-soft"
        />
        <span className="text-xs font-medium text-ink-2">Color</span>
        <Swatches color={color} onChange={setColor} />
        <label htmlFor="added-group" className="text-xs font-medium text-ink-2">
          Group
        </label>
        <Combo
          id="added-group"
          value={group}
          onChange={setGroup}
          options={groups}
          placeholder="None"
          maxLength={60}
        />
      </div>
      <div className="group relative mt-5 rounded-lg bg-surface-3/70 px-3 py-2.5">
        <p className="mb-1 text-2xs font-medium tracking-wider text-ink-3 uppercase">
          Use it with kubectl
        </p>
        <code className="block font-mono text-xs leading-relaxed text-ink-2 selectable">
          {line ? <PathLine line={line} /> : '…'}
        </code>
        {line && (
          <span className="absolute top-1.5 right-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <CopyButton text={line} label="Copy for kubectl" />
          </span>
        )}
      </div>
    </PageDialog>
  )
}

/** A line of paths, broken only after a slash (its spaces kept, so it isn't broken there). */
function PathLine({ line }: { line: string }) {
  const parts = line.replaceAll(' ', '\u00a0').split('/')
  return parts.map((part, index) => (
    <Fragment key={index}>
      {part}
      {index < parts.length - 1 && (
        <>
          /<wbr />
        </>
      )}
    </Fragment>
  ))
}

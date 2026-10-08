/**
 * Adding a cluster (⌘N, or Add cluster), or editing one added in Lumovi: a kubeconfig pasted, or
 * a file dropped or chosen, then checked (it reads as a kubeconfig, the server answers, the
 * credentials work), then kept in Lumovi's own folder. What its credentials run here, or send,
 * is shown, and nothing is until the person allows it. Done, it's named, colored and grouped, and
 * the line for kubectl given.
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
  TriangleAlert,
} from 'lucide-react'
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import type { ClusterCheck, PastedKubeconfig } from '@shared/api'
import { Button } from '@renderer/components/Button'
import { CodeEditor } from '@renderer/components/CodeEditor'
import { CopyButton } from '@renderer/components/CopyButton'
import { useSettings } from '@renderer/hooks/settings'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { hostOf } from '@renderer/lib/format'
import { DialogIcon, PageDialog } from './PageDialog'
import { Combo, Swatches } from './ClusterSettingsDialog'

/** How Lumovi names the clusters and users in its own files. */
const OWN_NAME = /^lumovi-[0-9a-f]{12}$/

/** The largest kubeconfig read (as the main process reads it). */
const MAX_TEXT = 1024 * 1024

type Stage = 'input' | 'checking' | 'agree' | 'failed' | 'done'

export function AddClusterDialog({
  editing,
  groups,
  onDone,
  onClose,
}: {
  /** One added in Lumovi, its connection edited: its file, and the context it was opened for. */
  editing?: { path: string; context: string }
  groups: string[]
  /** Added (or saved): its first context, and whether to open it. */
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
  const [check, setCheck] = useState<ClusterCheck>()
  const [agreed, setAgreed] = useState<string[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [anyway, setAnyway] = useState(false)
  const [added, setAdded] = useState<{ path: string; line?: string }>()
  const [error, setError] = useState<string>()

  // Editing: its kubeconfig as kept (its secrets as placeholders, which stay as they were).
  useEffect(() => {
    if (!editing) return
    void api.addedClusters!.read(editing.path).then((result) => {
      if (result.ok) setText(result.data)
      else setError(result.error.message)
    })
  }, [editing])

  const first = inspected?.contexts[0]
  const firstName = first ? (names[first.name] ?? first.name) : undefined

  const keep = async (agreedNow: string[]) => {
    setError(undefined)
    if (editing) {
      const result = await api.addedClusters!.edit(editing.path, text, agreedNow)
      if (!result.ok) return void setError(result.error.message)
      setAdded({ path: editing.path })
    } else {
      const renamed = Object.fromEntries(
        Object.entries(names).filter(([name]) => inspected?.conflicts.includes(name)),
      )
      const result = await api.addedClusters!.add(text, { names: renamed, agreed: agreedNow })
      if (!result.ok) return void setError(result.error.message)
      setAdded({ path: result.data.path })
    }
    await queryClient.invalidateQueries({ queryKey: ['contexts'] })
    setStage('done')
  }

  useEffect(() => {
    if (!added || added.line) return
    void api.addedClusters!.forKubectl(added.path).then((result) => {
      if (result.ok) setAdded((now) => now && { ...now, line: result.data })
    })
  }, [added])

  const run = async (agreedNow: string[]) => {
    setStage('checking')
    setError(undefined)
    setCheck(undefined)
    setReadError(undefined)
    const read = await api.addedClusters!.inspect(text, editing?.path)
    if (!read.ok) {
      setReadError(read.error.message)
      setStage('failed')
      return
    }
    setInspected(read.data)
    // A context named as one already read is added under another name (kubectl would take the other).
    setNames((now) =>
      Object.fromEntries(read.data.conflicts.map((name) => [name, now[name] ?? `${name}-2`])),
    )
    const context = read.data.contexts[0]!
    const result = await api.addedClusters!.check(text, context.name, agreedNow, editing?.path)
    if (!result.ok) {
      setReadError(result.error.message)
      setStage('failed')
      return
    }
    setCheck(result.data)
    const { server, credentials } = result.data
    if (!server.ok) return setStage('failed')
    if ('notTried' in credentials && credentials.notTried === 'agreement') return setStage('agree')
    if (!credentials.ok) return setStage('failed')
    await keep(agreedNow)
  }

  const everything = [
    ...(inspected?.commands.map((command) => command.consent) ?? []),
    ...(inspected?.tokenFiles.map((file) => file.consent) ?? []),
  ]
  const needsAgreement = everything.some((consent) => !agreed.includes(consent))

  const allow = () => {
    setAgreed(everything)
    if (anyway) void keep(everything)
    else void run(everything)
  }

  const addAnyway = () => {
    setAnyway(true)
    if (needsAgreement) setStage('agree')
    else void keep(agreed)
  }

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
        return (
          <>
            {check && !check.server.ok && !readError && (
              <Button variant="ghost" className="-ml-2" onClick={addAnyway}>
                Add it anyway
              </Button>
            )}
            <span className="ml-auto" />
            <Button variant="secondary" onClick={() => setStage('input')}>
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

  if (stage === 'done' && added && firstName) {
    return (
      <Ready
        context={firstName}
        line={added.line}
        groups={groups}
        check={check}
        inspected={inspected!}
        editing={!!editing}
        onDone={(open) => onDone(firstName, open)}
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
        else if (stage === 'input' || stage === 'failed') void run(agreed)
      }}
      onClose={onClose}
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
          <Pasted
            from={from}
            inspected={inspected}
            onEdit={() => {
              setStage('input')
              setMode(from ? 'file' : 'paste')
            }}
          />
          <Steps
            stage={stage}
            inspected={inspected}
            readError={readError}
            check={check}
            names={names}
            onName={(name, value) => setNames((now) => ({ ...now, [name]: value }))}
          />
          {stage === 'agree' && inspected && <Agreement inspected={inspected} />}
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
            <span className="mb-1.5 grid size-10 place-items-center rounded-xl bg-surface-3 text-ink-2">
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
  children,
}: {
  state: StepState
  title: string
  detail?: ReactNode
  hint?: ReactNode
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
    <li className="flex animate-fade-in gap-2.5">
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
            'block text-[13px] font-medium',
            state === 'waiting' ? 'text-ink-3' : 'text-ink-1',
          )}
        >
          {title}
        </span>
        {detail && <span className="block truncate font-mono text-xs text-ink-3">{detail}</span>}
        {hint && <span className="mt-0.5 block text-xs text-ink-2">{hint}</span>}
        {children}
      </span>
    </li>
  )
}

/** The check, step by step: it reads, it answers, it signs in. */
function Steps({
  stage,
  inspected,
  readError,
  check,
  names,
  onName,
}: {
  stage: Stage
  inspected?: PastedKubeconfig
  readError?: string
  check?: ClusterCheck
  names: Record<string, string>
  onName: (name: string, value: string) => void
}) {
  const context = inspected?.contexts[0]
  const host = hostOf(context?.server) ?? context?.server
  const reads: StepState = readError && !inspected ? 'failed' : inspected ? 'ok' : 'checking'
  const server: StepState =
    !inspected || reads !== 'ok'
      ? 'waiting'
      : !check
        ? stage === 'checking'
          ? 'checking'
          : 'waiting'
        : check.server.ok
          ? 'ok'
          : 'failed'
  const credentials: StepState =
    !check || !check.server.ok
      ? server === 'ok' && stage === 'checking'
        ? 'checking'
        : 'waiting'
      : check.credentials.ok
        ? 'ok'
        : 'notTried' in check.credentials
          ? 'warn'
          : 'failed'
  return (
    <ol className="space-y-3">
      <Step
        state={reads}
        title="It reads as a kubeconfig"
        detail={
          reads === 'failed'
            ? readError
            : context &&
              // The user's as named in Lumovi's own files (lumovi-…) means nothing to anyone.
              `${context.name}${context.user && !OWN_NAME.test(context.user) ? ` · user ${context.user}` : ''}`
        }
      >
        {inspected?.conflicts.map((name) => (
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
        ))}
      </Step>
      <Step
        state={server}
        title={server === 'failed' ? 'The server didn’t answer' : 'The server answers'}
        detail={
          check && !check.server.ok
            ? check.server.message
            : check?.server.ok
              ? [
                  host,
                  check.server.version,
                  check.server.latencyMs !== undefined && `${check.server.latencyMs} ms`,
                ]
                  .filter(Boolean)
                  .join(' · ')
              : server === 'checking'
                ? `Asking ${host}…`
                : undefined
        }
        hint={
          server === 'failed'
            ? 'Is it on a network you’re not on, like a VPN? Connect to it and try again.'
            : undefined
        }
      >
        {context?.insecure && (
          <Notice>
            Its server isn’t verified (insecure-skip-tls-verify): its credentials go to whoever
            answers.
          </Notice>
        )}
        {context?.proxy && (
          <Notice>
            Everything to it goes through <span className="font-mono">{context.proxy}</span>.
          </Notice>
        )}
      </Step>
      <Step
        state={credentials}
        title={credentials === 'failed' ? 'The credentials didn’t work' : 'The credentials work'}
        detail={
          check?.credentials.ok
            ? `Signed in${context?.user && !OWN_NAME.test(context.user) ? ` as ${context.user}` : ''} · ${check.credentials.allowed ? 'can list namespaces' : 'can’t list namespaces'}`
            : check && 'message' in check.credentials
              ? check.credentials.message
              : credentials === 'warn'
                ? 'Waiting for you'
                : undefined
        }
      />
    </ol>
  )
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <span className="mt-1 flex items-start gap-1.5 text-xs text-warn-text">
      <CircleAlert className="mt-0.5 size-3 shrink-0" />
      <span>{children}</span>
    </span>
  )
}

/** What its credentials would do here, exactly: shown, and allowed or not. */
function Agreement({ inspected }: { inspected: PastedKubeconfig }) {
  const runs = inspected.commands.length > 0
  return (
    <div className="mt-4 rounded-xl border border-warn/30 bg-warn/9 px-3.5 py-3">
      <p className="flex items-center gap-2.5 text-[13px] font-medium text-ink-1">
        <TriangleAlert className="size-4 shrink-0 text-warn-text" />
        {runs
          ? 'Signing in runs a program on this computer'
          : 'Signing in sends a file to its server'}
      </p>
      <p className="mt-1 ml-[26px] text-xs leading-relaxed text-ink-2">
        {runs
          ? 'This kubeconfig gets its credentials from the command below. Lumovi would run it each time it connects, as kubectl does. Allow it only if you trust where the kubeconfig came from.'
          : 'This kubeconfig signs in with the text of the file below, sent to its server each time it connects. Allow it only if you trust where the kubeconfig came from.'}
      </p>
      {inspected.commands.map((command) => {
        const line = [
          ...command.env.map(({ name, value }) => `${name}=${value}`),
          command.line,
        ].join(' ')
        return (
          <Box
            key={command.consent}
            label={command.shell ? 'The command, run in a shell' : 'The command'}
            copy={line}
          >
            {command.env.length > 0 && (
              <span className="text-ink-3">
                {command.env.map(({ name, value }) => `${name}=${value}`).join(' ')}{' '}
              </span>
            )}
            {command.line}
          </Box>
        )
      })}
      {inspected.tokenFiles.map((file) => (
        <Box
          key={file.consent}
          label={`The file, sent to ${hostOf(file.server) ?? file.server}`}
          copy={file.path}
        >
          {file.path}
        </Box>
      ))}
    </div>
  )
}

/** A command or path, shown whole, with a way to copy it. */
function Box({ label, copy, children }: { label: string; copy: string; children: ReactNode }) {
  return (
    <div className="group relative mt-2.5 ml-[26px] rounded-lg bg-surface px-3 py-2.5 shadow-[inset_0_0_0_1px_var(--line)]">
      <p className="mb-1 text-2xs font-medium tracking-wider text-ink-3 uppercase">{label}</p>
      <code className="block font-mono text-xs leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap text-ink-1 selectable">
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
  check,
  inspected,
  editing,
  onDone,
}: {
  context: string
  line?: string
  groups: string[]
  check?: ClusterCheck
  inspected: PastedKubeconfig
  editing: boolean
  onDone: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const stored = useSettings().data?.clusters?.[context] ?? {}
  const [name, setName] = useState(stored.name ?? '')
  const [color, setColor] = useState(stored.color)
  const [group, setGroup] = useState(stored.group ?? '')
  const nameField = useRef<HTMLInputElement>(null)
  const title = name.trim() || context

  const finish = async (open: boolean) => {
    const next = {
      ...stored,
      name: name.trim() || undefined,
      color,
      group: group.trim() || undefined,
    }
    const result = await api.app.setCluster!(context, next)
    if (result.ok) queryClient.setQueryData(['settings'], result.data)
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
      <Steps stage="done" inspected={inspected} check={check} names={{}} onName={() => undefined} />
      <div className="mt-5 grid grid-cols-[128px_1fr] items-center gap-x-4 gap-y-3">
        <label htmlFor="added-name" className="text-xs font-medium text-ink-2">
          Name
        </label>
        <input
          id="added-name"
          ref={nameField}
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
        <code className="block font-mono text-xs leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap text-ink-2 selectable">
          {line ?? '…'}
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

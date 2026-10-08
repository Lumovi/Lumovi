/**
 * Adding a cluster by kubeconfig or token, an admin's, where the server allows it: pasted, then
 * checked (it reads, its server answers, its credentials work and may act as each person), then
 * named, labelled and shared, and kept as a Secret of Lumovi's. A credential plugin is refused,
 * not asked about: the hub runs no programs, so it offers a token or an agent instead.
 */
import { useQueryClient } from '@tanstack/react-query'
import {
  Cable,
  CircleAlert,
  CircleCheck,
  CircleX,
  ClipboardPaste,
  KeyRound,
  Plus,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import {
  clusterNameError,
  groupError,
  type FleetAddSource,
  type FleetCheck,
  type FleetChecked,
} from '@shared/fleet'
import { Button } from '@renderer/components/Button'
import { CodeEditor } from '@renderer/components/CodeEditor'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { toast } from '@renderer/state/toasts'
import { DialogIcon, PageDialog } from '../welcome/PageDialog'
import { ChipsField, labelError, labelMap, lastOfEachKey } from './ChipsField'
import { AuditNote } from './ConnectDialog'

const field =
  'h-8 w-full min-w-0 rounded-lg border border-line-strong bg-surface px-2.5 text-[13px] text-ink-1 outline-none focus:border-accent focus:ring-3 focus:ring-accent-soft'

export type AddKind = 'kubeconfig' | 'token'

export function AddClusterDialog({
  kind: first,
  onConnect,
  onClose,
}: {
  kind: AddKind
  /** Connecting it with an agent instead. */
  onConnect: () => void
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [kind, setKind] = useState<AddKind>(first)
  const [kubeconfig, setKubeconfig] = useState('')
  const [server, setServer] = useState('')
  const [token, setToken] = useState('')
  const [ca, setCa] = useState('')
  const [checked, setChecked] = useState<FleetChecked>()
  const [name, setName] = useState('')
  const [labels, setLabels] = useState<string[]>([])
  const [groups, setGroups] = useState<string[]>([])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const source: FleetAddSource = kind === 'kubeconfig' ? { kubeconfig } : { server, token, ca }
  const given = kind === 'kubeconfig' ? kubeconfig.trim() !== '' : Boolean(server && token && ca)
  const plugin = checked?.checks.some((check) => check.plugin)
  const nameProblem = name === '' ? undefined : clusterNameError(name)

  const check = async () => {
    setPending(true)
    setError(undefined)
    try {
      const result = await api.fleet!.check(source)
      setChecked(result)
      setName(result.name ?? '')
    } catch (failed) {
      setError((failed as Error).message)
    } finally {
      setPending(false)
    }
  }
  const add = async () => {
    setPending(true)
    setError(undefined)
    try {
      await api.fleet!.add({ name, labels: labelMap(labels), groups, source })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['contexts'] }),
        queryClient.invalidateQueries({ queryKey: ['fleet-joins'] }),
      ])
      toast({ tone: 'success', title: `Added ${name} to the fleet` })
      onClose()
    } catch (failed) {
      setError((failed as Error).message)
      setPending(false)
    }
  }
  const again = (to?: AddKind) => {
    setChecked(undefined)
    setError(undefined)
    if (to) setKind(to)
  }

  const footer = !checked ? (
    <>
      <AuditNote />
      <Button variant="ghost" onClick={onClose}>
        Cancel
      </Button>
      <Button variant="primary" type="submit" disabled={!given || pending}>
        Check it
      </Button>
    </>
  ) : plugin ? (
    <>
      <Button variant="ghost" className="mr-auto" onClick={onClose}>
        Cancel
      </Button>
      <Button variant="secondary" onClick={() => again('token')}>
        <KeyRound /> Use a token
      </Button>
      <Button variant="primary" onClick={onConnect}>
        <Cable /> Connect with an agent
      </Button>
    </>
  ) : (
    <>
      <AuditNote />
      <Button variant="ghost" onClick={onClose}>
        Cancel
      </Button>
      <Button
        variant="primary"
        type="submit"
        disabled={!checked.passed || !name || Boolean(nameProblem) || pending}
      >
        Add to the fleet
      </Button>
    </>
  )
  return (
    <PageDialog
      leading={
        <DialogIcon>
          <Plus />
        </DialogIcon>
      }
      title="Add a cluster"
      subtitle="Lumovi keeps it as a Secret in its namespace, labelled lumovi.dev/cluster."
      top="top-[8vh]"
      error={error}
      onSubmit={() => void (!checked ? check() : checked.passed && add())}
      onClose={onClose}
      footer={footer}
    >
      {!checked ? (
        <div className="flex flex-col gap-3.5">
          <div
            role="group"
            aria-label="Add it by"
            className="flex gap-0.5 self-start rounded-lg bg-surface-3 p-0.5"
          >
            {(
              [
                ['kubeconfig', 'A kubeconfig', ClipboardPaste],
                ['token', 'A token', KeyRound],
              ] as const
            ).map(([value, label, Icon]) => (
              <button
                key={value}
                type="button"
                aria-pressed={kind === value}
                onClick={() => setKind(value)}
                className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-ink-2 aria-pressed:bg-surface aria-pressed:text-ink-1 aria-pressed:shadow-xs [&_svg]:size-3.5"
              >
                <Icon /> {label}
              </button>
            ))}
          </div>
          {kind === 'kubeconfig' ? (
            <>
              <div className="h-56 overflow-hidden rounded-lg border border-line-strong bg-surface focus-within:border-accent focus-within:ring-3 focus-within:ring-accent-soft">
                <CodeEditor
                  value={kubeconfig}
                  onChange={setKubeconfig}
                  onSave={() => given && void check()}
                  label="Its kubeconfig"
                />
              </div>
              <p className="text-xs text-ink-3">
                One context, with a token or a client certificate. Credential plugins can’t run on
                this server.
              </p>
            </>
          ) : (
            <div className="grid grid-cols-[128px_1fr] gap-x-4 gap-y-3">
              <FieldLabel htmlFor="add-server">Server</FieldLabel>
              <input
                id="add-server"
                value={server}
                placeholder="https://10.0.0.1:6443"
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => setServer(event.target.value)}
                className={cn(field, 'font-mono text-xs')}
              />
              <FieldLabel htmlFor="add-token">Token</FieldLabel>
              <input
                id="add-token"
                type="password"
                value={token}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => setToken(event.target.value)}
                className={cn(field, 'font-mono text-xs')}
              />
              <FieldLabel htmlFor="add-ca">Its CA</FieldLabel>
              <div className="min-w-0">
                <textarea
                  id="add-ca"
                  value={ca}
                  rows={3}
                  placeholder="-----BEGIN CERTIFICATE-----"
                  spellCheck={false}
                  onChange={(event) => setCa(event.target.value)}
                  className={cn(field, 'h-auto py-1.5 font-mono text-xs')}
                />
                <p className="mt-1.5 text-xs text-ink-3">
                  The certificate authority its server presents, as PEM. Lumovi checks the server
                  against it.
                </p>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2.5 rounded-lg bg-surface-3 px-3 py-2 text-xs text-ink-2">
            {kind === 'kubeconfig' ? (
              <ClipboardPaste className="size-3.5" aria-hidden />
            ) : (
              <KeyRound className="size-3.5" aria-hidden />
            )}
            <span className="min-w-0 truncate">
              {kind === 'kubeconfig' ? 'Pasted, a kubeconfig' : 'A server, a token and its CA'}
            </span>
            <button
              type="button"
              onClick={() => again()}
              className="ml-auto font-medium text-accent-strong hover:underline"
            >
              Edit
            </button>
          </div>
          <ul aria-label="Checks" className="flex flex-col gap-2.5">
            {checked.checks.map((item) => (
              <Check key={item.title} check={item} />
            ))}
          </ul>
          {checked.passed && (
            <div className="grid grid-cols-[128px_1fr] gap-x-4 gap-y-3.5">
              <FieldLabel htmlFor="add-name">Name</FieldLabel>
              <div className="min-w-0">
                <input
                  id="add-name"
                  data-autofocus
                  value={name}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={Boolean(nameProblem) || undefined}
                  onChange={(event) => setName(event.target.value)}
                  className={cn(field, 'font-mono', nameProblem && 'border-critical')}
                />
                {nameProblem && <p className="mt-1.5 text-xs text-critical-text">{nameProblem}.</p>}
              </div>
              <FieldLabel htmlFor="add-labels">Labels</FieldLabel>
              <ChipsField
                id="add-labels"
                label="label"
                values={labels}
                locked={false}
                placeholder={labels.length ? 'Add a label…' : 'Add a label, as env=production…'}
                check={labelError}
                onChange={(values) => setLabels(lastOfEachKey(values))}
                mono
              />
              <FieldLabel htmlFor="add-groups">Groups</FieldLabel>
              <div className="min-w-0">
                <ChipsField
                  id="add-groups"
                  label="group"
                  values={groups}
                  locked={false}
                  placeholder="Add a group…"
                  check={groupError}
                  onChange={(values) => setGroups([...new Set(values)])}
                />
                <p className="mt-1.5 text-xs text-ink-3">
                  {groups.length
                    ? 'Who sees it, besides admins.'
                    : 'Who sees it, besides admins: with none, everyone signed in.'}
                </p>
              </div>
            </div>
          )}
        </div>
      )}
    </PageDialog>
  )
}

/** A check: passed, failed, or passed with something to know; what was found, what to do. */
function Check({ check }: { check: FleetCheck }) {
  const Icon = check.result === 'ok' ? CircleCheck : check.result === 'bad' ? CircleX : CircleAlert
  return (
    <li className="flex gap-2.5">
      <Icon
        aria-label={{ ok: 'Passed', bad: 'Failed', warn: 'Take note' }[check.result]}
        className={cn(
          'mt-0.5 size-4 shrink-0',
          check.result === 'ok'
            ? 'text-good-text'
            : check.result === 'bad'
              ? 'text-critical-text'
              : 'text-warn-text',
        )}
      />
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-ink-1">{check.title}</p>
        {check.detail && (
          <p className="truncate font-mono text-xs text-ink-3" title={check.detail}>
            {check.detail}
          </p>
        )}
        {check.hint && <p className="mt-0.5 text-xs text-ink-2">{check.hint}</p>}
      </div>
    </li>
  )
}

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="self-start pt-2 text-xs font-medium text-ink-2">
      {children}
    </label>
  )
}

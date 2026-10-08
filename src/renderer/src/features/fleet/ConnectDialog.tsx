/**
 * Connecting a private cluster, an admin's: what the fleet calls it, its labels and who sees it;
 * then one command, run with their own access to the cluster, which installs its agent with a
 * one-time join token; then, once it's connected, checking its certificate authority. The agent
 * dials this server, so the cluster opens no port, and nobody pastes its credentials here.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Cable, CircleCheck, ScrollText, ShieldCheck } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { clusterNameError, groupError, type FleetJoin, type FleetJoinRequest } from '@shared/fleet'
import { Button } from '@renderer/components/Button'
import { CopyButton } from '@renderer/components/CopyButton'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { toast } from '@renderer/state/toasts'
import { DialogIcon, PageDialog } from '../welcome/PageDialog'
import { ChipsField, labelError, labelMap, lastOfEachKey } from './ChipsField'

/** On the cluster an agent runs in: its certificate authority's SHA-256, to compare. */
export const FINGERPRINT_COMMAND =
  "kubectl get configmap kube-root-ca.crt -n default -o jsonpath='{.data.ca\\.crt}' | openssl x509 -noout -fingerprint -sha256"

const field =
  'h-8 w-full min-w-0 rounded-lg border border-line-strong bg-surface px-2.5 text-[13px] text-ink-1 outline-none focus:border-accent focus:ring-3 focus:ring-accent-soft'

/** This server's address, as the agent dials it: as this page reached it. */
const hubUrl = () => new URL('.', document.baseURI).href.replace(/\/$/, '')

/**
 * The command that installs a cluster's agent, in bash or zsh: it asks for the join token first
 * (not shown, nor kept in the shell's history), gives it to Helm on its standard input, and
 * forgets it after.
 */
export function agentCommand(name: string, version?: string): string {
  return [
    'read -rs LUMOVI_JOIN_TOKEN',
    'printf %s "$LUMOVI_JOIN_TOKEN" | helm install lumovi oci://ghcr.io/lumovi/charts/lumovi \\',
    ...(version ? [`  --version ${version} \\`] : []),
    '  --namespace lumovi --create-namespace \\',
    `  --set mode=agent --set clusterName=${name} \\`,
    `  --set agent.hubUrl=${hubUrl()} \\`,
    '  --set-file agent.joinToken=/dev/stdin',
    'unset LUMOVI_JOIN_TOKEN',
  ].join('\n')
}

/** A time, as people read it here. */
const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

/** What's left until `iso`, as mm:ss (none once it's past). */
function useLeft(iso: string | undefined): string | undefined {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  if (!iso) return undefined
  const left = Math.ceil((Date.parse(iso) - now) / 1000)
  if (left <= 0) return undefined
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
}

/**
 * Connecting a cluster: its form, or (`showing`, from its waiting card) its command, without the
 * token, which was shown once.
 */
export function ConnectDialog({ showing, onClose }: { showing?: FleetJoin; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [request, setRequest] = useState<FleetJoinRequest | undefined>(showing)
  const [token, setToken] = useState<string>()
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState(false)
  const create = async (wanted: FleetJoinRequest) => {
    setPending(true)
    setError(undefined)
    try {
      const made = await api.fleet!.connect(wanted)
      setRequest(wanted)
      setToken(made.token)
      await queryClient.invalidateQueries({ queryKey: ['fleet-joins'] })
    } catch (failed) {
      setError((failed as Error).message)
    } finally {
      setPending(false)
    }
  }
  return !request || (!token && !showing) ? (
    <ConnectForm pending={pending} error={error} onCreate={create} onClose={onClose} />
  ) : (
    <Waiting
      request={request}
      token={token}
      error={error}
      pending={pending}
      onAgain={() => void create(request)}
      onClose={onClose}
    />
  )
}

function ConnectForm({
  pending,
  error,
  onCreate,
  onClose,
}: {
  pending: boolean
  error?: string
  onCreate: (request: FleetJoinRequest) => void
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [labels, setLabels] = useState<string[]>([])
  const [groups, setGroups] = useState<string[]>([])
  const nameProblem = name === '' ? undefined : clusterNameError(name)
  const ready = name !== '' && !nameProblem && !pending
  return (
    <PageDialog
      leading={
        <DialogIcon>
          <Cable />
        </DialogIcon>
      }
      title="Connect a cluster"
      subtitle="Its agent dials this server: the cluster opens no port."
      top="top-[7vh]"
      error={error}
      onSubmit={() => ready && onCreate({ name, labels: labelMap(labels), groups })}
      onClose={onClose}
      footer={
        <>
          <AuditNote />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={!ready}>
            Create the command
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-[128px_1fr] gap-x-4 gap-y-3.5">
        <FieldLabel htmlFor="connect-name">Name</FieldLabel>
        <div className="min-w-0">
          <input
            id="connect-name"
            value={name}
            placeholder="edge-ap-south"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={Boolean(nameProblem) || undefined}
            onChange={(event) => setName(event.target.value)}
            className={cn(field, 'font-mono', nameProblem && 'border-critical')}
          />
          <p className={cn('mt-1.5 text-xs', nameProblem ? 'text-critical-text' : 'text-ink-3')}>
            {nameProblem ? `${nameProblem}.` : 'What the fleet calls it, and its agent joins as.'}
          </p>
        </div>
        <FieldLabel htmlFor="connect-labels">Labels</FieldLabel>
        <ChipsField
          id="connect-labels"
          label="label"
          values={labels}
          locked={false}
          placeholder={labels.length ? 'Add a label…' : 'Add a label, as env=production…'}
          check={labelError}
          onChange={(values) => setLabels(lastOfEachKey(values))}
          mono
        />
        <FieldLabel htmlFor="connect-groups">Groups</FieldLabel>
        <div className="min-w-0">
          <ChipsField
            id="connect-groups"
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
    </PageDialog>
  )
}

/**
 * Its command, and its join token (once); then waiting until its agent connects, with a timer;
 * then checking its certificate authority. An expired or used command says so, and offers a new
 * one.
 */
function Waiting({
  request,
  token,
  error,
  pending,
  onAgain,
  onClose,
}: {
  request: FleetJoinRequest
  token?: string
  error?: string
  pending: boolean
  onAgain: () => void
  onClose: () => void
}) {
  const { name } = request
  const version = useQuery({ queryKey: ['app-info'], queryFn: () => api.app.info() }).data?.version
  const joins = useQuery({
    queryKey: ['fleet-joins'],
    queryFn: () => api.fleet!.joins(),
    refetchInterval: 2000,
  })
  const join = joins.data?.joins.find((j) => j.name === name)
  const left = useLeft(join?.until)
  const connected = Boolean(join?.used)
  const queryClient = useQueryClient()
  // Connected: its card lands on the page at once.
  useEffect(() => {
    if (connected) void queryClient.invalidateQueries({ queryKey: ['contexts'] })
  }, [connected, queryClient])
  return (
    <PageDialog
      leading={
        <DialogIcon tone={connected ? 'good' : undefined}>
          {connected ? <CircleCheck /> : <Cable />}
        </DialogIcon>
      }
      title={connected ? `${name} is connected` : `Connect ${name}`}
      subtitle={
        connected
          ? 'Its agent dials this server, and relays to its API server.'
          : 'Run this where you reach the cluster, with your own access to it.'
      }
      top="top-[7vh]"
      error={error}
      onClose={onClose}
      footer={
        <>
          <AuditNote />
          <Button variant={connected ? 'ghost' : 'secondary'} onClick={onClose}>
            {connected ? 'Later' : 'Leave it waiting'}
          </Button>
        </>
      }
    >
      {connected ? (
        <>
          {join?.refused && join.refused > join.used! && (
            <p className="mb-3 text-[13px] text-ink-2">
              An agent tried its join token again at {timeOf(join.refused)}, and was refused.
            </p>
          )}
          <CheckCa name={name} onDone={onClose} />
        </>
      ) : (
        <div className="flex flex-col gap-3.5">
          {token ? (
            <Box label="Its join token" copy={token} copyLabel="Copy its join token">
              <code className="block font-mono text-xs break-all text-ink-1 selectable">
                {token}
              </code>
              <p className="mt-1.5 text-xs text-ink-3">
                Works once{join ? `, until ${timeOf(join.until)},` : ''} and isn’t shown again. The
                command asks for it: paste it there.
              </p>
            </Box>
          ) : (
            <p className="text-[13px] leading-relaxed text-ink-2">
              Its join token was shown when the command was made, and isn’t shown again. Lost it?
              Create a new command: the one before stops working.
            </p>
          )}
          <Box
            label={`In ${name}, with bash or zsh`}
            copy={agentCommand(name, version)}
            copyLabel="Copy the command"
          >
            <code className="block font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink-2 selectable">
              {agentCommand(name, version)}
            </code>
          </Box>
          {left ? (
            <>
              <div
                role="status"
                className="flex items-center gap-2.5 rounded-[10px] border border-line px-3 py-2.5 text-[13px]"
              >
                <span className="size-2 rounded-full bg-neutral ring-4 ring-neutral/12" />
                <span className="text-ink-1">Waiting for {name} to connect…</span>
                <span className="ml-auto font-mono text-xs text-ink-3">{left}</span>
              </div>
              <p className="text-xs text-ink-3">
                The first agent to use its token is the one trusted: only admins see the cluster
                until its certificate authority is checked, once it’s connected.
              </p>
            </>
          ) : (
            join && (
              <div
                role="status"
                className="flex items-center gap-2.5 rounded-[10px] border border-line px-3 py-2.5 text-[13px]"
              >
                <span className="text-ink-1">This command expired at {timeOf(join.until)}.</span>
                <Button
                  variant="secondary"
                  className="ml-auto h-7 text-xs"
                  disabled={pending}
                  onClick={onAgain}
                >
                  Create a new command
                </Button>
              </div>
            )
          )}
          {left && !token && (
            <Button variant="secondary" className="self-start" onClick={onAgain}>
              Create a new command
            </Button>
          )}
        </div>
      )}
    </PageDialog>
  )
}

/** The last step: checking its certificate authority, from the cluster itself. */
function CheckCa({ name, onDone }: { name: string; onDone: () => void }) {
  const queryClient = useQueryClient()
  const [given, setGiven] = useState('')
  const [problem, setProblem] = useState<string>()
  const [pending, setPending] = useState(false)
  const trust = async () => {
    setPending(true)
    setProblem(undefined)
    try {
      await api.fleet!.trustAgent(name, given)
      // Checked, it's shown to those it's shared with.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['fleet-agents'] }),
        queryClient.invalidateQueries({ queryKey: ['contexts'] }),
      ])
      toast({ tone: 'success', title: `Trusted ${name}’s agent` })
      onDone()
    } catch (failed) {
      setProblem((failed as Error).message)
      setPending(false)
    }
  }
  return (
    <section className="rounded-xl border border-line bg-surface px-3.5 py-3">
      <div className="flex items-start gap-2.5">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent-strong" aria-hidden />
        <div className="min-w-0 text-[13px]">
          <p className="font-medium text-ink-1">Check its certificate authority</p>
          <p className="mt-0.5 text-ink-2">
            This server trusts the one its agent first sent. Run this with your own access to {name}
            , not through Lumovi, and paste what it prints:
          </p>
        </div>
      </div>
      <div className="mt-2.5 ml-[26px]">
        <Box label={`In ${name}`} copy={FINGERPRINT_COMMAND} copyLabel="Copy the command">
          <code className="block font-mono text-xs leading-relaxed break-all text-ink-2 selectable">
            {FINGERPRINT_COMMAND}
          </code>
        </Box>
      </div>
      <div className="mt-2.5 ml-[26px] flex gap-2">
        <input
          aria-label={`${name}’s certificate authority’s SHA-256`}
          value={given}
          placeholder="sha256 Fingerprint=…"
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setGiven(event.target.value)}
          className={cn(field, 'font-mono text-xs')}
        />
        <Button
          variant="primary"
          className="h-8 shrink-0"
          disabled={!given.trim() || pending}
          onClick={() => void trust()}
        >
          Trust it
        </Button>
      </div>
      {problem && (
        <p role="alert" className="mt-2 ml-[26px] text-xs text-critical-text">
          {problem}
        </p>
      )}
    </section>
  )
}

/** A box to copy from, labelled as the Equivalent command box is. */
function Box({
  label,
  copy,
  copyLabel,
  children,
}: {
  label: string
  copy: string
  copyLabel: string
  children: ReactNode
}) {
  return (
    <div className="group relative rounded-lg bg-surface-3/70 px-3 py-2.5">
      <p className="mb-1 text-2xs font-medium tracking-wider text-ink-3 uppercase">{label}</p>
      {children}
      <span className="absolute top-1.5 right-1.5">
        <CopyButton text={copy} label={copyLabel} />
      </span>
    </div>
  )
}

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="self-start pt-2 text-xs font-medium text-ink-2">
      {children}
    </label>
  )
}

/** Every change here is an admin's, and recorded. */
export function AuditNote() {
  return (
    <span className="mr-auto flex items-center gap-1.5 text-xs text-ink-3">
      <ScrollText className="size-3.5" aria-hidden />
      Recorded in the audit log
    </span>
  )
}

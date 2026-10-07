/**
 * The desktop app's AI assistants: turning them on, where they connect, how
 * to set each one up, and which are connected now (the AI assistants page's
 * Connect tab).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CircleAlert,
  CircleCheck,
  Eye,
  LoaderCircle,
  Lock,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import type { LumoviApi } from '@shared/api'
import { isPort, type AssistantClient, type AssistantsStatus } from '@shared/assistants'
import { Button, IconButton } from '@renderer/components/Button'
import { CopyButton } from '@renderer/components/CopyButton'
import { Switch } from '@renderer/components/Switch'
import { TabContent, TabList, Tabs } from '@renderer/components/Tabs'
import { cn } from '@renderer/lib/cn'
import { useSettings } from '@renderer/hooks/settings'
import { Card } from './PageParts'

type AssistantsApi = NonNullable<LumoviApi['assistants']>

/** Whether assistants can connect, and which have: kept up to date by the app. */
export function useAssistantsStatus(assistants: AssistantsApi): AssistantsStatus | undefined {
  const queryClient = useQueryClient()
  useEffect(
    () => assistants.onStatus((status) => queryClient.setQueryData(['assistants'], status)),
    [assistants, queryClient],
  )
  return useQuery({ queryKey: ['assistants'], queryFn: () => assistants.status() }).data
}

/** Opens the AI assistants page; a dot says one's connected. */
export function AssistantsButton({ assistants }: { assistants: AssistantsApi }) {
  const status = useAssistantsStatus(assistants)
  const navigate = useNavigate()
  const connected = status?.clients.length ?? 0
  return (
    <IconButton
      label={connected ? `AI assistants (${connected} connected)` : 'AI assistants'}
      className="relative"
      onClick={() => void navigate('/assistants')}
    >
      <Sparkles />
      {connected > 0 && (
        <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-good ring-2 ring-surface" />
      )}
    </IconButton>
  )
}

/** Turning assistants on, and connecting them. */
export function DesktopConnectTab({ assistants }: { assistants: AssistantsApi }) {
  const queryClient = useQueryClient()
  const status = useAssistantsStatus(assistants)
  // Turned off by the organization's policy: they can't be turned on here.
  const managedOff = useSettings().data?.managed?.assistantsOff === true
  const [busy, setBusy] = useState(false)
  if (!status) return null
  const configure = async (change: { enabled?: boolean; port?: number }) => {
    setBusy(true)
    queryClient.setQueryData(['assistants'], await assistants.configure(change))
    setBusy(false)
  }
  return (
    <Card>
      <header className="flex items-start gap-3 px-5 pt-5 pb-4">
        <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-strong">
          <Sparkles className="size-[18px]" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] leading-snug font-semibold text-ink-1">On this computer</h2>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-3">
            AI assistants read your clusters through Lumovi, and ask you before they change
            anything.
          </p>
        </div>
        <span className="mt-2 flex items-center gap-2 text-xs text-ink-2">
          {busy && <LoaderCircle className="size-3.5 animate-spin text-ink-3" />}
          <Switch
            label="Let AI assistants connect"
            checked={status.enabled}
            disabled={busy || managedOff}
            onCheckedChange={(enabled) => void configure({ enabled })}
          />
        </span>
      </header>
      <div className="border-t border-line">
        {status.enabled ? (
          <On
            status={status}
            assistants={assistants}
            busy={busy}
            configure={(change) => void configure(change)}
          />
        ) : (
          <Off
            busy={busy}
            managedOff={managedOff}
            onTurnOn={() => void configure({ enabled: true })}
          />
        )}
      </div>
    </Card>
  )
}

function Off({
  busy,
  managedOff,
  onTurnOn,
}: {
  busy: boolean
  managedOff: boolean
  onTurnOn: () => void
}) {
  const points: [LucideIcon, string, string][] = [
    [
      Eye,
      'They read',
      'Clusters’ objects, events and logs, and what’s failing, as your AI permissions say.',
    ],
    [
      ShieldCheck,
      'They ask',
      'Each change shows here, with the diff it makes, for you to approve or reject.',
    ],
    [
      Lock,
      'Only on this computer',
      'With a token of its own. Read-only clusters, and your own access (RBAC), always apply.',
    ],
  ]
  return (
    <div className="px-5 py-5">
      <ul className="space-y-3.5">
        {points.map(([Icon, title, text]) => (
          <li key={title} className="flex gap-3">
            <Icon className="mt-0.5 size-4 shrink-0 text-ink-3" />
            <p className="text-[13px] leading-relaxed text-ink-2">
              <span className="font-medium text-ink-1">{title}:</span> {text}
            </p>
          </li>
        ))}
      </ul>
      {managedOff ? (
        <p className="mt-5 flex items-center gap-2 text-[13px] text-ink-2">
          <Lock className="size-4 shrink-0 text-ink-3" />
          Your organization’s policy turns AI assistants off on this computer.
        </p>
      ) : (
        <Button variant="primary" className="mt-5" disabled={busy} onClick={onTurnOn}>
          {busy && <LoaderCircle className="animate-spin" />}
          Turn on
        </Button>
      )}
    </div>
  )
}

function On({
  status,
  assistants,
  busy,
  configure,
}: {
  status: AssistantsStatus
  assistants: AssistantsApi
  busy: boolean
  configure: (change: { port?: number }) => void
}) {
  return (
    <>
      {/* Its own again, for the port that's used now. */}
      <Endpoint key={status.port} status={status} busy={busy} configure={configure} />
      {status.url && <Connect status={status} url={status.url} assistants={assistants} />}
      <Connected status={status} />
      <NewToken assistants={assistants} />
    </>
  )
}

/** Where assistants connect, or why they can't. */
function Endpoint({
  status,
  busy,
  configure,
}: {
  status: AssistantsStatus
  busy: boolean
  configure: (change: { port?: number }) => void
}) {
  const [port, setPort] = useState(String(status.port))
  const chosen = Number(port)
  const changed = chosen !== status.port
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (isPort(chosen) && changed) configure({ port: chosen })
      }}
      className="flex items-center gap-3 px-5 py-3"
    >
      <span
        aria-hidden
        className={cn('size-2 shrink-0 rounded-full', status.url ? 'bg-good' : 'bg-critical')}
      />
      <p
        role={status.error ? 'alert' : undefined}
        className={cn(
          'min-w-0 flex-1 text-[13px]',
          status.error ? 'text-critical-text' : 'text-ink-2',
        )}
      >
        {status.url ? (
          <>
            Listening at{' '}
            <code className="font-mono text-xs text-ink-1 selectable">{status.url}</code>
          </>
        ) : (
          status.error
        )}
      </p>
      <label className="flex shrink-0 items-center gap-1.5 text-xs text-ink-3">
        Port
        <input
          aria-label="Port"
          inputMode="numeric"
          value={port}
          onChange={(event) => setPort(event.target.value.replace(/\D/g, ''))}
          className={cn(
            'h-7 w-16 rounded-md border bg-surface px-2 font-mono text-xs text-ink-1 outline-none focus:ring-3 focus:ring-accent-soft',
            changed && !isPort(chosen)
              ? 'border-critical focus:border-critical'
              : 'border-line-strong focus:border-accent',
          )}
        />
      </label>
      {changed && (
        <Button type="submit" className="h-7 px-2.5 text-xs" disabled={busy || !isPort(chosen)}>
          Use
        </Button>
      )}
    </form>
  )
}

const TABS: { value: AssistantClient | 'codex' | 'other'; label: string }[] = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'claude-desktop', label: 'Claude Desktop' },
  { value: 'codex', label: 'Codex' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'vscode', label: 'VS Code' },
  { value: 'other', label: 'Other' },
]

/** How to connect each assistant: a click where Lumovi can set it up, what to paste where not. */
function Connect({
  status,
  url,
  assistants,
}: {
  status: AssistantsStatus
  url: string
  assistants: AssistantsApi
}) {
  const token = status.token!
  const header = `Authorization: Bearer ${token}`
  // The token is shown in part: copying gives all of it.
  const masked = (text: string) => text.replace(token, `${token.slice(0, 4)}…`)
  const claudeCode = `claude mcp add --transport http --scope user lumovi ${url} --header "${header}"`
  const json = JSON.stringify(
    { mcpServers: { lumovi: { url, headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2,
  )
  const codex = [
    '[mcp_servers.lumovi]',
    `url = "${url}"`,
    `http_headers = { Authorization = "Bearer ${token}" }`,
  ].join('\n')
  const installable = (client: AssistantClient) => status.installable.includes(client)
  return (
    <section aria-label="Connect an assistant" className="border-t border-line pt-3">
      <h3 className="mb-1 px-5 text-2xs font-medium tracking-wider text-ink-3 uppercase">
        Connect an assistant
      </h3>
      <Tabs defaultValue="claude-code">
        <TabList tabs={TABS} />
        <div className="px-5 py-4 text-[13px] leading-relaxed text-ink-2">
          <TabContent value="claude-code" className="space-y-2.5">
            <p>Run this once, in a terminal:</p>
            <Snippet
              text={claudeCode}
              shown={masked(claudeCode)}
              label="Command"
              copy="Copy command"
            />
            <p className="text-xs text-ink-3">
              Then let Claude Code use Lumovi’s tools without asking: Lumovi asks you before any
              change.
            </p>
          </TabContent>
          <TabContent value="claude-desktop" className="space-y-2.5">
            {installable('claude-desktop') ? (
              <>
                <Install assistants={assistants} client="claude-desktop">
                  Add to Claude Desktop
                </Install>
                <p className="text-xs text-ink-3">
                  Claude Desktop starts Lumovi to talk to it, if it isn’t open. Quit Claude Desktop
                  and open it again once it’s added.
                </p>
              </>
            ) : (
              <p>
                Claude Desktop isn’t made for Linux. Other assistants connect as shown under Other.
              </p>
            )}
          </TabContent>
          <TabContent value="codex" className="space-y-2.5">
            <p>
              Add this to <code className="font-mono">~/.codex/config.toml</code>:
            </p>
            <Snippet
              text={codex}
              shown={masked(codex)}
              label="Codex settings"
              copy="Copy Codex’s settings"
            />
            <p className="text-xs text-ink-3">
              Codex connects to Lumovi as each of its sessions starts.
            </p>
          </TabContent>
          <TabContent value="cursor" className="space-y-2.5">
            <Install assistants={assistants} client="cursor">
              Add to Cursor
            </Install>
            <p className="text-xs text-ink-3">
              Cursor asks you to confirm. Or add this to{' '}
              <code className="font-mono">~/.cursor/mcp.json</code>:
            </p>
            <Snippet
              text={json}
              shown={masked(json)}
              label="Cursor settings"
              copy="Copy Cursor’s settings"
            />
          </TabContent>
          <TabContent value="vscode" className="space-y-2.5">
            <Install assistants={assistants} client="vscode">
              Add to VS Code
            </Install>
            <p className="text-xs text-ink-3">
              VS Code asks you to confirm, then shows Lumovi among its MCP servers.
            </p>
          </TabContent>
          <TabContent value="other" className="space-y-2.5">
            <p>
              Assistants that connect to MCP servers over HTTP use this address, with this header:
            </p>
            <Snippet text={url} label="Address" copy="Copy address" />
            <Snippet text={header} shown={masked(header)} label="Header" copy="Copy header" />
          </TabContent>
        </div>
      </Tabs>
    </section>
  )
}

/** Text to copy: shown as given (the token in part), copied whole. */
export function Snippet({
  text,
  shown = text,
  label,
  copy,
}: {
  text: string
  shown?: string
  label: string
  /** Its copy button's name: "Copy command". */
  copy: string
}) {
  return (
    <div className="group relative rounded-lg bg-surface-3/70 py-2 pr-10 pl-3">
      <code
        aria-label={label}
        className="block font-mono text-xs leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap text-ink-1 selectable"
      >
        {shown}
      </code>
      <span className="absolute top-1 right-1">
        <CopyButton text={text} label={copy} />
      </span>
    </div>
  )
}

/** Sets an assistant up, and says how it went. */
function Install({
  assistants,
  client,
  children,
}: {
  assistants: AssistantsApi
  client: Exclude<AssistantClient, 'claude-code'>
  children: ReactNode
}) {
  const [state, setState] = useState<'busy' | { ok: boolean; message: string }>()
  const install = async () => {
    setState('busy')
    const result = await assistants.install(client)
    setState(
      result.ok ? { ok: true, message: result.data } : { ok: false, message: result.error.message },
    )
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="primary" disabled={state === 'busy'} onClick={() => void install()}>
        {state === 'busy' && <LoaderCircle className="animate-spin" />}
        {children}
      </Button>
      {state && state !== 'busy' && (
        <p
          role={state.ok ? 'status' : 'alert'}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 text-xs',
            state.ok ? 'text-good-text' : 'text-critical-text',
          )}
        >
          {state.ok ? (
            <CircleCheck className="size-3.5 shrink-0" />
          ) : (
            <CircleAlert className="size-3.5 shrink-0" />
          )}
          <span className="selectable">{state.message}</span>
        </p>
      )}
    </div>
  )
}

/** The assistants connected now; each window of one, once. */
function Connected({ status }: { status: AssistantsStatus }) {
  const byName = new Map<string, number>()
  for (const { name } of status.clients) byName.set(name, (byName.get(name) ?? 0) + 1)
  return (
    <section aria-label="Connected now" className="border-t border-line px-5 py-4">
      <h3 className="mb-2 text-2xs font-medium tracking-wider text-ink-3 uppercase">
        Connected now
      </h3>
      {byName.size === 0 ? (
        <p className="text-[13px] text-ink-3">None yet: assistants show here once they connect.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {[...byName].map(([name, count]) => (
            <li
              key={name}
              className="flex items-center gap-2 rounded-full border border-line py-1 pr-3 pl-2.5 text-[13px] text-ink-1"
            >
              <span aria-hidden className="size-1.5 rounded-full bg-good" />
              {name}
              {count > 1 && <span className="text-xs text-ink-3">×{count}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** A new token: the one assistants have stops working (a copy got out, say). */
function NewToken({ assistants }: { assistants: AssistantsApi }) {
  const queryClient = useQueryClient()
  const [sure, setSure] = useState(false)
  const reset = async () => {
    queryClient.setQueryData(['assistants'], await assistants.resetToken())
    setSure(false)
  }
  return (
    <section className="flex items-center gap-3 border-t border-line px-5 py-3 text-xs text-ink-3">
      <p className="min-w-0 flex-1 leading-relaxed">
        {sure
          ? 'Assistants connected with the token now disconnect: set them up again (Claude Desktop picks the new one up itself).'
          : 'Assistants send a token of Lumovi’s to connect.'}
      </p>
      {sure && (
        <Button variant="ghost" className="h-7 px-2.5 text-xs" onClick={() => setSure(false)}>
          Cancel
        </Button>
      )}
      <Button
        variant={sure ? 'danger' : 'secondary'}
        className="h-7 px-2.5 text-xs"
        onClick={() => (sure ? void reset() : setSure(true))}
      >
        {sure ? 'Make a new token' : 'New token…'}
      </Button>
    </section>
  )
}

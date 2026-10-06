import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, Lock, Sparkles, X } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useEffect, useState } from 'react'
import type { LumoviApi } from '@shared/api'
import type { AiChanges, ServerAssistantsStatus } from '@shared/assistants'
import { Button, buttonClass, IconButton } from '@renderer/components/Button'
import { TabContent, TabList, Tabs } from '@renderer/components/Tabs'
import { useContexts } from '@renderer/hooks/queries'
import { useSettings } from '@renderer/hooks/settings'
import { cn } from '@renderer/lib/cn'
import { age } from '@renderer/lib/format'
import { useUi } from '@renderer/state/ui'
import { Snippet } from './AssistantsDialog'

type ServerAssistantsApi = NonNullable<LumoviApi['serverAssistants']>

/** The person's assistants on this server, and how they connect: kept up to date by the server. */
function useServerStatus(assistants: ServerAssistantsApi): ServerAssistantsStatus | undefined {
  const queryClient = useQueryClient()
  useEffect(
    () => assistants.onStatus((status) => queryClient.setQueryData(['server-assistants'], status)),
    [assistants, queryClient],
  )
  return useQuery({ queryKey: ['server-assistants'], queryFn: () => assistants.status() }).data
}

/** Opens AI assistants' settings; a dot says one of the person's is connected. Hidden when they're off. */
export function ServerAssistantsButton({ assistants }: { assistants: ServerAssistantsApi }) {
  const status = useServerStatus(assistants)
  const setOpen = useUi((ui) => ui.setAssistants)
  if (!status?.enabled) return null
  const connected = status.clients.length
  return (
    <IconButton
      label={connected ? `AI assistants (${connected} connected)` : 'AI assistants'}
      className="relative"
      onClick={() => setOpen(true)}
    >
      <Sparkles />
      {connected > 0 && (
        <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-good ring-2 ring-surface" />
      )}
    </IconButton>
  )
}

/** A server's AI assistants: connecting them, the person's own, and what they may change. */
export function ServerAssistantsDialog({ assistants }: { assistants: ServerAssistantsApi }) {
  const open = useUi((ui) => ui.assistants)
  const setOpen = useUi((ui) => ui.setAssistants)
  const status = useServerStatus(assistants)
  const contexts = useContexts().data?.contexts
  return open && status && contexts ? (
    <Dialog.Root open onOpenChange={(open) => !open && setOpen(false)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 animate-fade-in bg-black/30 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => event.preventDefault()}
          className="fixed top-[8vh] left-1/2 z-50 flex max-h-[84vh] w-[640px] max-w-[calc(100vw-48px)] -translate-x-1/2 animate-pop-in flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface-2 shadow-pop outline-none"
        >
          <header className="flex items-start gap-3 px-5 pt-5 pb-4">
            <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-strong">
              <Sparkles className="size-[18px]" />
            </div>
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-[15px] leading-snug font-semibold text-ink-1">
                AI assistants
              </Dialog.Title>
              <p className="mt-0.5 text-xs leading-relaxed text-ink-3">
                Claude Code, Cursor, VS Code and other assistants read the clusters you can see
                through Lumovi, as you, and ask you here before they change anything.
              </p>
            </div>
            {/* A plain button: a tooltip opening on focus would swallow the first Escape. */}
            <Dialog.Close
              aria-label="Close"
              className="-mt-1 -mr-2 grid size-8 shrink-0 place-items-center rounded-lg text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink-1"
            >
              <X className="size-4" />
            </Dialog.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto border-t border-line">
            {status.enabled ? (
              <>
                <Connect url={status.url} />
                <Yours status={status} assistants={assistants} />
                <Changes status={status} contexts={contexts.map((c) => c.name)} />
                {/* Not every browser has them: Safari on a phone, outside a home-screen app. */}
                {'Notification' in window && <Notifications />}
              </>
            ) : (
              <p className="px-5 py-5 text-[13px] leading-relaxed text-ink-2">
                This server’s administrator has turned AI assistants off.
              </p>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  ) : null
}

const TABS = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'vscode', label: 'VS Code' },
  { value: 'other', label: 'Other' },
]

/** How to connect each assistant: it signs in through Lumovi, in the browser, as the person. */
function Connect({ url }: { url: string }) {
  const cursor = `cursor://anysphere.cursor-deeplink/mcp/install?name=lumovi&config=${encodeURIComponent(btoa(JSON.stringify({ url })))}`
  const vscode = `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: 'lumovi', type: 'http', url }))}`
  return (
    <section aria-label="Connect an assistant" className="pt-3">
      <h3 className="mb-1 px-5 text-2xs font-medium tracking-wider text-ink-3 uppercase">
        Connect an assistant
      </h3>
      <Tabs defaultValue="claude-code">
        <TabList tabs={TABS} />
        <div className="px-5 py-4 text-[13px] leading-relaxed text-ink-2">
          <TabContent value="claude-code" className="space-y-2.5">
            <p>Run this once, in a terminal:</p>
            <Snippet
              text={`claude mcp add --transport http lumovi ${url}`}
              label="Command"
              copy="Copy command"
            />
            <p className="text-xs text-ink-3">
              Then sign in with /mcp in Claude Code: Lumovi opens here, and asks you to allow it.
            </p>
          </TabContent>
          <TabContent value="cursor" className="space-y-2.5">
            <a href={cursor} className={buttonClass('primary', 'w-fit')}>
              Add to Cursor
            </a>
            <p className="text-xs text-ink-3">
              Cursor asks you to confirm, then opens Lumovi here to sign in.
            </p>
          </TabContent>
          <TabContent value="vscode" className="space-y-2.5">
            <a href={vscode} className={buttonClass('primary', 'w-fit')}>
              Add to VS Code
            </a>
            <p className="text-xs text-ink-3">
              VS Code asks you to confirm, then opens Lumovi here to sign in.
            </p>
          </TabContent>
          <TabContent value="other" className="space-y-2.5">
            <p>
              Assistants that connect to MCP servers over HTTP use this address. They sign in with
              OAuth: Lumovi opens here, and asks you to allow them.
            </p>
            <Snippet text={url} label="Address" copy="Copy address" />
          </TabContent>
        </div>
      </Tabs>
    </section>
  )
}

/** The person's assistants: each acts as them until they disconnect it, or sign out. */
function Yours({
  status,
  assistants,
}: {
  status: ServerAssistantsStatus
  assistants: ServerAssistantsApi
}) {
  const queryClient = useQueryClient()
  const disconnect = async (id: string) => {
    queryClient.setQueryData(['server-assistants'], await assistants.revoke(id))
  }
  return (
    <section aria-label="Your assistants" className="border-t border-line px-5 py-4">
      <h3 className="mb-1 text-2xs font-medium tracking-wider text-ink-3 uppercase">
        Your assistants
      </h3>
      <p className="mb-2.5 text-xs leading-relaxed text-ink-3">
        They act as you, with what you may do in each cluster, until you disconnect them or sign out
        of Lumovi.
      </p>
      {status.clients.length === 0 ? (
        <p className="text-[13px] text-ink-3">None yet: assistants you allow show here.</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {status.clients.map((client) => (
            <li key={client.id} className="flex items-center gap-3 py-2 pr-2 pl-3">
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-good" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-ink-1">{client.name}</span>
                <span className="block text-xs text-ink-3">
                  Allowed {age(new Date(client.since).toISOString())} ago
                  {client.lastUsed && ` · used ${age(new Date(client.lastUsed).toISOString())} ago`}
                </span>
              </span>
              <Button
                variant="ghost"
                className="h-7 px-2.5 text-xs"
                onClick={() => void disconnect(client.id)}
              >
                Disconnect
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

const POLICY: Record<AiChanges, { label: string; className: string }> = {
  ask: { label: 'Ask you', className: 'text-ink-2' },
  allow: { label: 'Made without asking', className: 'text-warn-text' },
  never: { label: 'Never', className: 'text-ink-3' },
}
const READ_ONLY = { label: 'Read-only: no changes', className: 'text-ink-3' }

/** What assistants' changes do in each cluster, as the server's administrator set it. */
function Changes({ status, contexts }: { status: ServerAssistantsStatus; contexts: string[] }) {
  const settings = useSettings().data
  return (
    <section aria-label="Changes they ask for" className="border-t border-line px-5 py-4">
      <h3 className="text-2xs font-medium tracking-wider text-ink-3 uppercase">
        Changes they ask for
      </h3>
      <p className="mt-1 mb-3 text-xs leading-relaxed text-ink-3">
        As this server’s administrator set them, and none where you made a cluster read-only.
        Deletions, and changes that take fields over from Helm or Argo CD, ask you wherever changes
        are made without asking.
      </p>
      <ul className="divide-y divide-line rounded-lg border border-line">
        {contexts.map((name) => {
          // Read-only for the person, too: their assistants change nothing there.
          const policy =
            settings?.readOnlyAll || settings?.readOnly?.includes(name)
              ? READ_ONLY
              : POLICY[status.changes.clusters[name] ?? status.changes.default]
          return (
            <li key={name} className="flex items-center gap-3 py-2 pr-3 pl-3">
              <span className="min-w-0 flex-1 truncate text-[13px] text-ink-1" title={name}>
                {name}
              </span>
              <span className={cn('flex items-center gap-1.5 text-xs', policy.className)}>
                <Lock className="size-3 text-ink-3" />
                {policy.label}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** The browser's notifications of changes waiting, while Lumovi's tab isn't in front. */
function Notifications() {
  const [permission, setPermission] = useState(Notification.permission)
  return (
    <section
      aria-label="Notifications"
      className="flex items-center gap-3 border-t border-line px-5 py-3 text-xs text-ink-3"
    >
      <Bell className="size-3.5 shrink-0" />
      <p className="min-w-0 flex-1 leading-relaxed">
        {permission === 'granted'
          ? 'This browser tells you when a change waits for you.'
          : permission === 'denied'
            ? 'This browser’s settings block Lumovi’s notifications.'
            : 'Let this browser tell you when a change waits for you, while you’re elsewhere.'}
      </p>
      {permission === 'default' && (
        <Button
          className="h-7 px-2.5 text-xs"
          onClick={() => void Notification.requestPermission().then(setPermission)}
        >
          Notify me
        </Button>
      )}
    </section>
  )
}

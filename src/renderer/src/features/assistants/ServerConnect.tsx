/**
 * A server's AI assistants: how to connect them (they sign in through
 * Lumovi), the browser's notifications of their changes, and the person's
 * own assistants (the AI assistants page's Connect and Your assistants tabs).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import type { LumoviApi } from '@shared/api'
import type { ServerAssistantsStatus } from '@shared/assistants'
import { Button, buttonClass, IconButton } from '@renderer/components/Button'
import { TabContent, TabList, Tabs } from '@renderer/components/Tabs'
import { age } from '@renderer/lib/format'
import { Snippet } from './DesktopConnect'
import { Card } from './PageParts'

export type ServerAssistantsApi = NonNullable<LumoviApi['serverAssistants']>

/** The person's assistants on this server, and how they connect: kept up to date by the server. */
export function useServerStatus(
  assistants: ServerAssistantsApi,
): ServerAssistantsStatus | undefined {
  const queryClient = useQueryClient()
  useEffect(
    () => assistants.onStatus((status) => queryClient.setQueryData(['server-assistants'], status)),
    [assistants, queryClient],
  )
  return useQuery({ queryKey: ['server-assistants'], queryFn: () => assistants.status() }).data
}

/** Opens the AI assistants page; a dot says one of the person's is connected. Hidden when they're off. */
export function ServerAssistantsButton({ assistants }: { assistants: ServerAssistantsApi }) {
  const status = useServerStatus(assistants)
  const navigate = useNavigate()
  if (!status?.enabled) return null
  const connected = status.clients.length
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

/** How to connect an assistant, and the browser's notifications of what they ask for. */
export function ServerConnectTab({ url }: { url: string }) {
  return (
    <Card>
      <Connect url={url} />
      {/* Not every browser has them: Safari on a phone, outside a home-screen app. */}
      {'Notification' in window && <Notifications />}
    </Card>
  )
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
export function YourAssistantsTab({
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
    <Card as="section" aria-label="Your assistants" className="px-5 py-4">
      <h2 className="mb-1 text-[15px] font-semibold text-ink-1">Your assistants</h2>
      <p className="mb-3 text-xs leading-relaxed text-ink-3">
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
    </Card>
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

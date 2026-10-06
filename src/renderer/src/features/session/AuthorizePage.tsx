import {
  CircleAlert,
  Eye,
  LoaderCircle,
  Lock,
  PencilLine,
  ScrollText,
  Sparkles,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { decider } from '@shared/ai-permissions'
import type { LumoviApi } from '@shared/api'
import { Button } from '@renderer/components/Button'
import { useContexts } from '@renderer/hooks/queries'
import { readOnlyIn, useSettings } from '@renderer/hooks/settings'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { serverUrl } from '@renderer/web/session'
import { useNamespaceIndex } from '../assistants/namespaces'
import { useAiPermissions } from '../assistants/PermissionsTab'
import { formatCount, plural, tally, targetOf } from '../assistants/permissions-model'
import { card, Frame } from './SignInPage'

/** Who asks to act as the person, and where it goes back to (the server checked the request). */
interface Request {
  client: string
  returnsTo: string
  person: string
}

const AUTHORIZE = 'api/assistants/authorize'

/**
 * Where an AI assistant sends the person to allow it (OAuth's authorization
 * page): who's asking, to act as whom, and where it goes back to. Allowed, the
 * assistant acts as them; either way, the page goes back to it.
 */
export function AuthorizePage() {
  const query = window.location.search.slice(1)
  const [request, setRequest] = useState<Request | Error>()
  const [answering, setAnswering] = useState<boolean>()

  useEffect(() => {
    void fetch(serverUrl(`${AUTHORIZE}?${query}`)).then(async (response) => {
      const body = await response.json()
      setRequest(response.ok ? (body as Request) : new Error(body.error))
    })
  }, [query])

  const answer = async (approved: boolean) => {
    setAnswering(approved)
    const response = await fetch(serverUrl(AUTHORIZE), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, approved }),
    })
    const body = await response.json()
    if (response.ok) window.location.assign(body.redirect)
    else setRequest(new Error(body.error))
  }

  if (!request) return null
  return (
    <Frame title="Allow an AI assistant?" pageTitle="Allow an AI assistant — Lumovi">
      {request instanceof Error ? (
        <p
          role="alert"
          className="flex gap-2.5 rounded-xl border border-critical/25 bg-critical/8 px-3.5 py-2.5 text-[13px] leading-snug text-ink-1"
        >
          <CircleAlert className="mt-px size-4 shrink-0 text-critical-text" />
          <span>
            This request to allow an assistant can’t be answered: {request.message} Start again from
            the assistant.
          </span>
        </p>
      ) : (
        <section aria-label="Allow an assistant" className={card}>
          <p className="flex items-center gap-2 text-[15px] font-semibold text-ink-1">
            <Sparkles className="size-4 text-accent-strong" /> {request.client}
          </p>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
            wants to use Lumovi as <span className="font-medium text-ink-1">{request.person}</span>.
            With your AI permissions, it will:
          </p>
          <Summary permissions={api.aiPermissions!} />
          <p className="mt-3 text-xs leading-relaxed text-ink-3">
            Then it goes back to <span className="font-mono text-ink-2">{request.returnsTo}</span>.
            Allow it only if you started this from {request.client}.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Button
              variant="ghost"
              disabled={answering !== undefined}
              onClick={() => void answer(false)}
            >
              {answering === false && <LoaderCircle className="animate-spin" />}
              Deny
            </Button>
            <Button
              variant="primary"
              disabled={answering !== undefined}
              onClick={() => void answer(true)}
            >
              {answering === true && <LoaderCircle className="animate-spin" />}
              Allow
            </Button>
          </div>
        </section>
      )}
    </Frame>
  )
}

/**
 * What the assistant may do once allowed, as the person's AI permissions say,
 * counted over every namespace they can list: how much it sees, changes, and
 * reads.
 */
function Summary({ permissions }: { permissions: NonNullable<LumoviApi['aiPermissions']> }) {
  const view = useAiPermissions(permissions).data
  const contexts = useContexts().data?.contexts
  const settings = useSettings().data
  const index = useNamespaceIndex(contexts)
  const counts = useMemo(() => {
    if (!view) return undefined
    const decide = decider(view)
    const decided = index.namespaces.map((ns) => ({ ns, decision: decide(targetOf(ns)) }))
    return tally(decided, (cluster) => readOnlyIn(settings, cluster))
  }, [view, index, settings])
  if (!counts || index.counting.length) {
    return <p className="mt-3 text-xs text-ink-3">Counting what it may do…</p>
  }
  const facts = [
    {
      icon: Eye,
      text: `See ${plural(counts.seen, 'namespace', 'namespaces')} in ${plural(counts.clusters, 'cluster', 'clusters')}${counts.hidden ? `; ${formatCount(counts.hidden)} hidden from it` : ''}.`,
    },
    {
      icon: PencilLine,
      text: `Ask you before it changes anything in ${plural(counts.asking, 'namespace', 'namespaces')}, and never change ${formatCount(counts.never)}.`,
    },
    {
      icon: PencilLine,
      text: `Change ${plural(counts.unasked, 'namespace', 'namespaces')} without asking.`,
      warn: counts.unasked > 0,
    },
    {
      icon: Lock,
      text: `Read Secrets’ values in ${plural(counts.values, 'namespace', 'namespaces')}.`,
      warn: counts.values > 0,
    },
    { icon: ScrollText, text: `Read logs in ${plural(counts.logs, 'namespace', 'namespaces')}.` },
  ]
  return (
    <>
      <ul
        aria-label="What it may do"
        className="mt-3 divide-y divide-line overflow-hidden rounded-lg border border-line"
      >
        {facts.map(({ icon: Icon, text, warn }) => (
          <li
            key={text}
            className={cn(
              'flex gap-2.5 px-3 py-2 text-[13px] leading-snug',
              warn ? 'text-warn-text' : 'text-ink-1',
            )}
          >
            <Icon className="mt-0.5 size-3.5 shrink-0 text-ink-3" />
            {text}
          </li>
        ))}
      </ul>
      {index.failed.length > 0 && (
        <p className="mt-2 text-xs text-warn-text">
          Not counted: {index.failed.map(({ context }) => context).join(', ')}, whose namespaces
          can’t be listed.
        </p>
      )}
      <a
        href={serverUrl('assistants/permissions').href}
        target="_blank"
        rel="noreferrer"
        className="mt-2 inline-block text-xs text-accent hover:text-accent-strong hover:underline"
      >
        Change what assistants may do
      </a>
    </>
  )
}

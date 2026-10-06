import { CircleAlert, LoaderCircle, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@renderer/components/Button'
import { serverUrl } from '@renderer/web/session'
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
            wants to use Lumovi as <span className="font-medium text-ink-1">{request.person}</span>:
            to read the clusters you can see, and to ask to change them. Each change waits for your
            approval in Lumovi, unless a cluster lets assistants make it without asking.
          </p>
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

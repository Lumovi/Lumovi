import { CircleAlert, Info, KeyRound, LogIn, RotateCw, ServerOff, UserX } from 'lucide-react'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { REPO_URL } from '@shared/app'
import type { SignInProblem } from '@shared/server'
import { Button, IconButton } from '@renderer/components/Button'
import { CopyButton } from '@renderer/components/CopyButton'
import { GithubMark, Logo } from '@renderer/components/Logo'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { storedTheme, storeTheme } from '@renderer/web/preferences'
import { signInUrl, signInWithToken, type SessionState } from '@renderer/web/session'
import { ThemePicker } from '../shell/ThemeMenu'

type Notice = SignInProblem | 'expired-session' | 'signed-out'

/** What the sign-in page says about the last sign-in, or session. */
const NOTICES: Record<Notice, { text: string; problem: boolean }> = {
  'signed-out': { text: 'You’ve signed out.', problem: false },
  'expired-session': {
    text: 'Your session ended. Sign in again to carry on where you were.',
    problem: false,
  },
  denied: { text: 'Signing in was cancelled, or the provider said no.', problem: true },
  expired: {
    text: 'That sign-in took too long, or started in another browser. Try again.',
    problem: true,
  },
  failed: {
    text: 'Signing in didn’t work. The KubeStacks server’s log says why.',
    problem: true,
  },
  refused: {
    text: 'KubeStacks won’t act as this account: names starting with system: are Kubernetes’ own.',
    problem: true,
  },
}

/** The sign-in page's frame, as the desktop app's start screen looks. */
function Frame({ title, children }: { title: string; children: ReactNode }) {
  const [theme, setTheme] = useState(storedTheme)
  useEffect(() => {
    document.title = 'Sign in — KubeStacks'
  }, [])
  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-40 h-[480px] bg-[radial-gradient(closest-side,var(--accent-soft),transparent)]"
      />
      <main className="relative flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 py-10">
        <div className="my-auto flex w-full max-w-sm animate-rise flex-col">
          <header className="mb-7 flex flex-col items-center text-center">
            <div className="mb-5 grid size-14 place-items-center rounded-2xl border border-line-strong bg-surface-2 shadow-panel">
              <Logo className="size-9" />
            </div>
            <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-ink-1">{title}</h1>
          </header>
          {children}
        </div>
      </main>
      <footer className="relative flex shrink-0 items-center justify-center gap-1 pb-4">
        <ThemePicker
          theme={theme}
          onChange={(next) => {
            storeTheme(next)
            setTheme(next)
          }}
        />
        <IconButton label="KubeStacks on GitHub" onClick={() => api.app.openExternal(REPO_URL)}>
          <GithubMark />
        </IconButton>
      </footer>
    </div>
  )
}

function NoticeBar({ notice }: { notice: Notice }) {
  const { text, problem } = NOTICES[notice]
  const Icon = problem ? CircleAlert : Info
  return (
    <p
      role={problem ? 'alert' : 'status'}
      className={cn(
        'mb-4 flex animate-fade-in gap-2.5 rounded-xl border px-3.5 py-2.5 text-[13px] leading-snug',
        problem
          ? 'border-critical/25 bg-critical/8 text-ink-1'
          : 'border-line bg-surface-2 text-ink-2',
      )}
    >
      <Icon
        className={cn('mt-px size-4 shrink-0', problem ? 'text-critical-text' : 'text-ink-3')}
      />
      {text}
    </p>
  )
}

const card = 'rounded-2xl border border-line bg-surface-2 p-5 shadow-panel'

const TOKEN_COMMAND = 'kubectl create token NAME --namespace NAMESPACE'

/** A problem single sign-on came back with is in the address, once: it's taken out. */
function takeProblem(): SignInProblem | undefined {
  const url = new URL(window.location.href)
  const problem = url.searchParams.get('sign-in')
  url.searchParams.delete('sign-in')
  history.replaceState(history.state, '', url)
  return problem !== null && problem in NOTICES ? (problem as SignInProblem) : undefined
}

export function SignInPage({
  signIn,
}: {
  signIn: Extract<SessionState, { signIn: unknown }>['signIn']
}) {
  const [notice] = useState<Notice | undefined>(
    () =>
      takeProblem() ??
      signIn.problem ??
      (signIn.ended && (signIn.ended === 'expired' ? 'expired-session' : 'signed-out')),
  )
  return (
    <Frame title={signIn.auth === 'proxy' ? 'KubeStacks' : 'Sign in to KubeStacks'}>
      {notice && <NoticeBar notice={notice} />}
      {signIn.auth === 'token' && <TokenForm />}
      {signIn.auth === 'oidc' && (
        <div className={card}>
          <Button
            variant="primary"
            autoFocus
            className="h-10 w-full text-[14px]"
            onClick={() => window.location.assign(signInUrl())}
          >
            <LogIn /> Sign in with {signIn.provider}
          </Button>
          <p className="mt-3 text-center text-xs leading-relaxed text-ink-3">
            Your own access applies: you see and change what your account may.
          </p>
        </div>
      )}
      {signIn.auth === 'proxy' && (
        <div className={cn(card, 'flex flex-col items-center text-center')}>
          <UserX className="mb-3 size-6 text-ink-3" />
          <h2 className="text-[14px] font-semibold text-ink-1">
            KubeStacks doesn’t know who you are
          </h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
            It runs behind a proxy that signs people in and says who they are, and it didn’t say.
            Ask whoever runs KubeStacks to check the proxy.
          </p>
        </div>
      )}
    </Frame>
  )
}

function TokenForm() {
  const [token, setToken] = useState('')
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setPending(true)
    setError(undefined)
    try {
      await signInWithToken(token.trim())
      // Starts afresh, signed in, where it was.
      window.location.reload()
    } catch (e) {
      setError((e as Error).message)
      setPending(false)
    }
  }
  return (
    <form onSubmit={(event) => void submit(event)} className={cn(card, 'space-y-3')}>
      <label className="block">
        <span className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-ink-2">
          <KeyRound className="size-3.5" /> Token
        </span>
        <input
          type="password"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder="Paste a token"
          value={token}
          aria-invalid={error !== undefined}
          aria-describedby="token-help"
          onChange={(event) => setToken(event.target.value)}
          className="h-9 w-full rounded-lg border border-line-strong bg-surface px-3 font-mono text-xs text-ink-1 outline-none placeholder:font-sans placeholder:text-ink-3 focus:border-accent focus:ring-3 focus:ring-accent-soft aria-[invalid=true]:border-critical"
        />
      </label>
      {error && (
        <p role="alert" className="flex gap-1.5 text-xs leading-snug text-critical-text">
          <CircleAlert className="mt-px size-3.5 shrink-0" />
          {error}
        </p>
      )}
      <Button
        type="submit"
        variant="primary"
        disabled={token.trim() === '' || pending}
        className="h-9 w-full"
      >
        {pending ? 'Signing in…' : 'Sign in'}
      </Button>
      <div id="token-help" className="space-y-1.5 text-xs leading-relaxed text-ink-3">
        <p>
          A bearer token the cluster accepts: you see and change what it allows, as{' '}
          <code className="font-mono text-ink-2">kubectl</code> would with it. A service account’s,
          say:
        </p>
        <div className="flex items-center gap-1 rounded-lg border border-line bg-surface py-0.5 pr-0.5 pl-2.5">
          <code className="min-w-0 flex-1 truncate font-mono text-ink-2 selectable">
            {TOKEN_COMMAND}
          </code>
          <CopyButton text={TOKEN_COMMAND} label="Copy the command" />
        </div>
      </div>
    </form>
  )
}

/** The server didn't answer (it's starting, or a proxy in front of it can't reach it). */
export function Unavailable({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <Frame title="KubeStacks">
      <div role="alert" className={cn(card, 'flex flex-col items-center text-center')}>
        <ServerOff className="mb-3 size-6 text-ink-3" />
        <h2 className="text-[14px] font-semibold text-ink-1">Can’t reach KubeStacks</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
          It may be starting. Try again in a moment.
        </p>
        <p className="mt-3 max-w-full rounded-md bg-surface-3 px-2.5 py-1.5 font-mono text-xs break-words text-ink-2 selectable">
          {error.message}
        </p>
        <Button className="mt-4" onClick={onRetry}>
          <RotateCw /> Try again
        </Button>
      </div>
    </Frame>
  )
}

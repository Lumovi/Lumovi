import { Bug, Copy, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@renderer/components/Button'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { REPO_URL } from '../welcome/WelcomePage'

/** What a user sees when a view crashes: what happened, and ways out. */
export function CrashView({
  error,
  title,
  children,
  className,
}: {
  error: Error
  title: string
  /** Extra actions, e.g. "Back to clusters". */
  children?: ReactNode
  className?: string
}) {
  const details = String(error.stack)
  const report = () => {
    const body = `<!-- This issue is public: check the error for cluster or context names you'd rather not share. -->\n\n**What were you doing?**\n\n\n**Error**\n\n\`\`\`\n${details}\n\`\`\``
    void api.app.openExternal(
      `${REPO_URL}/issues/new?title=${encodeURIComponent(`Crash: ${error.message}`)}&body=${encodeURIComponent(body)}`,
    )
  }
  return (
    <div
      role="alert"
      className={cn(
        'mx-auto flex max-w-lg animate-rise flex-col items-center px-6 py-16 text-center',
        className,
      )}
    >
      <div className="mb-4 grid size-12 place-items-center rounded-2xl bg-critical/10 text-critical-text">
        <TriangleAlert className="size-6" />
      </div>
      <h2 className="text-[17px] font-semibold text-ink-1">{title}</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
        KubeStacks ran into an unexpected problem. Your clusters were not changed.
      </p>
      <pre className="mt-4 max-h-40 w-full overflow-auto rounded-lg border border-line bg-surface-3 px-3 py-2 text-left font-mono text-xs whitespace-pre-wrap text-ink-2 selectable">
        {error.message}
      </pre>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        {children}
        <Button onClick={() => void navigator.clipboard.writeText(details)}>
          <Copy /> Copy details
        </Button>
        <Button variant="ghost" onClick={report}>
          <Bug /> Report issue
        </Button>
      </div>
    </div>
  )
}

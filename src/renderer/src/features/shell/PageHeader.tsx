/**
 * The header of a page of its own (AI assistants, the audit log): back to
 * where the person came from, Lumovi, and where it is (and who).
 */
import { ArrowLeft } from 'lucide-react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { IconButton } from '@renderer/components/Button'
import { LogoLockup } from '@renderer/components/LogoLockup'

export function PageHeader({
  scope,
  scopeLine,
  end,
}: {
  scope: string
  scopeLine?: string
  end?: ReactNode
}) {
  const navigate = useNavigate()
  // Back where the person came from; opened from elsewhere (a link), to the start.
  const back = () =>
    void ((window.history.state as { idx?: number } | null)?.idx ? navigate(-1) : navigate('/'))
  return (
    <header className="titlebar-leading titlebar-trailing flex min-h-[52px] shrink-0 flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-2 drag">
      <IconButton label="Back" className="no-drag" onClick={back}>
        <ArrowLeft />
      </IconButton>
      <LogoLockup className="h-5" />
      <span aria-hidden className="h-5 w-px bg-line-strong" />
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="truncate text-[13px] font-semibold text-ink-1">{scope}</span>
        {scopeLine && <span className="text-xs whitespace-nowrap text-ink-3">{scopeLine}</span>}
      </span>
      <span className="flex min-w-0 flex-1 justify-end">{end}</span>
    </header>
  )
}

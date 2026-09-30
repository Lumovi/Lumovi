import { RotateCw, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import type { KubeErrorCode } from '@shared/api'
import type { KubeApiError } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { Button } from './Button'

const ERROR_COPY: Record<KubeErrorCode, { title: string; hint: string }> = {
  unreachable: {
    title: 'Can’t reach the cluster',
    hint: 'Check that the API server is running and reachable from this machine — a VPN or tunnel may be required.',
  },
  timeout: {
    title: 'The cluster is not responding',
    hint: 'The API server accepted the connection but did not answer in time.',
  },
  tls: {
    title: 'The cluster’s certificate could not be verified',
    hint: 'The certificate authority in your kubeconfig does not match the API server.',
  },
  insecure: {
    title: 'Plain HTTP is not allowed',
    hint: 'Unencrypted connections have to be enabled explicitly for this cluster in your kubeconfig.',
  },
  auth: {
    title: 'Couldn’t get credentials',
    hint: 'The credential plugin for this context failed. Make sure it is installed and that you are logged in.',
  },
  unauthorized: {
    title: 'Your credentials were rejected',
    hint: 'The token or certificate may have expired. Sign in again, then retry.',
  },
  forbidden: {
    title: 'Access denied',
    hint: 'Your account is not allowed to read this. If you only have access to some namespaces, pick one from the namespace menu.',
  },
  'not-found': {
    title: 'Not found',
    hint: 'It may have been deleted, or this API is not available on the cluster.',
  },
  server: {
    title: 'The API server returned an error',
    hint: 'This is usually temporary. Retry in a moment.',
  },
  invalid: {
    title: 'Invalid request',
    hint: 'KubeStacks sent a request the cluster could not process.',
  },
}

export function ErrorState({
  error,
  onRetry,
  className,
}: {
  error: KubeApiError
  onRetry: () => void
  className?: string
}) {
  const copy = ERROR_COPY[error.code]
  return (
    <div
      role="alert"
      className={cn('mx-auto flex max-w-md flex-col items-center py-14 text-center', className)}
    >
      <div className="mb-4 grid size-11 place-items-center rounded-2xl bg-critical/10 text-critical-text">
        <span className="text-lg font-semibold">!</span>
      </div>
      <h3 className="text-[15px] font-semibold text-ink-1">{copy.title}</h3>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{copy.hint}</p>
      <p className="mt-3 max-w-full rounded-md bg-surface-3 px-2.5 py-1.5 font-mono text-xs break-words text-ink-2 selectable">
        {error.message}
      </p>
      <Button className="mt-5" onClick={onRetry}>
        <RotateCw /> Try again
      </Button>
    </div>
  )
}

export function EmptyState({
  icon: Icon,
  title,
  children,
  className,
}: {
  icon: LucideIcon
  title: string
  children?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('mx-auto flex max-w-sm flex-col items-center py-14 text-center', className)}>
      <div className="mb-4 grid size-11 place-items-center rounded-2xl border border-line bg-surface-3 text-ink-3">
        <Icon className="size-5" />
      </div>
      <h3 className="text-[14px] font-semibold text-ink-1">{title}</h3>
      <div className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{children}</div>
    </div>
  )
}

export function Loading({ label, className }: { label: string; className?: string }) {
  return (
    <div
      role="status"
      className={cn('flex items-center justify-center gap-2.5 py-16 text-ink-3', className)}
    >
      <span className="size-4 animate-spin rounded-full border-2 border-line-strong border-t-accent" />
      {label}
    </div>
  )
}

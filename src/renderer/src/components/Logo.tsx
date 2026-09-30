import { useId } from 'react'
import { cn } from '@renderer/lib/cn'

/** Three stacked layers: the KubeStacks mark. */
export function Logo({ className }: { className?: string }) {
  const id = useId()
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn('size-7', className)}>
      <defs>
        <linearGradient id={`${id}-a`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6fb1ff" />
          <stop offset="1" stopColor="#2a6fd6" />
        </linearGradient>
        <linearGradient id={`${id}-b`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4d8fe8" />
          <stop offset="1" stopColor="#1d4f9e" />
        </linearGradient>
      </defs>
      <path
        d="M16 19.5 4.5 13.8 16 8.1l11.5 5.7z"
        fill={`url(#${id}-b)`}
        opacity={0.45}
        transform="translate(0 6)"
      />
      <path
        d="M16 19.5 4.5 13.8 16 8.1l11.5 5.7z"
        fill={`url(#${id}-b)`}
        opacity={0.75}
        transform="translate(0 3)"
      />
      <path d="M16 19.5 4.5 13.8 16 8.1l11.5 5.7z" fill={`url(#${id}-a)`} />
    </svg>
  )
}

/** GitHub's mark (from Primer Octicons, MIT). */
export function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden fill="currentColor" className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}

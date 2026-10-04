// The Lumovi mark, for the app. Built by lumovi-design (npm run build): change it there.
import { useId } from 'react'
import { cn } from '@renderer/lib/cn'

const css = (id: string) => `
.${id}-light { fill: #0a0a0a; }
.${id}-shade { fill: #d4d4d4; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) .${id}-light { fill: #ffffff; }
  :root:not([data-theme='light']) .${id}-shade { fill: #404040; }
}
:root[data-theme='dark'] .${id}-light { fill: #ffffff; }
:root[data-theme='dark'] .${id}-shade { fill: #404040; }
`

/** The Lumovi mark: a square, and light sweeping across it. It follows the app's theme. */
export function Logo({ className }: { className?: string }) {
  // useId() has colons, which CSS class names can't.
  const id = `lumovi-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`
  return (
    <svg viewBox="0 0 48 48" aria-hidden className={cn('size-7', className)}>
      <style>{css(id)}</style>
      <path
        className={`${id}-shade`}
        d="M0 12A12 12 0 0 1 12 0H36A12 12 0 0 1 48 12V36A12 12 0 0 1 36 48A36 36 0 0 0 0 12Z"
      />
      <path className={`${id}-light`} d="M0 18V36A12 12 0 0 0 12 48H30A30 30 0 0 0 0 18Z" />
    </svg>
  )
}

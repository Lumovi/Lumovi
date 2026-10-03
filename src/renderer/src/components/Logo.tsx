// The Lumovi mark, for the app. Built by lumovi-design (npm run build): change it there.
import { useId } from 'react'
import { cn } from '@renderer/lib/cn'

const css = (id: string) => `
.${id}-l { fill: url(#${id}-l-light); }
.${id}-orb { fill: url(#${id}-orb-light); }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) .${id}-l { fill: url(#${id}-l-dark); }
  :root:not([data-theme='light']) .${id}-orb { fill: url(#${id}-orb-dark); }
}
:root[data-theme='dark'] .${id}-l { fill: url(#${id}-l-dark); }
:root[data-theme='dark'] .${id}-orb { fill: url(#${id}-orb-dark); }
`

/** The Lumovi mark: an L that holds a light. It follows the app's theme. */
export function Logo({ className }: { className?: string }) {
  // useId() has colons, which CSS class names can't.
  const id = `lumovi-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`
  return (
    <svg viewBox="0 0 48 48" aria-hidden className={cn('size-7', className)}>
      <defs>
        <radialGradient id={`${id}-l-light`} cx="33" cy="15" r="38" gradientUnits="userSpaceOnUse">
          <stop offset="0.553" stopColor="#5ea2f0" />
          <stop offset="0.76" stopColor="#2675d3" />
          <stop offset="1" stopColor="#1c5cab" />
        </radialGradient>
        <radialGradient id={`${id}-orb-light`} cx="0.36" cy="0.32" r="0.78">
          <stop offset="0" stopColor="#bfdcff" />
          <stop offset="0.5" stopColor="#5ea2f0" />
          <stop offset="1" stopColor="#2675d3" />
        </radialGradient>
        <radialGradient id={`${id}-l-dark`} cx="33" cy="15" r="38" gradientUnits="userSpaceOnUse">
          <stop offset="0.553" stopColor="#8cc2ff" />
          <stop offset="0.76" stopColor="#3987e5" />
          <stop offset="1" stopColor="#1c5cab" />
        </radialGradient>
        <radialGradient id={`${id}-orb-dark`} cx="0.36" cy="0.32" r="0.78">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.3" stopColor="#eff7ff" />
          <stop offset="0.72" stopColor="#8cc2ff" />
          <stop offset="1" stopColor="#3987e5" />
        </radialGradient>
      </defs>
      <style>{css(id)}</style>
      <path
        className={`${id}-l`}
        d="M0 15V6A6 6 0 0 1 12 6V15A21 21 0 0 0 33 36H42A6 6 0 0 1 42 48H21A21 21 0 0 1 0 27Z"
      />
      <circle className={`${id}-orb`} cx="33" cy="15" r="15" />
    </svg>
  )
}

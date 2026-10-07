import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/** Tailwind's merge, knowing the theme's own animations (its colors and sizes it reads as such). */
const merge = extendTailwindMerge({
  extend: {
    theme: {
      animate: [
        'fade-in',
        'pop-in',
        'pulse-dot',
        'rise',
        'shimmer',
        'slide-in',
        'slide-out',
        'spin-once',
        'toast-in',
        'toast-out',
      ],
    },
  },
})

/**
 * Class names, joined: and where two set the same thing (a component's `h-8`, its caller's
 * `h-7`), the later one, the caller's, is the one kept.
 */
export const cn = (...classes: ClassValue[]): string => merge(clsx(classes))

import { cn } from '@renderer/lib/cn'

/**
 * Text that, when it doesn't fit, is cut at its start rather than its end: what matters of an
 * image is its tag, at the end. All of it is on hover. (Laid out right to left, so the ellipsis is
 * on the left; the text itself kept left to right.)
 */
export function Tail({ text, className }: { text: string; className?: string }) {
  return (
    <span
      title={text}
      className={cn('block min-w-0 truncate text-left [direction:rtl]', className)}
    >
      <bdi>{text}</bdi>
    </span>
  )
}

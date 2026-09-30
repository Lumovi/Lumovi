import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from '@renderer/lib/cn'
import { Tooltip } from './Tooltip'

const VARIANTS = {
  primary:
    'bg-accent text-white shadow-sm hover:bg-accent-strong active:translate-y-px disabled:opacity-50',
  secondary:
    'border border-line-strong bg-surface-2 text-ink-1 shadow-xs hover:bg-surface-3 active:translate-y-px',
  ghost: 'text-ink-2 hover:bg-surface-3 hover:text-ink-1',
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof VARIANTS
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', className, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-[13px] font-medium whitespace-nowrap transition-colors duration-150 no-drag [&_svg]:size-4 [&_svg]:shrink-0',
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  )
})

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string
  children: ReactNode
}

/** A square ghost button whose accessible name doubles as its tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, className, children, ...props },
  ref,
) {
  return (
    <Tooltip content={label}>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        className={cn(
          'inline-flex size-8 items-center justify-center rounded-lg text-ink-2 transition-colors duration-150 no-drag hover:bg-surface-3 hover:text-ink-1 data-[state=open]:bg-surface-3 data-[state=open]:text-ink-1 [&_svg]:size-4',
          className,
        )}
        {...props}
      >
        {children}
      </button>
    </Tooltip>
  )
})

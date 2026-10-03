import logoOnDark from '@renderer/assets/lumovi-logo-on-dark.svg'
import logoOnLight from '@renderer/assets/lumovi-logo-on-light.svg'
import { cn } from '@renderer/lib/cn'

/**
 * Lumovi's logo: the mark beside the wordmark, for where the name isn't said otherwise.
 * It's artwork from Lumovi's design repository (the wordmark isn't text), one for each
 * theme, and only the one for the theme in use shows.
 */
export function LogoLockup({ className }: { className?: string }) {
  return (
    <>
      <img src={logoOnLight} alt="Lumovi" className={cn('logo-on-light w-auto', className)} />
      <img src={logoOnDark} alt="Lumovi" className={cn('logo-on-dark w-auto', className)} />
    </>
  )
}

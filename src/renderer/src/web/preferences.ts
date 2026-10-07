/**
 * What a browser keeps for itself when Lumovi is served: its theme, in a cookie, so pages start
 * in it. (Its clusters' settings are the server's, the same for everyone.)
 */
import type { ThemePreference } from '@shared/api'
import { THEME_COOKIE } from '@shared/server'

const YEAR = 365 * 24 * 3600

export function storedTheme(): ThemePreference {
  const theme = document.documentElement.dataset.theme
  return theme === 'light' || theme === 'dark' ? theme : 'system'
}

/** Shows the page in `theme`, and keeps it for the next (the server reads the cookie). */
export function storeTheme(theme: ThemePreference): void {
  if (theme === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
  const path = new URL(document.baseURI).pathname
  document.cookie = `${THEME_COOKIE}=${theme}; Path=${path}; Max-Age=${YEAR}; SameSite=Lax`
}

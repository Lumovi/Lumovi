/**
 * What a browser keeps for itself when Lumovi is served: its theme (in a
 * cookie, so pages start in it), and which clusters are read-only, where
 * their metrics come from and where their node shells run (which its pages
 * give the server).
 */
import type { Settings, ThemePreference } from '@shared/api'
import { THEME_COOKIE, type PageSettings } from '@shared/server'

const KEY = 'lumovi:settings'
const YEAR = 365 * 24 * 3600

export function storedSettings(): PageSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<PageSettings>
    return {
      readOnly: stored.readOnly ?? [],
      metricsSource: stored.metricsSource ?? {},
      nodeShell: stored.nodeShell ?? {},
    }
  } catch {
    return { readOnly: [], metricsSource: {}, nodeShell: {} }
  }
}

/** Keeps what the server says the preferences now are (it always says them all). */
export function storeSettings({ readOnly, metricsSource, nodeShell }: Settings): void {
  localStorage.setItem(KEY, JSON.stringify({ readOnly, metricsSource, nodeShell }))
}

/** Called when another tab changes the preferences. */
export function onStoredSettings(listener: () => void): void {
  addEventListener('storage', (event) => {
    if (event.key === KEY) listener()
  })
}

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

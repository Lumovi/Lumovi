import { useEffect } from 'react'
import { api } from '@renderer/lib/api'
import { setShortcutSettings } from '@renderer/lib/shortcuts'
import { setTimeSettings } from '@renderer/lib/time'
import { usePreferences } from '@renderer/hooks/settings'
import { setTerminalSettings } from '../terminal/session'

/**
 * The person's settings, applied to the page as they are and as they change: the accent and
 * density as the root's data (styles/index.css), the zone and clock for every date, the keys
 * every place's shortcuts listen for, and on a
 * server the text size as the page's zoom (the desktop's is its window's, set by main).
 */
export function PreferencesApplied() {
  const preferences = usePreferences()
  const { accent, density, timeZone, clock, textSize } = preferences
  // Set as it renders, so a date drawn now is in it, and a terminal opened now in its font.
  setTimeSettings({ timeZone, clock })
  setTerminalSettings({
    font: preferences.terminalFont,
    size: preferences.terminalFontSize,
    copyOnSelect: preferences.copyOnSelect,
  })
  setShortcutSettings(preferences.shortcuts)
  useEffect(() => {
    const root = document.documentElement
    if (accent === 'blue') delete root.dataset.accent
    else root.dataset.accent = accent
    if (density === 'comfortable') delete root.dataset.density
    else root.dataset.density = density
  }, [accent, density])
  useEffect(() => {
    if (api.host !== 'server') return
    document.documentElement.style.zoom = textSize === 100 ? '' : String(textSize / 100)
  }, [textSize])
  return null
}

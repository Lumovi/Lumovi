import type { MetricsSourceSetting, Settings, ThemePreference } from '@shared/api'
import { PROXY_PATH } from './kube/usage'

const THEMES: readonly ThemePreference[] = ['system', 'light', 'dark']

export function isTheme(value: unknown): value is ThemePreference {
  return THEMES.includes(value as ThemePreference)
}

const text = (value: unknown) => typeof value === 'string' && value !== ''

/** A stored or requested metrics source: detection, off, or a service to use. */
export function isMetricsSourceSetting(value: unknown): value is MetricsSourceSetting {
  if (typeof value !== 'object' || value === null) return false
  const { mode, service } = value as { mode?: unknown; service?: Record<string, unknown> }
  if (mode === 'auto' || mode === 'off') return true
  return (
    mode === 'service' &&
    typeof service === 'object' &&
    service !== null &&
    text(service.namespace) &&
    text(service.service) &&
    text(service.port) &&
    typeof service.path === 'string' &&
    PROXY_PATH.test(service.path)
  )
}

/**
 * The preferences the page reads and changes wherever KubeStacks runs: kept
 * in a file on the desktop, and for each page by the server.
 */
export interface SettingsAccess {
  get(): Settings
  isReadOnly(context: string): boolean
  setReadOnly(context: string, readOnly: boolean): Settings
  /** Where `context`'s metrics history comes from; detected unless set otherwise. */
  metricsSource(context: string): MetricsSourceSetting
  setMetricsSource(context: string, setting: MetricsSourceSetting): Settings
}

/**
 * The switches that turn a plugin's code off, as the page knows them from its settings: the
 * organization's policy, a server's, the person's own. The page asks them only to say so and to
 * leave a page's code unasked; the backend decides, from its own, whether any is handed over.
 */
import type { Settings } from '@shared/api'
import type { CodeSwitches } from '@shared/plugin-hand-over'

export const switchesOf = (settings: Settings | undefined): CodeSwitches => ({
  ...(settings?.managed?.pluginCodeOff ? { policyOff: true as const } : {}),
  ...(settings?.pluginCodeOnServer ? { serverOnly: settings.pluginCodeOnServer } : {}),
  chosen: settings?.pluginCode ?? {},
})

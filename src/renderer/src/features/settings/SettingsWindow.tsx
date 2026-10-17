import { api } from '@renderer/lib/api'
import { useSession } from '@renderer/state/session'
import { Commands } from '../shell/Commands'
import { PageHeader } from '../shell/PageHeader'
import { SettingsPage } from './SettingsPage'

/** Settings from the start screen: the page, under a header with Back, as the Audit log has it. */
export function SettingsWindow() {
  const session = useSession()
  return (
    <div className="vt-page flex h-full flex-col overflow-hidden bg-app">
      <Commands />
      <PageHeader
        scope={
          api.host === 'desktop'
            ? 'This computer'
            : session?.fleet
              ? 'Fleet'
              : (session?.cluster ?? '')
        }
        end={<span className="truncate text-[13px] font-semibold text-ink-1">Settings</span>}
      />
      <SettingsPage />
    </div>
  )
}

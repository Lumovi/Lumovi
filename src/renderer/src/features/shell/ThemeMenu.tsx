import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Monitor, Moon, Sun } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import type { ThemePreference } from '@shared/api'
import { IconButton } from '@renderer/components/Button'
import { api } from '@renderer/lib/api'
import { menuContent, menuItem } from './menu-styles'

const THEMES: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
]

export function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: () => api.app.settings(),
    staleTime: Infinity,
  })
}

export function useSetTheme() {
  const queryClient = useQueryClient()
  return async (theme: ThemePreference) => {
    queryClient.setQueryData(['settings'], await api.app.setTheme(theme))
  }
}

export function ThemeMenu() {
  const current = useSettings().data?.theme ?? 'system'
  const setTheme = useSetTheme()
  const Icon = THEMES.find((theme) => theme.value === current)!.icon
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <IconButton label="Theme">
          <Icon />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content side="top" align="start" sideOffset={6} className={menuContent}>
          <DropdownMenu.Label className="px-2 py-1.5 text-2xs font-medium tracking-wide text-ink-3 uppercase">
            Appearance
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={current}
            onValueChange={(value) => setTheme(value as ThemePreference)}
          >
            {THEMES.map(({ value, label, icon: ItemIcon }) => (
              <DropdownMenu.RadioItem key={value} value={value} className={menuItem}>
                <ItemIcon className="size-4 text-ink-3" />
                <span className="flex-1">{label}</span>
                <DropdownMenu.ItemIndicator>
                  <Check className="size-4 text-accent" />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

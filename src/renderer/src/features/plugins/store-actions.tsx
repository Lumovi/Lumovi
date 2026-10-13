/**
 * What the Plugins page does with Lumovi-plugins' latest release (the desktop app's): installing
 * a plugin, updating one, going back, removing one. Each opens the store's dialog first, but
 * going back to a version that asks for nothing more, which goes at once and says so. The main
 * process checks everything again (src/main/plugins-installed.ts): this only asks.
 */
import { Ellipsis, ExternalLink, History, Package, Trash2 } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { asksOf, policyRefusal, type InstalledPlugin } from '@shared/plugin-store'
import { parsePlugin, type Plugin } from '@shared/plugins'
import { IconButton } from '@renderer/components/Button'
import { useSettings } from '@renderer/hooks/settings'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { lumovisOwnKinds } from '@renderer/lib/plugins'
import { toast } from '@renderer/state/toasts'
import { menuContent, menuItem } from '../shell/menu-styles'
import type { KindNames } from './ask-lines'
import { compared, grantedOf, isEmpty } from './granted'
import { StoreDialog, said, type InUse, type StoreDialogIs } from './store-dialog'
import type { Offered } from './store'

/** Where Lumovi-plugins' releases are. */
const RELEASES = 'https://github.com/Lumovi/Lumovi-plugins/releases/tag'

const label = (plugin: Plugin) => plugin.place?.label ?? plugin.name

/** What the page knows of a plugin in use, to update it or go back. */
export interface InUseHere {
  plugin: Plugin
  /** Installed from the store; else it came with Lumovi. */
  installed?: InstalledPlugin
  /** Its code is part of what's in use. */
  code: boolean
}

export function useStoreActions({
  names,
  builtWith,
  ownFiles,
  ownCoded,
}: {
  names: KindNames
  /** The release Lumovi was built with. */
  builtWith: string
  ownFiles: Readonly<Record<string, string>>
  ownCoded: ReadonlySet<string>
}) {
  const queryClient = useQueryClient()
  const managed = useSettings().data?.managed
  const [open, setOpen] = useState<{ is: StoreDialogIs; run: () => Promise<void> }>()
  const store = api.pluginStore

  /** Read again: the plugins, and whatever was handed over of them. */
  const done = async () => {
    await queryClient.invalidateQueries({ queryKey: ['plugins'] })
    await queryClient.invalidateQueries({ queryKey: ['plugin-hand-over'] })
  }
  const inUse = ({ plugin, installed, code }: InUseHere): InUse => ({
    version: plugin.version,
    granted: grantedOf(plugin, code),
    release: installed?.release ?? builtWith,
    lumovis: !installed,
  })
  /** One of Lumovi's own, as it came with it. */
  const own = (name: string): { plugin: Plugin; code: boolean } | undefined => {
    const text = ownFiles[`${name}.yaml`] ?? ownFiles[`${name}.yml`]
    const plugin =
      text === undefined
        ? undefined
        : parsePlugin(text, `${name}.yaml`, { lumovisOwn: lumovisOwnKinds(), carriesCode: true })
            .plugin
    return plugin && { plugin, code: ownCoded.has(name) }
  }

  const install = (offered: Offered, release: string) =>
    setOpen({
      is: {
        kind: 'install',
        plugin: offered.plugin,
        granted: grantedOf(offered.plugin, offered.code),
        release,
      },
      run: async () => {
        await store!.install(
          offered.plugin.name,
          offered.plugin.version,
          asksOf(offered.plugin, offered.code),
        )
        await done()
        toast({
          tone: 'success',
          title: `Installed ${label(offered.plugin)} ${offered.plugin.version}.`,
        })
      },
    })

  const update = (here: InUseHere, offered: Offered, release: string) =>
    setOpen({
      is: {
        kind: 'update',
        plugin: offered.plugin,
        granted: grantedOf(offered.plugin, offered.code),
        release,
        inUse: inUse(here),
      },
      run: async () => {
        await store!.install(
          offered.plugin.name,
          offered.plugin.version,
          asksOf(offered.plugin, offered.code),
        )
        await done()
        toast({
          tone: 'success',
          title: `Updated ${label(offered.plugin)} to ${offered.plugin.version}.`,
        })
      },
    })

  /**
   * Back to the copy kept, or to the one that came with Lumovi: at once, unless it asks for
   * anything the one in use doesn't, which it asks first.
   */
  const back = async (here: InUseHere, to: 'kept' | 'lumovi') => {
    const kept = here.installed?.kept
    const target =
      to === 'kept'
        ? kept && {
            plugin: parsePlugin(kept.file, `${here.plugin.name}.yaml`, {
              lumovisOwn: lumovisOwnKinds(),
              carriesCode: true,
            }).plugin,
            code: kept.code,
            release: kept.release,
          }
        : (() => {
            const theirs = own(here.plugin.name)
            return theirs && { ...theirs, release: builtWith }
          })()
    if (!target?.plugin) return
    const plugin = target.plugin
    const agreed = asksOf(plugin, target.code)
    const run = async () => {
      await store!.goBack(here.plugin.name, to, to === 'kept' ? agreed : undefined)
      await done()
      toast({
        tone: 'success',
        title:
          to === 'kept'
            ? `Went back to ${label(plugin)} ${plugin.version}.`
            : `Went back to Lumovi’s own ${label(plugin)}.`,
      })
    }
    const granted = grantedOf(plugin, target.code)
    if (isEmpty(compared(inUse(here).granted, granted).added)) {
      try {
        await run()
      } catch (error) {
        toast({ tone: 'error', title: said(error) })
      }
      return
    }
    setOpen({
      is: { kind: 'back', plugin, granted, release: target.release, inUse: inUse(here) },
      run,
    })
  }

  const remove = (here: InUseHere) =>
    setOpen({
      is: { kind: 'remove', plugin: here.plugin, version: here.plugin.version },
      run: async () => {
        await store!.remove(here.plugin.name)
        await done()
        toast({ tone: 'success', title: `Removed ${label(here.plugin)}.` })
      },
    })

  const dialog: ReactNode = open && (
    <StoreDialog
      is={open.is}
      names={names}
      {...(() => {
        // (The policy's refusal, said before anything is pressed: going back to Lumovi's own,
        // or removing, is never refused.)
        if (open.is.kind === 'remove') return {}
        const refused = policyRefusal(managed, open.is.plugin, open.is.granted.code)
        return refused ? { refused } : {}
      })()}
      onConfirm={async () => {
        await open.run()
        setOpen(undefined)
      }}
      onClose={() => setOpen(undefined)}
    />
  )
  return { dialog, install, update, back, remove }
}

/** Kept in the menu: not taken by the row it's in (React's events pass through portals). */
const kept = (event: { stopPropagation: () => void }) => event.stopPropagation()

/** An installed plugin's "…": back to the one kept, back to Lumovi's own, its release, Remove. */
export function InstalledMenu({
  here,
  builtIn,
  builtWith,
  actions,
}: {
  here: InUseHere
  /** Whether one comes with Lumovi under its name. */
  builtIn: boolean
  builtWith: string
  actions: ReturnType<typeof useStoreActions>
}) {
  const { plugin, installed } = here
  const item = (Icon: typeof History, text: ReactNode, onSelect: () => void, danger = false) => (
    <DropdownMenu.Item
      // (Two lines, the second saying what it is: as tall as they are.)
      className={cn(
        menuItem,
        'h-auto items-start py-1.5 touch:h-auto',
        danger && 'text-critical-text',
      )}
      onSelect={onSelect}
    >
      <Icon className={cn('mt-0.5 size-4', danger ? 'text-critical-text' : 'text-ink-3')} />
      <span>{text}</span>
    </DropdownMenu.Item>
  )
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild onClick={kept} onPointerDown={kept}>
        <IconButton
          label={`More for ${label(plugin)}`}
          className="size-7 data-[state=open]:bg-surface-3 data-[state=open]:text-ink-1"
        >
          <Ellipsis />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className={cn(menuContent, 'w-[300px]')}>
          {installed?.kept &&
            item(
              History,
              <>
                Back to {installed.kept.version}
                <small className="block text-xs text-ink-3">
                  The one before, kept on this computer
                </small>
              </>,
              () => void actions.back(here, 'kept'),
            )}
          {builtIn &&
            item(
              Package,
              <>
                Back to the one that came with Lumovi
                <small className="block text-xs text-ink-3">
                  As built into this Lumovi, from Lumovi-plugins release {builtWith}
                </small>
              </>,
              () => void actions.back(here, 'lumovi'),
            )}
          {installed &&
            item(
              ExternalLink,
              'Its release on GitHub',
              () => void api.app.openExternal(`${RELEASES}/v${installed.release}`),
            )}
          {!builtIn && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-line" />
              {item(
                Trash2,
                <>
                  Remove {label(plugin)}
                  <small className="block text-xs text-critical-text/80">
                    It goes back under Not here yet
                  </small>
                </>,
                () => actions.remove(here),
                true,
              )}
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

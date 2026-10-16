/**
 * Copy link: the address of what's shown, as a link. On the desktop a lumovi:// link, cut to what
 * a link may carry, with the panel's object on its tab; on a server the page's own address, which
 * already opens the same view there.
 */
import { create } from 'zustand'
import { api } from '@renderer/lib/api'
import type { ResourceKind } from '@shared/resources'
import { currentPath, kindPath } from '@renderer/lib/routes'
import { toast } from '@renderer/state/toasts'
import { useSettings } from '@renderer/hooks/settings'

/** The tab the detail panel shows now: what a link to its object opens at. */
export const useShownTab = create<{ tab?: string }>(() => ({}))

/** Whether links are offered here: not where the organization's policy turns them off. */
export function useLinksOffered(): boolean {
  return useSettings().data?.managed?.linksOff !== true
}

/**
 * Copies the link to what's shown, and says so: the page as it stands (with the panel's object on
 * its tab); or, for an object the page doesn't have open (kept below), its kind's list with it.
 */
export async function copyLink(of?: {
  ref: string
  kind: ResourceKind
  context: string
}): Promise<void> {
  const desktop = api.desktop
  if (!desktop) {
    await navigator.clipboard.writeText(window.location.href)
    toast({ tone: 'success', title: 'Link copied.' })
    return
  }
  const here = currentPath()
  const open = new URLSearchParams(here.split('?')[1]).get('open')
  const elsewhere = of !== undefined && open !== of.ref
  const path = elsewhere
    ? `${kindPath(of.context, of.kind)}?open=${encodeURIComponent(of.ref)}`
    : here
  const tab = !elsewhere && open ? useShownTab.getState().tab : undefined
  try {
    await navigator.clipboard.writeText(await desktop.linkFor(path, tab))
    toast({ tone: 'success', title: 'Link copied. It names the cluster, not how to reach it.' })
  } catch (error) {
    toast({ tone: 'error', title: `Couldn’t copy a link to this: ${(error as Error).message}` })
  }
}

/**
 * The app's menu on Windows and Linux, whose window hides its title bar and with it the menu bar:
 * a button where macOS keeps its traffic lights, in the same place in every view, opening the same
 * menu under it (LMV-133). Alt pressed and released on its own, or F10, opens it too, as a menu
 * bar would.
 */
import { Menu } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { IconButton } from '@renderer/components/Button'
import { api } from '@renderer/lib/api'

/** Whether the window has no menu bar to reach the menu by: Windows' and Linux's. */
export const HAS_MENU_BUTTON = api.host === 'desktop' && api.platform !== 'darwin'

export function AppMenuButton({ className }: { className?: string }) {
  const button = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const show = () => {
    const at = button.current?.getBoundingClientRect()
    if (!at || open) return
    setOpen(true)
    // 4 px under its bottom left corner.
    void api.desktop!.openMenu(at.left, at.bottom + 4).finally(() => setOpen(false))
  }
  useMenuKeys(show)
  return (
    <IconButton
      ref={button}
      label="Menu"
      tip={
        <span className="flex items-center gap-1.5">
          Menu
          <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] bg-surface/20 px-1 font-sans text-[11px] font-medium text-surface">
            Alt
          </kbd>
        </span>
      }
      tipSide="right"
      // Open while the menu is.
      {...(open ? { 'data-state': 'open' } : {})}
      className={className}
      onClick={show}
    >
      <Menu />
    </IconButton>
  )
}

/** Alt on its own (pressed and released, nothing else between), or F10: opens the menu. */
function useMenuKeys(open: () => void) {
  const latest = useRef(open)
  useEffect(() => {
    latest.current = open
  })
  useEffect(() => {
    let alone = false
    const down = (event: KeyboardEvent) => {
      if (event.key === 'Alt') {
        if (!event.repeat) alone = !event.ctrlKey && !event.metaKey && !event.shiftKey
        return
      }
      alone = false
      if (
        event.key === 'F10' &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey
      ) {
        event.preventDefault()
        latest.current()
      }
    }
    const up = (event: KeyboardEvent) => {
      if (event.key === 'Alt' && alone) {
        event.preventDefault()
        latest.current()
      }
      alone = false
    }
    const cancel = () => {
      alone = false
    }
    // Before anything else on the page (a terminal, say) takes the key.
    addEventListener('keydown', down, true)
    addEventListener('keyup', up, true)
    addEventListener('pointerdown', cancel, true)
    addEventListener('blur', cancel)
    return () => {
      removeEventListener('keydown', down, true)
      removeEventListener('keyup', up, true)
      removeEventListener('pointerdown', cancel, true)
      removeEventListener('blur', cancel)
    }
  }, [])
}

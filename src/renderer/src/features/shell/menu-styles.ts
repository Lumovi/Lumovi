export const menuContent =
  'z-50 min-w-48 animate-pop-in rounded-xl border border-line-strong bg-surface-2 p-1 shadow-pop outline-none'

/** Radix menus mark the item under the pointer or keyboard as highlighted; cmdk lists, as selected. */
export const menuItem =
  // A finger's height where it's used with one. And no fill where a finger hasn't pressed: a
  // sheet's chosen item is marked by its check, and what's under a pointer has no meaning there.
  'flex h-8 cursor-default items-center gap-2.5 rounded-lg px-2 text-[13px] text-ink-1 outline-none select-none data-[highlighted]:bg-surface-3 data-[selected=true]:bg-surface-3 touch:h-11 touch:data-[selected=true]:bg-transparent touch:active:bg-surface-3'

/**
 * A list's saved views: a button after its count that names the open one (and says when the list
 * has changed since), and what it opens: this kind's views, to open, rename, move or delete; what
 * the list shows now, saved under a name; and the open view, saved again as it shows now. On a
 * phone the button is a square and what it opens a sheet; the open view is named under the bar.
 */
import { Bookmark, Check, Ellipsis } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { useRef, useState, type ReactNode } from 'react'
import { MARKS_LIMITS, type SavedView } from '@shared/marks'
import { Button, buttonClass } from '@renderer/components/Button'
import { Picker } from '@renderer/components/Picker'
import { useMarks } from '@renderer/hooks/marks'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { useLayout } from '@renderer/lib/layout'
import {
  changingView,
  deletingView,
  movingView,
  renamingView,
  savingView,
  undeletingView,
  viewsOf,
  whyNoMoreViews,
} from '@renderer/lib/marks'
import { toast } from '@renderer/state/toasts'
import { menuContent, menuItem } from '../shell/menu-styles'
import { squareButton } from './ListToolbar'
import { sameView } from './views'

export const SAVE_HINT =
  'Keeps what this list shows now: its filter, health, labels, sort, columns and namespaces.'
/** Said where a server keeps them, each person's own. */
export const KEPT_HERE =
  'Kept for you on this server, so they’re the same in any browser you sign in from.'
const NONE = 'No saved views. Save what this list shows to come back to it.'

/** The view the list was opened as, if it's still saved, and whether the list has changed since. */
export function useOpenView(current: SavedView, name: string | undefined) {
  const { marks } = useMarks()
  const view =
    name === undefined ? undefined : viewsOf(marks, current.kind).find((each) => each.name === name)
  return view && { view, changed: !sameView(view, current) }
}

/** How the open view is said: "Ready" or "Ready · changed". */
export const viewWords = ({ view, changed }: { view: SavedView; changed: boolean }) =>
  changed ? `${view.name} · changed` : view.name

const refused = (title: string) => toast({ tone: 'error', title })

export function ViewsMenu({
  current,
  open: openName,
  kinds,
  onOpen,
  onNamed,
}: {
  /** What the list shows now, as a view (its name aside). */
  current: SavedView
  /** The open view's name, as the address has it. */
  open: string | undefined
  /** The kind's lists, as a refusal says them ("deployments"). */
  kinds: string
  onOpen: (view: SavedView) => void
  /** The list is now the view of this name (saved, or renamed). */
  onNamed: (name: string) => void
}) {
  const { marks, latest, save } = useMarks()
  const phone = useLayout() === 'phone'
  const [shown, setShown] = useState(false)
  // What's being named: a new view, or one renamed (by its name); what was typed, and why not.
  const [naming, setNaming] = useState<{ view?: string; text: string; problem?: string }>()
  const views = viewsOf(marks, current.kind)
  // A rename chosen from a view's "…": its field takes the focus, not the "…" it replaces.
  const renaming = useRef(false)
  const opened = useOpenView(current, openName)
  const full = whyNoMoreViews(marks, current.kind, kinds)

  const show = (next: boolean) => {
    setShown(next)
    if (!next) setNaming(undefined)
  }
  const named = async () => {
    if (!naming) return
    const text = naming.text.trim()
    if (!text) return
    const old = naming.view === undefined ? undefined : views.find((v) => v.name === naming.view)
    const worked = old
      ? renamingView(latest(), old, text, kinds)
      : savingView(latest(), { ...current, name: text }, kinds)
    if ('refused' in worked) return setNaming({ ...naming, problem: worked.refused })
    const why = await save(worked.marks)
    if (why) return setNaming({ ...naming, problem: why })
    setNaming(undefined)
    if (!old || old.name === openName) onNamed(text)
  }
  const saveChanges = async (view: SavedView) => {
    const why = await save(changingView(latest(), { ...current, name: view.name }))
    if (why) refused(why)
  }
  const move = async (view: SavedView, step: -1 | 1) => {
    const why = await save(movingView(latest(), view, step))
    if (why) refused(why)
  }
  const remove = async (view: SavedView) => {
    const { marks: next, at } = deletingView(latest(), view)
    const why = await save(next)
    if (why) return refused(why)
    toast({
      tone: 'success',
      title: `Deleted the view “${view.name}”`,
      action: {
        label: 'Undo',
        run: () => void save(undeletingView(latest(), view, at)).then((no) => no && refused(no)),
      },
    })
  }

  const field = (label: string, button: string) =>
    naming && (
      <form
        className="px-2 py-1.5"
        onSubmit={(event) => {
          event.preventDefault()
          void named()
        }}
      >
        <div className="flex gap-1.5">
          <input
            autoFocus
            aria-label={label}
            placeholder="Name this view"
            maxLength={MARKS_LIMITS.viewName}
            value={naming.text}
            // (Renamed, its name is chosen whole, to type over.)
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) =>
              setNaming({ ...naming, text: event.target.value, problem: undefined })
            }
            aria-invalid={naming.problem !== undefined}
            aria-describedby={naming.problem ? 'view-name-problem' : undefined}
            className="h-8 min-w-0 flex-1 rounded-lg border border-line-strong bg-surface px-2.5 text-[13px] text-ink-1 outline-none placeholder:text-ink-3 focus:border-accent touch:h-11 touch:text-[15px]"
          />
          <Button
            type="submit"
            variant="primary"
            disabled={!naming.text.trim()}
            className="h-8 px-2.5 text-xs touch:h-11"
          >
            {button}
          </Button>
        </div>
        {naming.problem ? (
          <p
            id="view-name-problem"
            role="alert"
            className="mt-1.5 text-xs leading-snug text-critical-text"
          >
            {naming.problem}
          </p>
        ) : (
          naming.view === undefined && (
            <p className="mt-1.5 text-xs leading-snug text-ink-3">{SAVE_HINT}</p>
          )
        )}
      </form>
    )

  const rows: ReactNode = views.map((view, index) =>
    naming?.view === view.name ? (
      <li key={view.name}>{field(`Rename the view “${view.name}”`, 'Rename')}</li>
    ) : (
      <li key={view.name} className="flex items-center gap-0.5">
        <button
          type="button"
          aria-current={view.name === openName ? 'true' : undefined}
          onClick={() => {
            onOpen(view)
            show(false)
          }}
          className={cn(menuItem, 'min-w-0 flex-1 hover:bg-surface-3 focus-visible:bg-surface-3')}
        >
          <Check
            className={cn('size-4 shrink-0 text-accent', view.name !== openName && 'invisible')}
          />
          <span className="truncate">{view.name}</span>
        </button>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            aria-label={`More for the view “${view.name}”`}
            className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-3 hover:bg-surface-3 hover:text-ink-1 data-[state=open]:bg-surface-3 touch:size-11"
          >
            <Ellipsis className="size-4" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={4}
              onCloseAutoFocus={(event) => {
                if (!renaming.current) return
                renaming.current = false
                event.preventDefault()
              }}
              className={cn(menuContent, 'min-w-40')}
            >
              <DropdownMenu.Item
                className={menuItem}
                onSelect={() => {
                  renaming.current = true
                  setNaming({ view: view.name, text: view.name })
                }}
              >
                Rename
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className={cn(menuItem, 'data-[disabled]:opacity-45')}
                disabled={index === 0}
                onSelect={() => void move(view, -1)}
              >
                Move up
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className={cn(menuItem, 'data-[disabled]:opacity-45')}
                disabled={index === views.length - 1}
                onSelect={() => void move(view, 1)}
              >
                Move down
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="mx-1 my-1 h-px bg-line" />
              <DropdownMenu.Item
                className={cn(menuItem, 'text-critical-text data-[highlighted]:bg-critical/10')}
                onSelect={() => void remove(view)}
              >
                Delete
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </li>
    ),
  )

  const said = opened ? viewWords(opened) : 'Views'
  return (
    <Picker
      open={shown}
      onOpenChange={show}
      title="Views"
      // (The open view's name whole, where the bar has cut it.)
      tooltip={opened ? said : undefined}
      className="w-[320px] p-0"
      onEscapeKeyDown={(event) => {
        // Escape in a name being typed lets go of it, not of the menu.
        if (naming) {
          event.preventDefault()
          setNaming(undefined)
        }
      }}
      trigger={
        <button
          type="button"
          aria-label={opened ? `Views: ${said}` : 'Views'}
          className={
            phone
              ? cn(squareButton, opened && 'text-accent-strong')
              : buttonClass('secondary', 'h-7 max-w-[240px] min-w-0 px-2.5 text-xs')
          }
        >
          <Bookmark className={cn(!phone && '!size-3.5', opened && 'fill-current')} />
          {!phone && <span className="truncate">{said}</span>}
        </button>
      }
    >
      {!phone && (
        <div className="flex h-10 items-center border-b border-line px-3 text-[13px] font-semibold text-ink-1">
          Views
        </div>
      )}
      <div className="max-h-80 overflow-y-auto p-1">
        {views.length > 0 ? (
          <ul aria-label="Saved views">{rows}</ul>
        ) : (
          !naming && <p className="px-2 py-2 text-[13px] leading-snug text-ink-3">{NONE}</p>
        )}
      </div>
      <div className="border-t border-line p-1">
        {opened?.changed && (
          <button
            type="button"
            onClick={() => void saveChanges(opened.view)}
            className={cn(menuItem, 'w-full hover:bg-surface-3 focus-visible:bg-surface-3')}
          >
            <span className="truncate">Save changes to “{opened.view.name}”</span>
          </button>
        )}
        {naming && naming.view === undefined ? (
          field('Name this view', 'Save')
        ) : (
          <>
            <button
              type="button"
              disabled={full !== undefined}
              onClick={() => setNaming({ text: '' })}
              className={cn(
                menuItem,
                'w-full hover:bg-surface-3 focus-visible:bg-surface-3 disabled:opacity-45 disabled:hover:bg-transparent',
              )}
            >
              Save view…
            </button>
            {full && <p className="px-2 pt-0.5 pb-1.5 text-xs leading-snug text-ink-3">{full}</p>}
          </>
        )}
      </div>
      {api.host === 'server' && (
        <p className="border-t border-line px-3 py-2 text-xs leading-snug text-ink-3">
          {KEPT_HERE}
        </p>
      )}
    </Picker>
  )
}

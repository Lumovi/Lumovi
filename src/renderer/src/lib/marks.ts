/**
 * What can be done to a cluster's pins and saved views, worked out and never kept here: each
 * gives the pins and views as they'd be, or why not in Lumovi's words. What's taken away says
 * where it was, so an undo puts it back in its place (and a pin, its number).
 */
import {
  MARKS_LIMITS,
  samePin,
  tooManyPins,
  tooManyViews,
  tooManyViewsOfKind,
  type Marks,
  type Pin,
  type SavedView,
} from '@shared/marks'
import type { ResourceKind } from '@shared/resources'

export type Worked = { marks: Marks } | { refused: string }

/**
 * Whether an object of a kind can be pinned: an Event can't, as it's gone within the hour, so
 * nothing offers to pin one (no button, no column, no palette item).
 */
export const pinnable = (kind: string) => kind !== 'Event'

/** Where a pin is among the pins, or -1. */
export const pinAt = (marks: Marks, pin: Pin) => marks.pins.findIndex((each) => samePin(each, pin))

/** Pinned last; `called` names it in a refusal ("Deployment cart"). */
export function pinning(marks: Marks, pin: Pin, called: string): Worked {
  if (pinAt(marks, pin) >= 0) return { marks }
  if (marks.pins.length >= MARKS_LIMITS.pins) return { refused: tooManyPins(called) }
  return { marks: { ...marks, pins: [...marks.pins, pin] } }
}

/** Unpinned, and where it was. */
export function unpinning(marks: Marks, pin: Pin): { marks: Marks; at: number } {
  const at = pinAt(marks, pin)
  return { marks: { ...marks, pins: marks.pins.filter((_, i) => i !== at) }, at }
}

/** Put back where it was (or last, if the pins are fewer now). */
export function repinning(marks: Marks, pin: Pin, at: number): Marks {
  if (pinAt(marks, pin) >= 0) return marks
  const pins = [...marks.pins]
  pins.splice(Math.min(Math.max(at, 0), pins.length), 0, pin)
  return { ...marks, pins }
}

/** A pin moved to another place, the rest keeping their order. */
export function movingPin(marks: Marks, from: number, to: number): Marks {
  if (from === to || from < 0 || from >= marks.pins.length) return marks
  const pins = [...marks.pins]
  const [moved] = pins.splice(from, 1)
  pins.splice(Math.min(Math.max(to, 0), pins.length), 0, moved!)
  return { ...marks, pins }
}

/** A kind's saved views, in their order. */
export const viewsOf = (marks: Marks, kind: ResourceKind) =>
  marks.views.filter((view) => view.kind === kind)

/** Whether one more view of `kind` may be saved, and if not, why (`kinds`: "deployments"). */
export function whyNoMoreViews(marks: Marks, kind: ResourceKind, kinds: string) {
  if (marks.views.length >= MARKS_LIMITS.views) return tooManyViews()
  if (viewsOf(marks, kind).length >= MARKS_LIMITS.viewsOfKind) return tooManyViewsOfKind(kinds)
  return undefined
}

/** Lumovi's words for a name its kind's views already have. */
export const nameTaken = (kinds: string, name: string) =>
  `There’s already a view of ${kinds} called “${name}”.`

/** A new view, last of its kind's: refused at a cap, or where its kind has one of that name. */
export function savingView(marks: Marks, view: SavedView, kinds: string): Worked {
  const name = view.name.trim()
  if (viewsOf(marks, view.kind).some((each) => each.name === name)) {
    return { refused: nameTaken(kinds, name) }
  }
  const why = whyNoMoreViews(marks, view.kind, kinds)
  if (why) return { refused: why }
  return { marks: { ...marks, views: [...marks.views, { ...view, name }] } }
}

/** A view of that name changed to what the list shows now ("Save changes to …"), in its place. */
export function changingView(marks: Marks, view: SavedView): Marks {
  return {
    ...marks,
    views: marks.views.map((each) =>
      each.kind === view.kind && each.name === view.name ? view : each,
    ),
  }
}

/** A view named anew; refused where its kind has a view of that name already. */
export function renamingView(marks: Marks, view: SavedView, name: string, kinds: string): Worked {
  const to = name.trim()
  if (to === view.name) return { marks }
  if (viewsOf(marks, view.kind).some((each) => each.name === to)) {
    return { refused: nameTaken(kinds, to) }
  }
  return {
    marks: {
      ...marks,
      views: marks.views.map((each) =>
        each.kind === view.kind && each.name === view.name ? { ...each, name: to } : each,
      ),
    },
  }
}

/** Deleted, and where it was among all the views. */
export function deletingView(marks: Marks, view: SavedView): { marks: Marks; at: number } {
  const at = marks.views.findIndex((each) => each.kind === view.kind && each.name === view.name)
  return { marks: { ...marks, views: marks.views.filter((_, i) => i !== at) }, at }
}

/** Put back where it was. */
export function undeletingView(marks: Marks, view: SavedView, at: number): Marks {
  if (marks.views.some((each) => each.kind === view.kind && each.name === view.name)) return marks
  const views = [...marks.views]
  views.splice(Math.min(Math.max(at, 0), views.length), 0, view)
  return { ...marks, views }
}

/** A view moved up or down among its own kind's (`step` -1 or 1), the others where they are. */
export function movingView(marks: Marks, view: SavedView, step: -1 | 1): Marks {
  const places = marks.views
    .map((each, i) => (each.kind === view.kind ? i : -1))
    .filter((i) => i >= 0)
  const here = places.findIndex((i) => marks.views[i]!.name === view.name)
  const there = here + step
  if (here < 0 || there < 0 || there >= places.length) return marks
  const views = [...marks.views]
  ;[views[places[here]!], views[places[there]!]] = [views[places[there]!]!, views[places[here]!]!]
  return { ...marks, views }
}

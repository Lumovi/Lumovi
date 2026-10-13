/**
 * Who gets the height in Lumovi's dialog for a change a plugin's page proposed, where it doesn't
 * all fit: a long change never squeezes the plugin's options, and a long form never hides the
 * change. Three boxes share what the dialog's caption, verdict and buttons leave: the options (the
 * plugin's fields), the change (what Lumovi will send) and its equivalent command.
 *
 * - The options get the height first, up to their whole height.
 * - Then the change's box, up to its own length, and never under its floor (three rows of the
 *   change a person can read: the dialog says so).
 * - Then the command's box, from its floor of two lines to its most.
 * - Where the options would still have less than two fields' height, the command folds to its
 *   heading's row, unless the person opened it; only then do the options scroll.
 *
 * A function of what the boxes would take with all the room there is, and of nothing as it's laid
 * out now: asked again once its answer is applied, it answers the same.
 */

/** What the three boxes would take, and what they have to share. All in pixels. */
export interface Heights {
  /** What the dialog can give the three boxes: its most, less everything that never scrolls. */
  room: number
  /** The options, whole: nothing where the change asks for none. */
  options: number
  /** The change's lines, whole; and how much of them is its floor. */
  change: number
  changeFloor: number
  /** The command, whole; and its floor. */
  command: number
  commandFloor: number
  /** The person opened the command where it was folded. */
  opened: boolean
}

export interface Shared {
  options: number
  change: number
  command: number
  /** The height is short: the command folds, and can be opened by hand. */
  tight: boolean
  /** The command is folded to its heading's row. */
  folded: boolean
}

/** Less than this of the options showing (two fields' height) folds the command. */
export const OPTIONS_ENOUGH = 190
/** The most the command's box takes, however long the command. */
export const COMMAND_MOST = 96

/**
 * Each box's height; or nothing, where what it's given can't be laid out by the rule (a height
 * that isn't a number, or less room than the change's floor): the dialog then keeps the heights
 * it has by itself, and nothing is folded or said to be cut.
 */
export function share(natural: Heights): Shared | undefined {
  const { room, options, change, command, opened } = natural
  const given = [room, options, change, natural.changeFloor, command, natural.commandFloor]
  if (!given.every((height) => Number.isFinite(height) && height >= 0)) return undefined
  const changeFloor = Math.min(change, natural.changeFloor)
  const commandFloor = Math.min(command, natural.commandFloor)
  if (room < changeFloor) return undefined
  const optionsBeside = (kept: number) => Math.max(0, Math.min(options, room - changeFloor - kept))
  const tight =
    command > 0 &&
    (optionsBeside(commandFloor) < Math.min(options, OPTIONS_ENOUGH) ||
      room < changeFloor + commandFloor)
  const folded = tight && !opened
  // (Opened by hand where even its floor doesn't fit beside the change's: what there is.)
  const commandLeast = folded ? 0 : Math.min(commandFloor, room - changeFloor)
  const optionsHeight = optionsBeside(commandLeast)
  const changeHeight = Math.max(changeFloor, Math.min(change, room - optionsHeight - commandLeast))
  const commandHeight = folded
    ? 0
    : Math.max(commandLeast, Math.min(command, COMMAND_MOST, room - optionsHeight - changeHeight))
  return { options: optionsHeight, change: changeHeight, command: commandHeight, tight, folded }
}

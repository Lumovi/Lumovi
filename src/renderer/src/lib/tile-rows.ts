/**
 * A row of tiles as Lumovi's own pages lay one out, by the width of what holds it (an
 * `@container`): two across, and all of them, three or four, only where that gives each about
 * 180 px (four at `@3xl`, as the Metrics page's row goes to four). Three that can't stand two
 * and one, the last taking the width. Narrower than `@xs` (320 px: a page beside a row's panel at
 * 1024), two would leave each too little for its label and line, so they stand one across. So a
 * row never draws its tiles too narrow to say anything.
 */
export const TILE_ROW = {
  2: 'grid-cols-1 @xs:grid-cols-2',
  3: 'grid-cols-1 @xs:grid-cols-2 @xl:grid-cols-3',
  4: 'grid-cols-1 @xs:grid-cols-2 @3xl:grid-cols-4',
} as const

/** A tile's own place in its row: the last of three, while they stand two and one, is wide. */
export const tileSpan = (index: number, count: number): string | undefined =>
  count === 3 && index === 2 ? '@xs:col-span-2 @xl:col-span-1' : undefined

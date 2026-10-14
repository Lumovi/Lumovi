/**
 * Turns captures into the files kept in docs/screenshots: WebP at the size
 * captured (2×, lossless) and at half that (1×, near-lossless).
 */
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'

export type Theme = 'light' | 'dark'

/** The width of a screen, in CSS pixels; the files are 2× and 1× of it. */
export const WIDTH = 1440
export const HEIGHT = 900

/** A screen's size, in CSS pixels. */
export interface Size {
  width: number
  height: number
}
/** A phone's, held upright (the size of a common one's page). */
export const PHONE: Size = { width: 390, height: 844 }
/** A screen's size: a phone's, or a desktop's. */
export const sizeOf = (screen: { phone?: boolean }): Size =>
  screen.phone ? PHONE : { width: WIDTH, height: HEIGHT }

/** The files of a screenshot, in a theme: 2× and 1×. */
export const filesOf = (name: string, theme: Theme) => ({
  '2x': `${name}-${theme}.webp`,
  '1x': `${name}-${theme}-1x.webp`,
})

/** Fails unless a capture is 2× the screen's `size`: anything else would be kept stretched. */
export async function sizeCheck(capture: Buffer, size: Size): Promise<void> {
  const { width, height } = await sharp(capture).metadata()
  if (width !== size.width * 2 || height !== size.height * 2) {
    throw new Error(`Captured at ${width} × ${height}, not ${size.width * 2} × ${size.height * 2}`)
  }
}

/** An image's pixels, to compare. */
export const pixelsOf = (image: Buffer | string) => sharp(image).removeAlpha().raw().toBuffer()

/** The pixels of the screenshot kept as `name` in `theme`, if there is one. */
export const kept = (dir: string, name: string, theme: Theme) => {
  const file = join(dir, filesOf(name, theme)['2x'])
  return existsSync(file) ? pixelsOf(file) : undefined
}

/** Differences this small are how drawing varies a shade from one time to the next. */
const SHADE = 4

/** Whether two images look the same, up to a shade. */
export function same(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > SHADE) return false
  return true
}

/** Keeps a capture (a 2× PNG of a screen `size`) as the screenshot `name` in `theme`. */
export async function keep(dir: string, name: string, theme: Theme, capture: Buffer, size: Size) {
  const files = filesOf(name, theme)
  await Promise.all([
    // Lossless: text stays sharp, and it's as small as lossy would be at a quality that kept it so.
    sharp(capture).webp({ lossless: true, effort: 6 }).toFile(join(dir, files['2x'])),
    // A plain linear filter, much as if drawn at 1× (sharper ones ring around text, and
    // compress worse); near-lossless takes off a further quarter.
    sharp(capture)
      .resize(size.width, size.height, { kernel: 'linear' })
      .webp({ nearLossless: true, quality: 60, effort: 6 })
      .toFile(join(dir, files['1x'])),
  ])
}

/** Screenshots in `dir` that none of `names` are: left over from screenshots since removed. */
export function leftOver(dir: string, names: string[]): string[] {
  const expected = new Set(
    names.flatMap((name) =>
      (['light', 'dark'] as const).flatMap((theme) => Object.values(filesOf(name, theme))),
    ),
  )
  return readdirSync(dir).filter((file) => /\.(webp|png)$/.test(file) && !expected.has(file))
}

export function remove(dir: string, files: string[]): void {
  for (const file of files) rmSync(join(dir, file))
}

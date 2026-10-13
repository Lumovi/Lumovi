/**
 * Where something is drawn, measured once it's in view: measured sooner, a menu or a popover is
 * where it opened (out of view, until it's placed), and a slow machine measures it there.
 */
import { expect, type Locator } from '@playwright/test'

export async function placed(locator: Locator) {
  await expect(locator).toBeInViewport()
  // eslint-disable-next-line no-restricted-syntax -- measured once it's in view, above.
  return (await locator.boundingBox())!
}

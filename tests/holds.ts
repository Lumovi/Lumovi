/**
 * That something stays so for `ms`: checked again and again until then, and failed the first
 * time it isn't. For what must not happen (a menu stays shut, a page isn't left, nothing is
 * written): a fixed wait before one check proves less, and is what the lint rule refuses.
 */
import { expect } from '@playwright/test'

export async function holds(
  check: () => boolean | Promise<boolean>,
  ms: number,
  what: string,
): Promise<void> {
  const until = Date.now() + ms
  do {
    expect(await check(), what).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 25))
  } while (Date.now() < until)
  expect(await check(), what).toBe(true)
}

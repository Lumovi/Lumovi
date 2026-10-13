/**
 * What a box's document is served with, as the security model says it, on the desktop and on a
 * server alike: whatever of that a response's headers miss, said one line each. And, in
 * Chromium, what a box's page is given of the features a page can be.
 */
import type { Frame } from '@playwright/test'
import { BOX_FEATURES_OFF } from '../../../src/shared/plugin-box.ts'

export function unsealed(headers: Headers, script: string, page: string): string[] {
  const missing: string[] = []
  const policy = new Map(
    (headers.get('content-security-policy') ?? '')
      .split(';')
      .map((directive) => directive.trim().split(/\s+/))
      .filter(([name]) => name)
      .map(([name, ...values]) => [name!, values] as const),
  )
  const says = (name: string, ...values: string[]) => {
    if (JSON.stringify(policy.get(name)) !== JSON.stringify(values)) {
      missing.push(`${name} is ${JSON.stringify(policy.get(name))}, not ${values.join(' ')}`)
    }
  }
  // Sealed by its own answer: an origin that's nobody's, wherever it's opened.
  says('sandbox', 'allow-scripts')
  says('default-src', "'none'")
  // Its own script by address; a worker from text alone, and text nowhere else.
  says('script-src', script)
  says('worker-src', 'blob:')
  says('frame-ancestors', page)
  // (The two that don't fall back to default-src: there, or nothing holds them.)
  says('form-action', "'none'")
  says('base-uri', "'none'")
  for (const [name, values] of policy) {
    if (['sandbox', 'script-src', 'worker-src', 'frame-ancestors'].includes(name)) continue
    if (JSON.stringify(values) !== `["'none'"]`) missing.push(`${name} is ${values.join(' ')}`)
  }
  for (const word of ["'unsafe-eval'", "'wasm-unsafe-eval'", "'unsafe-inline'", '*', 'data:']) {
    if ([...policy.values()].some((values) => values.includes(word))) {
      missing.push(`the policy holds ${word}`)
    }
  }
  // Every feature off, and none given to anyone.
  const features = new Map(
    (headers.get('permissions-policy') ?? '')
      .split(',')
      .map((feature) => feature.trim().split('='))
      .map(([name, allow]) => [name!, allow] as const),
  )
  for (const feature of BOX_FEATURES_OFF) {
    if (features.get(feature) !== '()') missing.push(`${feature} isn’t turned off`)
  }
  for (const [feature, allow] of features) {
    if (allow !== '()') missing.push(`${feature} is given to ${allow}`)
  }
  if (headers.get('x-content-type-options') !== 'nosniff') missing.push('it may be sniffed')
  if (headers.get('cache-control') !== 'no-store') missing.push('it may be kept')
  if (headers.get('set-cookie') !== null) missing.push('it sets a cookie')
  return missing
}

/**
 * In Chromium, from inside a box's frame: the features its page is given (none, by the box's
 * policy, not by a browser's default), and those Chromium knows that the box's list doesn't name.
 */
export async function featuresOf(box: Frame): Promise<{ given: string[]; unnamed: string[] }> {
  const { given, known } = await box.evaluate(() => {
    const policy = (
      document as unknown as {
        featurePolicy: { allowedFeatures(): string[]; features(): string[] }
      }
    ).featurePolicy
    return { given: policy.allowedFeatures(), known: policy.features() }
  })
  const named: readonly string[] = BOX_FEATURES_OFF
  return { given, unnamed: known.filter((feature) => !named.includes(feature)) }
}

/**
 * Parsing for Kubernetes resource quantities ("250m", "1.5Gi", "3e3"...).
 * See https://kubernetes.io/docs/reference/kubernetes-api/common-definitions/quantity/
 */

const SUFFIX_MULTIPLIERS: Record<string, number> = {
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  '': 1,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
  Ki: 2 ** 10,
  Mi: 2 ** 20,
  Gi: 2 ** 30,
  Ti: 2 ** 40,
  Pi: 2 ** 50,
  Ei: 2 ** 60,
}

const QUANTITY = /^([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)([a-zA-Z]*)$/

/** Converts a quantity to its base unit (cores for CPU, bytes for memory). Returns 0 for invalid input. */
export function parseQuantity(value: string | undefined): number {
  const match = QUANTITY.exec(String(value ?? '').trim())
  const multiplier = match ? SUFFIX_MULTIPLIERS[match[2]!] : undefined
  return multiplier === undefined ? 0 : Number(match![1]) * multiplier
}

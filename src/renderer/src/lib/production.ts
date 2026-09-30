const PRODUCTION = /(^|[^a-z])(prod|production|prd|live)([^a-z]|$)/i

/** Whether a context's name suggests production, where changes get an extra confirmation. */
export function looksLikeProduction(context: string): boolean {
  return PRODUCTION.test(context)
}

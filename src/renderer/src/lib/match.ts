/**
 * Command-list matching: every typed word must appear in the item's value.
 * Predictable where fuzzy matching surprises (e.g. "dep" matching "data").
 */
export function matchWords(value: string, search: string): number {
  const haystack = value.toLowerCase()
  return search
    .toLowerCase()
    .split(/\s+/)
    .every((term) => haystack.includes(term))
    ? 1
    : 0
}

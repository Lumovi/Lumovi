/**
 * What a header's fit is measured by, as one key: its name, its status's word, and its buttons'
 * names as they're drawn. Each is a plugin's text, which can hold anything (a line's end among
 * it), so the key is JSON: it reads back exactly what went in.
 */
export const fitKey = (name: string, word: string, labels: readonly string[]): string =>
  JSON.stringify([name, word, labels])

/** A fit key's parts again. */
export function fromFitKey(key: string): { name: string; word: string; labels: string[] } {
  const [name, word, labels] = JSON.parse(key) as [string, string, string[]]
  return { name, word, labels }
}

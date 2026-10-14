/**
 * A value written into code Lumovi makes as text (a box's worker, a test's page): as JSON, with
 * what could end a script around it (`<`, `>`) or a line inside it (U+2028, U+2029) written as
 * escapes. The code reads the same value.
 */
export function literal(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

import type { ReactNode } from 'react'

/**
 * A command's text, for a box that keeps its spaces and lines (`whitespace-pre-wrap`): it breaks
 * only between its words, each word whole on its line ("--replicas=5" is never cut after its
 * "--"), and a word longer than the whole line still wraps. Its text is the command's own,
 * character for character, so what a person selects and copies is the command.
 */
export function CommandWords({ text }: { text: string }): ReactNode {
  return text.split(/( +|\n)/).map((part, i) =>
    part === '' || part === '\n' || part.trim() === '' ? (
      part
    ) : (
      <span key={i} className="inline-block max-w-full [overflow-wrap:anywhere]">
        {part}
      </span>
    ),
  )
}

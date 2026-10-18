/**
 * What's typed into Search (LMV-171): words, each a part of a name in any case; and labels,
 * `key=value`, `key!=value`, `key=*` (has it, any value) and `!key` (doesn't have it). Every
 * term must match.
 */
import type { SearchItem } from '@shared/api'

export type LabelTerm =
  { key: string; op: '=' | '!='; value: string } | { key: string; op: 'has' | 'lacks' }

export interface Terms {
  words: string[]
  labels: LabelTerm[]
  /** The labels as a selector the cluster takes ("app=web,team,!canary"), or empty. */
  selector: string
}

/** A label's key and value as Kubernetes allows them (a prefix, a name; a value). */
const KEY = /^([a-z0-9]([-a-z0-9.]*[a-z0-9])?\/)?[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/
const VALUE = /^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$/

export function termsOf(text: string): Terms {
  const words: string[] = []
  const labels: LabelTerm[] = []
  for (const term of text.trim().split(/\s+/).filter(Boolean)) {
    const pair = /^([^=!]+)(!=|=)(.*)$/.exec(term)
    if (pair && KEY.test(pair[1]!) && (pair[3] === '*' ? pair[2] === '=' : VALUE.test(pair[3]!))) {
      labels.push(
        pair[3] === '*'
          ? { key: pair[1]!, op: 'has' }
          : { key: pair[1]!, op: pair[2] as '=' | '!=', value: pair[3]! },
      )
    } else if (term.startsWith('!') && KEY.test(term.slice(1))) {
      labels.push({ key: term.slice(1), op: 'lacks' })
    } else words.push(term.toLowerCase())
  }
  const selector = labels
    .map((label) =>
      'value' in label
        ? `${label.key}${label.op}${label.value}`
        : `${label.op === 'lacks' ? '!' : ''}${label.key}`,
    )
    .join(',')
  return { words, labels, selector }
}

/** Whether an object's labels are as the terms ask. */
export function labelsMatch(labels: Record<string, string> = {}, terms: LabelTerm[]): boolean {
  return terms.every((term) => {
    const value = Object.hasOwn(labels, term.key) ? labels[term.key] : undefined
    switch (term.op) {
      case 'has':
        return value !== undefined
      case 'lacks':
        return value === undefined
      case '=':
        return value === term.value
      case '!=':
        return value !== term.value
    }
  })
}

/** How well a name matches: 0 is what was typed, 1 starts with it, 2 has it; none, it doesn't. */
export function nameRank(name: string, words: string[]): number | undefined {
  const lower = name.toLowerCase()
  if (!words.every((word) => lower.includes(word))) return undefined
  if (words.length === 1 && lower === words[0]) return 0
  return words.length > 0 && lower.startsWith(words[0]!) ? 1 : 2
}

/** The objects that match, best first (as typed, starts with it, has it), then by name. */
export function matching(items: SearchItem[], terms: Terms): SearchItem[] {
  const ranked: [SearchItem, number][] = []
  for (const item of items) {
    const rank = nameRank(item.name, terms.words)
    if (rank !== undefined && labelsMatch(item.labels, terms.labels)) ranked.push([item, rank])
  }
  return ranked
    .sort(([a, x], [b, y]) => x - y || a.name.localeCompare(b.name))
    .map(([item]) => item)
}

/** Of an object's labels, those the terms name (what a label search shows in its row). */
export const matchedLabels = (labels: Record<string, string> = {}, terms: LabelTerm[]) =>
  terms
    .filter((term) => term.op !== 'lacks' && Object.hasOwn(labels, term.key))
    .map((term) => `${term.key}=${labels[term.key]}`)

/** Whether anything was typed that searches. */
export const searches = (terms: Terms) => terms.words.length > 0 || terms.labels.length > 0

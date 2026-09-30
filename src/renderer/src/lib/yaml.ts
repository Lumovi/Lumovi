import { stringify } from 'yaml'

export function toYaml(value: unknown): string {
  return stringify(value, { lineWidth: 0, aliasDuplicateObjects: false })
}

export type YamlTokenType = 'key' | 'string' | 'number' | 'literal' | 'punct' | 'plain'

export interface YamlToken {
  type: YamlTokenType
  text: string
}

const LINE = /^(\s*)(- )?(?:([^\s:#][^:#]*?|"[^"]*")(:)(?=\s|$))?(\s*)(.*)$/
const LITERAL = /^(true|false|null|~)$/
const NUMBER = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/

function valueType(value: string): YamlTokenType {
  if (LITERAL.test(value)) return 'literal'
  if (NUMBER.test(value)) return 'number'
  if (/^["'|>]/.test(value)) return 'string'
  return 'plain'
}

/** A small line tokenizer for the YAML emitted by `toYaml`: enough for syntax colouring. */
export function tokenizeYamlLine(line: string): YamlToken[] {
  const [, indent, dash, key, colon, gap, value] = LINE.exec(line)!
  const tokens: YamlToken[] = [{ type: 'plain', text: indent! }]
  if (dash) tokens.push({ type: 'punct', text: dash })
  if (key) tokens.push({ type: 'key', text: key }, { type: 'punct', text: colon! })
  tokens.push({ type: 'plain', text: gap! }, { type: valueType(value!), text: value! })
  return tokens
}

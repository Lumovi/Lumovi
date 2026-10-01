import { cn } from '@renderer/lib/cn'
import { tokenizeYamlLine, type YamlTokenType } from '@renderer/lib/yaml'

const TOKEN_CLASS: Record<YamlTokenType, string> = {
  key: 'text-accent-strong',
  string: 'text-good-text',
  number: 'text-serious-text',
  literal: 'text-serious-text',
  punct: 'text-ink-3',
  plain: 'text-ink-1',
}

/** YAML, highlighted, with line numbers. */
export function YamlText({ text, label }: { text: string; label: string }) {
  const lines = text.trimEnd().split('\n')
  return (
    <pre
      aria-label={label}
      className="min-h-0 flex-1 overflow-auto bg-surface-2/60 py-3 font-mono text-[12px] leading-[1.7] select-text selectable"
    >
      <code className="grid grid-cols-[auto_1fr]">
        {lines.map((line, index) => (
          <span key={index} className="contents">
            <span className="pr-4 pl-5 text-right text-ink-3/60 select-none">{index + 1}</span>
            <span className="pr-5 whitespace-pre">
              {tokenizeYamlLine(line).map((token, i) => (
                <span key={i} className={cn(TOKEN_CLASS[token.type])}>
                  {token.text}
                </span>
              ))}
            </span>
          </span>
        ))}
      </code>
    </pre>
  )
}

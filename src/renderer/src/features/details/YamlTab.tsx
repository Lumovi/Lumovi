import { Eye, EyeOff } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { KubeObject } from '@shared/api'
import { Button } from '@renderer/components/Button'
import { CopyButton } from '@renderer/components/CopyButton'
import { cn } from '@renderer/lib/cn'
import { toYaml, tokenizeYamlLine, type YamlTokenType } from '@renderer/lib/yaml'

const TOKEN_CLASS: Record<YamlTokenType, string> = {
  key: 'text-accent-strong',
  string: 'text-good-text',
  number: 'text-serious-text',
  literal: 'text-serious-text',
  punct: 'text-ink-3',
  plain: 'text-ink-1',
}

export const MASK = '••••••••'

/** Secret values stay hidden until the user asks to see them. */
export function maskSecret(secret: KubeObject): KubeObject {
  const data = Object.fromEntries(
    Object.keys((secret.data as object | undefined) ?? {}).map((key) => [key, MASK]),
  )
  return { ...secret, data }
}

export function YamlTab({ object }: { object: KubeObject }) {
  const isSecret = object.kind === 'Secret'
  const [revealed, setRevealed] = useState(false)
  const yaml = useMemo(
    () => toYaml(isSecret && !revealed ? maskSecret(object) : object),
    [object, isSecret, revealed],
  )
  const lines = yaml.trimEnd().split('\n')

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-5 py-2">
        <span className="flex-1 text-xs text-ink-3">{lines.length} lines · read-only</span>
        {isSecret && (
          <Button variant="ghost" onClick={() => setRevealed(!revealed)}>
            {revealed ? <EyeOff /> : <Eye />}
            {revealed ? 'Hide values' : 'Reveal values'}
          </Button>
        )}
        <CopyButton text={yaml} label="Copy YAML" />
      </div>
      <pre
        aria-label="YAML"
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
    </div>
  )
}

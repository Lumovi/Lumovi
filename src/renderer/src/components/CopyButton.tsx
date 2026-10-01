import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { IconButton } from './Button'

/** Copies `text`; pass a function for text that's costly to put together until it's wanted. */
export function CopyButton({ text, label }: { text: string | (() => string); label: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(typeof text === 'function' ? text() : text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <IconButton label={copied ? 'Copied' : label} onClick={copy}>
      {copied ? <Check className="text-good-text" /> : <Copy />}
    </IconButton>
  )
}

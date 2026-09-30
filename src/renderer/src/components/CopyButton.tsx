import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { IconButton } from './Button'

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <IconButton label={copied ? 'Copied' : label} onClick={copy}>
      {copied ? <Check className="text-good-text" /> : <Copy />}
    </IconButton>
  )
}

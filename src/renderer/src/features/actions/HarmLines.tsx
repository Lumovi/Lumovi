import type { Harm } from '@shared/plugins'
import { TheirText } from '@renderer/plugins/TheirText'

/**
 * What a file's action harms, in red: its file's words for each harm what it sends holds, once
 * each, as a proposal's dialog draws them. Lumovi's, whatever the plugin's code says.
 */
export function HarmLines({ harms }: { harms: readonly Harm[] }) {
  if (harms.length === 0) return null
  return (
    <section aria-label="What it harms">
      <p className="mb-1.5 text-2xs font-medium tracking-wider text-critical-text uppercase">
        What it harms
      </p>
      <ul className="space-y-1.5 text-xs [overflow-wrap:anywhere]">
        {harms.map((harm) => (
          <li key={harm.path} className="text-critical-text">
            <TheirText text={{ their: harm.says }} inline />
          </li>
        ))}
      </ul>
    </section>
  )
}

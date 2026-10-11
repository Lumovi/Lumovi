/**
 * What's Lumovi's round a plugin's page, and never the plugin's: the strip that says whose the
 * page is, and what stands in the page's place once it has ended. Both are outside what a
 * plugin's code describes: nothing it sends can draw here, cover this or scroll it away.
 */
import { Plug } from 'lucide-react'
import { Component, useState, type ReactNode } from 'react'
import { endedWords, type PageEnd } from '@shared/plugin-ended'
import { Button } from '@renderer/components/Button'
import { TheirText } from './TheirText'

/** The strip above a plugin's page: whose it is. It stays while the page scrolls under it. */
export function WhoseStrip({ name, version }: { name: string; version: string }) {
  return (
    <div
      data-testid="plugin-whose"
      className="flex min-h-9 shrink-0 items-center gap-2 border-b border-line bg-surface-2 py-1.5 pr-2 pl-4 text-[12px] leading-[18px] text-ink-2"
    >
      <Plug className="size-3.5 shrink-0 text-ink-3" aria-hidden />
      {/* (A long name wraps; it's never cut.) */}
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        <span className="phone:hidden">This page is from the plugin </span>
        <span className="hidden phone:inline">From the plugin </span>
        <b className="font-semibold text-ink-1">{name}</b> {version}
        <span className="phone:hidden">
          . Lumovi draws it from its own parts; what it shows and says is the plugin’s.
        </span>
      </span>
    </div>
  )
}

/**
 * The place of a plugin's page that has ended: who ended it and why, calmly, as the app's own
 * empty state. Nothing of the page is left under it.
 */
export function EndedPage({
  name,
  end,
  onAgain,
}: {
  name: string
  end: PageEnd
  /** The person's own press, never a retry of Lumovi's. */
  onAgain: () => void
}) {
  const words = endedWords(name, end)
  return (
    <div
      data-testid="plugin-ended"
      data-why={end.why}
      className="mx-auto flex max-w-sm flex-col items-center px-6 py-10 text-center phone:px-4 phone:py-7"
    >
      <div className="mb-4 grid size-11 place-items-center rounded-2xl border border-line bg-surface-3 text-ink-2">
        <Plug className="size-5" aria-hidden />
      </div>
      <h3 className="text-[14px] leading-5 font-semibold [overflow-wrap:anywhere] text-ink-1">
        {words.title}
      </h3>
      {words.why && (
        <p className="mt-1.5 text-[13px] leading-5 text-balance text-ink-2">{words.why}</p>
      )}
      {words.said && (
        <div className="mt-2.5 w-full rounded-[10px] border border-dashed border-line-strong text-left">
          <div className="px-3 pt-1.5 text-[11px] font-medium tracking-wider [overflow-wrap:anywhere] text-ink-3 uppercase">
            {name} said
          </div>
          {/* The plugin's own words: text and nothing else, never a link, never a part of Lumovi's. */}
          <TheirText
            pieces={words.said}
            lines
            className="px-3 pt-1 pb-2.5 font-mono text-[12px] leading-[18px] text-ink-2"
          />
        </div>
      )}
      <p className="mt-3 text-[12px] leading-[18px] text-balance text-ink-3">{words.still}</p>
      {words.advice && (
        <p className="mt-1.5 text-[12px] leading-[18px] text-ink-3">{words.advice}</p>
      )}
      {words.again && (
        <Button className="mt-4" onClick={onAgain}>
          Open it again
        </Button>
      )}
    </div>
  )
}

/**
 * A plugin's page in its frame: the strip, and under it the page as Lumovi draws it, or what
 * stands in its place once it has ended. A part of Lumovi's own that fails as it draws takes
 * the plugin's page with it and nothing else, and is said as Lumovi's fault.
 */
export function PluginFrame({
  name,
  version,
  end,
  onAgain,
  onFault,
  children,
}: {
  name: string
  version: string
  /** Why the page ended, once it has. */
  end?: PageEnd
  /** Opens the page again: on the person's press. */
  onAgain: () => void
  /**
   * A part of Lumovi's failed as it drew the page: whoever holds the page ends it (its box and
   * its worker with it). The picture alone going would leave a plugin's code running unseen.
   */
  onFault: () => void
  children: ReactNode
}) {
  // (A boundary that caught something stays so until it's made anew.)
  const [opened, setOpened] = useState(0)
  const again = () => {
    setOpened((n) => n + 1)
    onAgain()
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <WhoseStrip name={name} version={version} />
      <div className="min-h-0 flex-1 overflow-auto">
        {end ? (
          <EndedPage name={name} end={end} onAgain={again} />
        ) : (
          <Boundary
            key={opened}
            onFault={onFault}
            fallback={<EndedPage name={name} end={{ why: 'drawing' }} onAgain={again} />}
          >
            {children}
          </Boundary>
        )}
      </div>
    </div>
  )
}

/** Round a plugin's whole surface: what fails inside it is said in its place, and told. */
class Boundary extends Component<
  { fallback: ReactNode; onFault: () => void; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  override componentDidCatch() {
    this.props.onFault()
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

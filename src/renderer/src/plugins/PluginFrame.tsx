/**
 * What's Lumovi's round a plugin's page, and never the plugin's: the strip that says whose the
 * page is, what Lumovi says of the page's reads (one failing, a list cut at Lumovi's limit), and
 * what stands in the page's place once it has ended. All are outside what a plugin's code
 * describes: nothing it sends can draw here, cover this or scroll it away.
 */
import { Info, Plug } from 'lucide-react'
import { Component, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { endedWords, type PageEnd } from '@shared/plugin-ended'
import { SWITCHED_OFF } from '@shared/plugin-hand-over'
import { Button } from '@renderer/components/Button'
import { StaleNotice } from '@renderer/components/States'
import type { ReadNotices } from './reads'
import { TheirText } from './TheirText'

const count = (value: number) => value.toLocaleString('en-US')

/**
 * What Lumovi says of a page some of whose reads were cut at its limit, in its own words: of how
 * many, where one read was and the cluster said.
 */
export function cutWords(cut: NonNullable<ReadNotices['cut']>): string {
  const of = !cut.several && cut.of !== undefined ? ` of ${count(cut.of)}` : ''
  return `Some of what this page shows is from the first ${count(cut.at)}${of} of a list: the cluster has more than Lumovi reads at once.`
}

/** Lumovi's line under the strip while any read of the page is cut, as a list's own line is. */
function CutLine({ cut }: { cut: NonNullable<ReadNotices['cut']> }) {
  return (
    <p
      role="note"
      data-testid="plugin-cut"
      className="flex shrink-0 items-center gap-2 border-b border-line bg-surface-2 px-5 py-1.5 text-xs text-ink-2"
    >
      <Info className="size-3.5 shrink-0 text-ink-3" aria-hidden />
      <span className="min-w-0 flex-1">{cutWords(cut)}</span>
    </p>
  )
}

/**
 * The strip above a plugin's page: whose it is, and (where it's given `asks`) the way to what it
 * may do, its entry on the Plugins page. It stays while the page scrolls under it.
 */
export function WhoseStrip({
  name,
  version,
  asks,
}: {
  name: string
  version: string
  asks?: string
}) {
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
      {asks !== undefined && (
        <Link
          to={asks}
          className="flex shrink-0 items-center rounded-md px-1.5 font-medium whitespace-nowrap text-ink-1 outline-none hover:bg-surface-3 focus-visible:bg-surface-3 phone:h-11"
        >
          What it may do →
        </Link>
      )}
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
  plugins,
}: {
  name: string
  end: PageEnd
  /** The person's own press, never a retry of Lumovi's. */
  onAgain: () => void
  /** The way to the plugin's switch on the Plugins page, where its code is off by the person's. */
  plugins?: string
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
      {words.still && (
        <p className="mt-3 text-[12px] leading-[18px] text-balance text-ink-3">{words.still}</p>
      )}
      {words.toPlugins && plugins !== undefined && (
        <Link
          to={plugins}
          className="mt-4 inline-flex h-8 items-center rounded-lg border border-line-strong bg-surface px-3 text-[13px] font-medium text-ink-1 outline-none hover:bg-surface-3 focus-visible:ring-3 focus-visible:ring-accent-soft phone:h-11"
        >
          Open Plugins
        </Link>
      )}
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
  notices = {},
  onRetry = () => undefined,
  onAgain,
  onFault,
  asks,
  plugins,
  children,
}: {
  name: string
  version: string
  /** Why the page ended, once it has. */
  end?: PageEnd
  /** What Lumovi says of the page's reads: decided from its own answers, never the plugin's. */
  notices?: ReadNotices
  /** The person's "Retry" of the reads that are failing. */
  onRetry?: () => void
  /** Opens the page again: on the person's press. */
  onAgain: () => void
  /**
   * A part of Lumovi's failed as it drew the page: whoever holds the page ends it (its box and
   * its worker with it). The picture alone going would leave a plugin's code running unseen.
   */
  onFault: () => void
  /** Where the strip's "What it may do" goes: the plugin's entry on the Plugins page. */
  asks?: string
  /** The way to its switch on the Plugins page, for a page whose code the person turned off. */
  plugins?: string
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
      {/* (Turned off: nothing of the plugin is drawn, so nothing is said to be its.) */}
      {!(end?.why === 'not-handed' && SWITCHED_OFF.has(end.refused)) && (
        <WhoseStrip name={name} version={version} {...(asks === undefined ? {} : { asks })} />
      )}
      {!end && notices.stale !== undefined && (
        <StaleNotice error={{ message: notices.stale }} onRetry={onRetry} />
      )}
      {!end && notices.cut && <CutLine cut={notices.cut} />}
      <div className="min-h-0 flex-1 overflow-auto">
        {end ? (
          <EndedPage
            name={name}
            end={end}
            onAgain={again}
            {...(plugins === undefined ? {} : { plugins })}
          />
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

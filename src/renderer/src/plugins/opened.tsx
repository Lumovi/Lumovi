/**
 * A plugin's page, opened for as long as it's shown: its code as Lumovi hands it over (or why
 * not), its box and the door, and what Lumovi draws round it. Opening it again makes this anew.
 * Lumovi's own pages of a plugin (`PluginBody`) open one here, and so does the tests' stage.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { ObjectRef, Reach } from '@shared/kit/declare'
import type { PageProposal, ProposalOutcome } from '@shared/plugin-changes'
import type { PluginCode } from '@shared/plugin-hand-over'
import type { Destination } from '@shared/plugin-presses'
import { codeOf } from './box-check'
import { openPage, type KitPart, type OpenPage } from './page'
import { PluginFrame } from './PluginFrame'
import { PluginSurface } from './Surface'

/** Set by the build: true only in the build the tests run. */
declare const LUMOVI_TEST_BUILD: boolean

/** A plugin's page, as it's to be opened. */
export interface Opening {
  /** The plugin's name as its box is addressed, and as a person reads it. */
  plugin: string
  name: string
  version: string
  /** One of the person's own, from their own folder (Developer mode): its strip says so. */
  yours?: boolean
  /** The cluster its reads are made in (none, and each is refused). */
  context: string
  /**
   * The tests' own code, taken in the tests' build alone: anywhere else a plugin's code comes
   * only as Lumovi hands it over, whoever opens its page.
   */
  code?: string
  /** What its code is told first: which page, or which tab and the object it's on. */
  opening?: { page: string } | { tab: string; object: ObjectRef }
  /** The parts it may name. */
  parts: Readonly<Record<string, KitPart>>
  /** Every kind its file names, as Lumovi names them: what its parts may open a list of. */
  kinds?: readonly string[]
  /** Those its file says its pages open (`spec.opens`): what its parts may open at one object. */
  opens?: readonly string[]
  /** Lumovi's own places its file says its pages link to (`spec.links`). */
  links?: readonly Reach[]
  /** Its own pages, by the ids its file gives them: what its parts may link to. */
  pages?: readonly string[]
  /** Lumovi's own open of what a press named: an object, or a list the door made. */
  open?: (to: Destination) => void
  /**
   * Lumovi's own dialog for a change its page proposes, with what the page was handed: what
   * became of it. None, and every proposal is refused.
   */
  propose?: (
    proposal: PageProposal,
    handed: { digest: string; codeDigest: string },
  ) => Promise<ProposalOutcome>
  /** Where its strip's "What it may do" goes. */
  asks?: string
}

/**
 * The page, opened once for as long as this is shown. With the tests' own code, as it's given;
 * without, the plugin's code as Lumovi hands it over (or why not), which is the only way a page
 * outside the tests is ever given any.
 */
export function Opened({ shown, onAgain }: { shown: Opening; onAgain: () => void }): ReactNode {
  const [handed, setHanded] = useState<PluginCode | undefined>(() =>
    LUMOVI_TEST_BUILD && shown.code !== undefined
      ? { ok: true, code: shown.code, digest: '', codeDigest: '' }
      : undefined,
  )
  // (Asked once a page: whoever shows it makes it anew to have it asked again.)
  const { plugin } = shown
  const code = LUMOVI_TEST_BUILD ? shown.code : undefined
  useEffect(() => {
    if (code !== undefined) return
    let here = true
    void codeOf(plugin).then((answer) => here && setHanded(answer))
    return () => void (here = false)
  }, [plugin, code])
  if (handed === undefined) return null
  if (!handed.ok) {
    return (
      <PluginFrame
        name={shown.name}
        version={shown.version}
        {...(shown.asks === undefined ? {} : { asks: shown.asks })}
        yours={shown.yours === true}
        end={{ why: 'not-handed', refused: handed.refused }}
        onAgain={onAgain}
        onFault={() => undefined}
      >
        {null}
      </PluginFrame>
    )
  }
  return (
    <Running
      shown={shown}
      code={handed.code}
      handed={code === undefined ? handed : undefined}
      onAgain={onAgain}
    />
  )
}

function Running({
  shown,
  code,
  handed,
  onAgain,
}: {
  shown: Opening
  code: string
  handed?: { digest: string; codeDigest: string }
  onAgain: () => void
}): ReactNode {
  // Opened and closed in one effect, with what it was first shown with: what's shown is made
  // anew to be opened again. (Never as the component's first state: React, checking a page in
  // development, runs an effect's cleanup and then the effect again, and the page kept would be
  // the one just closed: its box there, and nothing drawn.)
  const first = useRef({ shown, code, handed })
  const [page, setPage] = useState<OpenPage>()
  useEffect(() => {
    const { shown, code, handed } = first.current
    const opened = openPage({
      plugin: shown.plugin,
      by: { plugin: shown.plugin, name: shown.name, version: shown.version },
      context: shown.context,
      code,
      ...(handed ? { handed: { digest: handed.digest, codeDigest: handed.codeDigest } } : {}),
      parts: shown.parts,
      ...(shown.kinds ? { kinds: shown.kinds } : {}),
      ...(shown.opens ? { opens: shown.opens } : {}),
      ...(shown.links ? { links: shown.links } : {}),
      ...(shown.pages ? { pages: shown.pages } : {}),
      ...(shown.opening ? { opening: shown.opening } : {}),
      ...(shown.open ? { open: shown.open } : {}),
      ...(shown.propose && handed
        ? { propose: (proposal: PageProposal) => shown.propose!(proposal, handed) }
        : {}),
    })
    setPage(opened)
    return () => opened.close()
  }, [])
  return page ? <Showing page={page} shown={shown} onAgain={onAgain} /> : null
}

/** A page that's open: what Lumovi draws of it, and its end when it has one. */
function Showing({
  page,
  shown,
  onAgain,
}: {
  page: OpenPage
  shown: Opening
  onAgain: () => void
}): ReactNode {
  const end = useSyncExternalStore(page.subscribe, () => page.end)
  const notices = useSyncExternalStore(page.subscribeNotices, () => page.notices)
  return (
    <PluginFrame
      name={shown.name}
      version={shown.version}
      {...(shown.asks === undefined ? {} : { asks: shown.asks })}
      yours={shown.yours === true}
      end={end}
      notices={notices}
      onRetry={page.retry}
      onAgain={onAgain}
      onFault={page.fault}
    >
      <PluginSurface page={page} />
    </PluginFrame>
  )
}

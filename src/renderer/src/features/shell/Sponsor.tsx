/**
 * The sidebar's sponsor card: Lumovi's own, a sponsor's, or nothing, as Lumovi/main-sponsor
 * says (the desktop app's main process or the server reads it, and hands over its pictures:
 * nothing here is fetched). Pinned above the footer, outside the nav's scrolling, it's made of
 * the sidebar's own parts: a label like the nav's, over a card like the cluster switcher.
 */
import { ArrowUpRight } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { create } from 'zustand'
import { domainOf, LUMOVI_CARD, type SponsorCard, type SponsorPicture } from '@shared/sponsor'
import lumoviDark from '@renderer/assets/sponsor/lumovi-dark.png'
import lumoviLight from '@renderer/assets/sponsor/lumovi-light.png'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'

/** A card as the sidebar draws it, its pictures decoded and ready. */
interface Shown {
  /** Which this is: another one fades in in its place. */
  id: number
  link: string
  alt: string
  line: string
  picture: { light: SponsorPicture; dark: SponsorPicture }
}

let ids = 0

const lumovi = (link: string): Shown => ({
  id: ++ids,
  link,
  alt: LUMOVI_CARD.alt,
  line: LUMOVI_CARD.line,
  picture: { light: { src: lumoviLight }, dark: { src: lumoviDark } },
})

/** The card: not known yet (undefined), none (null), or the one to show. */
const useSponsor = create<{ shown?: Shown | null }>(() => ({}))

/** Whether the sidebar has a card (or may have, until the host says). */
export const useSponsorShown = (): boolean => useSponsor((state) => state.shown !== null)

/**
 * What to show for the host's card: a sponsor's once all its pictures have decoded, or, if one
 * won't, Lumovi's own.
 */
async function toShow(card: SponsorCard): Promise<Shown | null> {
  if (card.mode === 'none') return null
  if (card.mode === 'lumovi') return lumovi(card.link)
  const { light, dark } = card.picture
  const sources = [light.src, dark.src, light.still, dark.still].filter((src) => src !== undefined)
  try {
    await Promise.all(
      sources.map((src) => {
        const image = new Image()
        image.src = src
        return image.decode()
      }),
    )
  } catch {
    return lumovi(card.lumovi)
  }
  return { id: ++ids, link: card.link, alt: card.alt, line: card.line, picture: card.picture }
}

let listening = false

/** Asks the host once, then follows its changes for as long as the page is open. */
function listen(): void {
  if (listening) return
  listening = true
  let latest = 0
  let changed = false
  const show = async (card: SponsorCard) => {
    const turn = ++latest
    const shown = await toShow(card)
    if (turn === latest) useSponsor.setState({ shown })
  }
  api.sponsor.onChange((card) => {
    changed = true
    void show(card)
  })
  // (Unless a change has already said what's newer.)
  api.sponsor.card().then(
    (card) => void (changed || show(card)),
    () => void (changed || show({ mode: 'lumovi', link: LUMOVI_CARD.link })),
  )
}

export function Sponsor() {
  useEffect(listen, [])
  const shown = useSponsor((state) => state.shown)
  // The card the sidebar came with doesn't fade in; one that replaces it does.
  const [first] = useState(shown?.id)
  if (shown === null) return null
  return (
    <section
      aria-label="Sponsor"
      // Its room is kept while the host is asked, so nothing moves when it comes. On short
      // windows it steps aside, and the nav keeps the room.
      className="group h-[149px] shrink-0 border-t border-line px-3 pt-2 pb-3 no-drag [@media(max-height:719px)]:hidden"
    >
      {shown && <Card key={shown.id} shown={shown} fade={shown.id !== first} />}
    </section>
  )
}

function Card({ shown, fade }: { shown: Shown; fade: boolean }) {
  const domain = useId()
  const { light, dark } = shown.picture
  return (
    <div className={cn(fade && 'animate-fade-in')}>
      {/* Hidden from screen readers: the section's name says it, and the domain describes the link. */}
      <div
        aria-hidden
        className="mb-1 flex h-4 items-center px-2.5 text-2xs font-medium tracking-wider text-ink-3 uppercase"
      >
        Sponsor
        {/* Where the card leads, as people point at it or reach it with the keyboard: cut at the
            start when it's long, so the end, whose it is, always shows. */}
        <span
          id={domain}
          className="ml-auto flex min-w-0 items-center gap-[3px] pl-2 font-mono font-normal tracking-normal normal-case opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100"
        >
          <span className="min-w-0 truncate [direction:rtl]">
            <bdi>{domainOf(shown.link)}</bdi>
          </span>
          <ArrowUpRight className="size-3 shrink-0" />
        </span>
      </div>
      <a
        href={shown.link}
        // In a browser, a tab of its own that can't reach back into this page, and that tells the
        // sponsor nothing of where it came from.
        target="_blank"
        rel="noopener noreferrer"
        aria-describedby={domain}
        draggable={false}
        onClick={(event) => {
          // The desktop app's window doesn't open links: the browser does.
          if (api.host !== 'desktop') return
          event.preventDefault()
          void api.app.openExternal(shown.link)
        }}
        className="block rounded-xl bg-surface-2 p-2 shadow-[inset_0_0_0_1px_var(--line)] transition-colors duration-150 hover:bg-surface-3"
      >
        <span className="relative block h-[68px] overflow-hidden rounded bg-surface after:pointer-events-none after:absolute after:inset-0 after:rounded after:shadow-[inset_0_0_0_1px_var(--line)]">
          <Picture picture={light} alt={shown.alt} className="logo-on-light" />
          <Picture picture={dark} alt={shown.alt} className="logo-on-dark" />
        </span>
        <span className="block truncate px-0.5 pt-2 text-xs text-ink-2">{shown.line}</span>
      </a>
    </div>
  )
}

/**
 * A picture for one mode (only the one for the mode in use shows). An animated one plays once;
 * for people who ask for less motion, its first frame shows, still.
 */
function Picture({
  picture,
  alt,
  className,
}: {
  picture: SponsorPicture
  alt: string
  className: string
}) {
  return (
    <picture className={cn('block', className)}>
      {picture.still && <source srcSet={picture.still} media="(prefers-reduced-motion: reduce)" />}
      <img
        src={picture.src}
        alt={alt}
        width={204}
        height={68}
        draggable={false}
        className="block h-[68px] w-[204px]"
      />
    </picture>
  )
}

/**
 * The sidebar's sponsor card: what the page shows, as the desktop app's main process or the
 * server works it out from Lumovi/main-sponsor (backend/sponsor).
 */

/** Lumovi's own card: built in, at launch, and whenever a sponsor's can't be shown. */
export const LUMOVI_CARD = {
  line: 'Help keep Lumovi free.',
  alt: 'Lumovi',
  /** Until sponsor.json gives another. */
  link: 'https://github.com/sponsors/Lumovi',
} as const

/** A picture, as the page can show it without fetching anything: a data: URL of Lumovi's copy. */
export interface SponsorPicture {
  src: string
  /** An animated one's first frame, still, for people who ask for less motion. */
  still?: string
}

export type SponsorCard =
  /** Nothing: the sidebar is as it's always been. */
  | { mode: 'none' }
  /** Lumovi's own card, leading to `link`. */
  | { mode: 'lumovi'; link: string }
  | {
      mode: 'sponsor'
      name: string
      /** The line under the picture. */
      line: string
      alt: string
      link: string
      /** One for each mode. */
      picture: { light: SponsorPicture; dark: SponsorPicture }
      /** Where Lumovi's own card leads, should the page not manage to show the pictures. */
      lumovi: string
    }

/** Where a link leads, as the card says it: its host, without `www.` */
export const domainOf = (link: string): string =>
  URL.parse(link)?.hostname.replace(/^www\./, '') ?? ''

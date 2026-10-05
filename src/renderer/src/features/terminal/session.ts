/**
 * A terminal and the shell it shows: in a container, on a node, or (in the
 * desktop app) on this computer. It lives outside React, so it can move
 * between places on the page (a dock's tabs, say) and keep its scrollback;
 * whoever started it ends it.
 */
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import './terminal.css'
import type { KubeErrorCode, ShellExit, ShellRequest } from '@shared/api'
import { api } from '@renderer/lib/api'

export type Phase =
  | { state: 'connecting' }
  | { state: 'open' }
  | { state: 'ended'; exit: ShellExit }
  | { state: 'failed'; error: string; code: KubeErrorCode }

/** The terminal in the app's colours, read from its theme. */
function theme() {
  const css = getComputedStyle(document.documentElement)
  const color = (name: string) => css.getPropertyValue(name).trim()
  return {
    background: color('--surface-2'),
    foreground: color('--text-1'),
    cursor: color('--accent'),
    cursorAccent: color('--surface-2'),
    selectionBackground: color('--accent-soft'),
  }
}

/** The icons prompts draw, which the app's mono font doesn't have (see terminal.css). */
const SYMBOLS = 'Lumovi Terminal Symbols'
// Fetched now, before a terminal measures its characters: an icon is as wide as a cell then.
void document.fonts.load(`12px '${SYMBOLS}'`, '\uf179')

/** The app's mono font, then the icons, then the font's own fallbacks. */
export function terminalFont(mono: string): string {
  const [font, ...fallbacks] = mono.split(',').map((family) => family.trim())
  return [font, `'${SYMBOLS}'`, ...fallbacks].join(', ')
}

/** The dock's shortcuts, which terminals leave to it (see TERMINAL_KEYS). */
export function dockKey(event: KeyboardEvent): boolean {
  const ctrl = event.ctrlKey && !event.metaKey && !event.altKey
  const cmd = event.metaKey && !event.ctrlKey && !event.altKey && event.shiftKey
  return (
    (ctrl &&
      (['Backquote', 'PageUp', 'PageDown'].includes(event.code) ||
        (event.shiftKey && ['KeyW', 'KeyT'].includes(event.code)))) ||
    (cmd && ['BracketLeft', 'BracketRight'].includes(event.code))
  )
}

const live = new Set<TerminalSession>()
let watching = false

/** Terminals follow the theme: the system's (the desktop app's) and the one a browser picked. */
function watchTheme() {
  if (watching) return
  watching = true
  const update = () => {
    for (const session of live) session.term.options.theme = theme()
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', update)
  new MutationObserver(update).observe(document.documentElement, {
    attributeFilter: ['data-theme'],
  })
}

export class TerminalSession {
  readonly id = crypto.randomUUID()
  readonly term: Terminal
  /** What xterm draws into; moved from place to place, never redrawn. */
  readonly element = document.createElement('div')
  readonly #fit = new FitAddon()
  #phase: Phase = { state: 'connecting' }
  readonly #listeners = new Set<() => void>()
  readonly #cleanup: (() => void)[] = []
  #started = false
  #shown = false
  #disposed = false
  /** Typed (pasted) before the shell was ready. */
  #pending = ''
  #ending: ReturnType<typeof setTimeout> | undefined

  /** Nothing starts yet: React may make one and throw it away. */
  constructor(readonly request: ShellRequest) {
    this.element.className = 'h-full w-full'
    this.term = new Terminal({
      cursorBlink: true,
      fontFamily: terminalFont(
        getComputedStyle(document.documentElement).getPropertyValue('--font-mono'),
      ),
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 10_000,
      theme: theme(),
    })
    this.term.loadAddon(this.#fit)
    // The terminal takes every key but the dock's.
    this.term.attachCustomKeyEventHandler((event) => !dockKey(event))
  }

  get phase(): Phase {
    return this.#phase
  }

  readonly getPhase = (): Phase => this.#phase

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  /** Starts the shell (once). */
  start(): void {
    if (this.#started) return
    this.#started = true
    live.add(this)
    watchTheme()
    const { id } = this
    this.#cleanup.push(
      api.terminal.onData((session, data) => {
        if (session === id) this.term.write(data)
      }),
      api.terminal.onExit((session, exit) => {
        if (session === id) this.#set({ state: 'ended', exit })
      }),
    )
    const input = this.term.onData((data) => {
      if (this.#phase.state === 'open') api.terminal.write(id, data)
    })
    this.#cleanup.push(() => input.dispose())
    void api.terminal.open(id, this.request).then((result) => {
      // Closed while connecting: the other side ends the shell.
      if (this.#disposed) return
      if (!result.ok) {
        this.#set({ state: 'failed', error: result.error.message, code: result.error.code })
        return
      }
      this.#set({ state: 'open' })
      this.#resize()
      if (this.#pending) this.term.paste(this.#pending)
      this.#pending = ''
    })
  }

  /** Shows the terminal in `host`, fitted to it, until the returned function takes it out. */
  attach(host: HTMLElement): () => void {
    host.appendChild(this.element)
    if (!this.#shown) {
      // xterm measures its font where it's shown, so it's opened there the first time.
      this.term.open(this.element)
      this.#shown = true
    }
    const observer = new ResizeObserver(() => this.#resize())
    observer.observe(host)
    this.#resize()
    return () => {
      observer.disconnect()
      this.element.remove()
    }
  }

  /** Types `text` (as a paste: run only once the person presses Enter), once the shell is ready. */
  paste(text: string): void {
    if (this.#phase.state === 'open') this.term.paste(text)
    else this.#pending += text
  }

  focus(): void {
    this.term.focus()
  }

  /**
   * Whoever shows it holds it while they do; let go of, it ends a moment
   * later, unless held again meanwhile (React shows things twice while
   * developing).
   */
  hold(): () => void {
    clearTimeout(this.#ending)
    return () => {
      this.#ending = setTimeout(() => this.dispose())
    }
  }

  /** Ends the shell and forgets the terminal. */
  dispose(): void {
    this.#disposed = true
    live.delete(this)
    for (const off of this.#cleanup) off()
    api.terminal.close(this.id)
    this.term.dispose()
  }

  #resize(): void {
    // Fitted to a host that's laid out; a hidden one has no size.
    if (this.element.offsetParent === null) return
    this.#fit.fit()
    if (this.#phase.state === 'open') api.terminal.resize(this.id, this.term.cols, this.term.rows)
  }

  #set(phase: Phase): void {
    this.#phase = phase
    for (const listener of this.#listeners) listener()
  }
}

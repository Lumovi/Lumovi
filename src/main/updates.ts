/**
 * New versions of KubeStacks, from its GitHub releases (electron-updater, with
 * the publish settings electron-builder writes into the app). A new version
 * downloads in the background and installs when the app restarts or quits.
 */
import { createRequire } from 'node:module'
import type { UpdateEvent, UpdateState } from '@shared/api'

// CommonJS, so loaded with require (where the e2e tests stand in for it).
const { autoUpdater } = createRequire(import.meta.url)(
  'electron-updater',
) as typeof import('electron-updater')

/** After starting, so the first check doesn't compete with loading a cluster. */
const FIRST_CHECK_MS = 3_000
/** How often to look again while the app runs. */
const CHECK_EVERY_MS = 4 * 60 * 60_000

export class Updates {
  #state: UpdateState = { status: 'idle' }
  /** The next outcome answers a check the user asked for. */
  #manual = false
  #version = ''
  #timer?: NodeJS.Timeout

  constructor(
    private readonly emit: (event: UpdateEvent) => void,
    auto: boolean,
  ) {
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.logger = null
    autoUpdater.on('checking-for-update', () => this.#set({ status: 'checking' }))
    autoUpdater.on('update-not-available', () => this.#set({ status: 'up-to-date' }))
    autoUpdater.on('update-available', ({ version }) => {
      this.#version = version
      this.#set({ status: 'downloading', version, percent: 0 })
    })
    autoUpdater.on('download-progress', ({ percent }) =>
      this.#set({ status: 'downloading', version: this.#version, percent: Math.floor(percent) }),
    )
    autoUpdater.on('update-downloaded', ({ version }) => this.#set({ status: 'ready', version }))
    autoUpdater.on('error', (error) => this.#set({ status: 'error', message: error.message }))
    this.setAuto(auto)
  }

  state(): UpdateEvent {
    return { state: this.#state, manual: false }
  }

  /** Looks soon after starting, then every few hours; or not at all. */
  setAuto(on: boolean): void {
    clearTimeout(this.#timer)
    if (on) this.#schedule(FIRST_CHECK_MS)
  }

  async check(manual: boolean): Promise<void> {
    // A check in the background doesn't take the answer from one the user asked for.
    if (manual) this.#manual = true
    // A version downloading or downloaded already is the answer.
    if (this.#state.status === 'downloading' || this.#state.status === 'ready') {
      this.#set(this.#state)
      return
    }
    try {
      // Nothing to check against, e.g. while developing: there's no published version to compare.
      if ((await autoUpdater.checkForUpdates()) === null) this.#set({ status: 'unsupported' })
    } catch {
      // Reported through the error event.
    }
  }

  install(): void {
    if (this.#state.status === 'ready') autoUpdater.quitAndInstall()
  }

  #schedule(delay: number) {
    this.#timer = setTimeout(() => {
      void this.check(false)
      this.#schedule(CHECK_EVERY_MS)
    }, delay)
  }

  #set(state: UpdateState) {
    this.#state = state
    // Only the outcome answers the question, not the progress that follows it.
    const manual = this.#manual && state.status !== 'checking'
    if (manual) this.#manual = false
    this.emit({ state, manual })
  }
}

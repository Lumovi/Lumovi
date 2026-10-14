/**
 * The desktop app's notifications of new Warning events, for the clusters whose settings ask for
 * them: every 30 seconds while Lumovi runs, whatever page is shown, each such cluster's watched
 * namespaces read as the person (the kubeconfig's own credentials), and what's new told
 * (`WarningWatch`, as a server's page tells it). A cluster whose signing in fails is paused, said
 * once, and looked at again only once it answers in Lumovi: a credential plugin can open a browser
 * or ask in a terminal, and one that failed isn't started again every 30 seconds, all night.
 */
import type { KubeErrorCode, KubeObject, WarningNoticesState } from '@shared/api'
import type { ClusterSettings } from '@shared/cluster-settings'
import { WARNINGS_EVERY_MS, WarningWatch, type WarningNotice } from '@shared/warning-notices'
import { spelled } from '@shared/kit/characters'
import type { KubeService } from '@backend/kube/service'

/** How often it looks (an env for tests). */
const EVERY_MS = Number(process.env.LUMOVI_WARNINGS_EVERY_MS) || WARNINGS_EVERY_MS
/** What a read fails with when signing in does: the credential plugin, or the cluster refusing. */
const SIGNING_IN: ReadonlySet<KubeErrorCode> = new Set(['auth', 'unauthorized'])

export class WarningNotices {
  #timer?: ReturnType<typeof setInterval>
  /** The clusters being looked at. */
  readonly #looking = new Set<string>()
  readonly #watch = new WarningWatch()
  /** The clusters paused, signing in having failed: since when. */
  readonly #paused = new Map<string, number>()
  /** Those said to be paused, and not read whole since: said once, however often it fails. */
  readonly #saidPaused = new Set<string>()

  constructor(
    private readonly deps: {
      kube: Pick<KubeService, 'list' | 'answeredAt' | 'credentialPlugin'>
      /** Each cluster's settings, by its context. */
      clusters: () => Record<string, ClusterSettings>
      /** What a cluster is called in Lumovi. */
      name: (context: string) => string
      tell: (notice: WarningNotice) => void
    },
  ) {}

  /** How a cluster's notifications stand, for its settings. */
  state(context: string): WarningNoticesState {
    const signsInWith = this.deps.kube.credentialPlugin(context)
    const pausedAt = this.#paused.get(context)
    return {
      ...(signsInWith ? { signsInWith } : {}),
      ...(pausedAt !== undefined ? { pausedAt } : {}),
    }
  }

  start(): void {
    this.#timer = setInterval(() => void this.look(), EVERY_MS)
    this.#timer.unref?.()
    void this.look()
  }

  stop(): void {
    clearInterval(this.#timer)
    this.#timer = undefined
  }

  /** One look at every cluster that asks: what's new is told. */
  async look(): Promise<void> {
    const clusters = this.deps.clusters()
    // (Turned off: forgotten, so turned on again it starts from what's there then, and tries
    // signing in again.)
    for (const context of [...this.#watch.watched, ...this.#paused.keys(), ...this.#saidPaused]) {
      if (clusters[context]?.notify) continue
      this.#watch.forget(context)
      this.#paused.delete(context)
      this.#saidPaused.delete(context)
    }
    await Promise.all(
      Object.entries(clusters).flatMap(([context, settings]) =>
        settings.notify ? [this.#lookAt(context, settings)] : [],
      ),
    )
  }

  /**
   * A look at one cluster. One still being looked at (its credential plugin waiting for a sign-in
   * in a browser, say) is left to it: started again by none of the looks after, and holding up
   * none of the other clusters'.
   */
  async #lookAt(context: string, settings: ClusterSettings): Promise<void> {
    if (this.#looking.has(context)) return
    this.#looking.add(context)
    try {
      const paused = this.#paused.get(context)
      if (paused !== undefined) {
        // Paused until it answers in Lumovi (the person opened it, and signed in): then from
        // what's there.
        if ((this.deps.kube.answeredAt(context) ?? 0) <= paused) return
        this.#paused.delete(context)
      }
      const events: KubeObject[] = []
      let whole = true
      let signingIn = false
      for (const namespace of settings.watch ?? [undefined]) {
        const listed = await this.deps.kube.list({
          context,
          kind: 'Event',
          ...(namespace ? { namespace } : {}),
          fieldSelector: 'type=Warning',
        })
        if (listed.ok) {
          events.push(...listed.data.items)
          continue
        }
        whole = false
        if (SIGNING_IN.has(listed.error.code)) {
          signingIn = true
          break
        }
      }
      if (signingIn) {
        this.#paused.set(context, Date.now())
        this.#watch.forget(context)
        if (this.#saidPaused.has(context)) return
        this.#saidPaused.add(context)
        this.deps.tell({
          title: 'Notifications paused',
          body: 'Signing in failed. Open the cluster to sign in again, and notifications go on.',
          cluster: spelled(this.deps.name(context)),
          opens: `/cluster/${encodeURIComponent(context)}`,
        })
        return
      }
      // (A look with a read that failed is left for the next: nothing told of it now, and
      // what was seen kept.)
      if (!whole) return
      this.#saidPaused.delete(context)
      for (const notice of this.#watch.look(context, this.deps.name(context), events, Date.now())) {
        this.deps.tell(notice)
      }
    } finally {
      this.#looking.delete(context)
    }
  }
}

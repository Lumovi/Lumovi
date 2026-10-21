/**
 * Container logs streamed to the page as the API server sends them
 * (`kubectl logs -f --timestamps`), in batches so a chatty container doesn't
 * flood the page with messages.
 */
import type { KubeError, LogStreamRequest, Result } from '@shared/api'
import { kubectl } from '@shared/kubectl'
import { READ_REFUSED } from '@shared/plugin-reads'
import { whose } from '@shared/plugins'
import { outcomeOf } from '../audit/describe'
import type { Recorder } from '../audit/recorder'
import type { AccessGuard } from '@shared/access'
import { kubeStream } from './client'
import { knownVia, type PluginLookup, type Via } from './plugin-via'
import { KubeRequestError, toKubeError } from './errors'
import type { ClusterConfigs } from './kubeconfig'
import {
  assertDnsName,
  assertIntegerInRange,
  assertNamespace,
  assertQuery,
  assertString,
  invalid,
} from './validate'

/** Lines are sent to the page at most this often, per stream. */
const BATCH_MS = 100
/** As many lines as the Logs view keeps (MAX_LINES): a long since asks for its last ones. */
const MAX_TAIL = 20_000
const MAX_SINCE = 30 * 86_400

interface Dependencies {
  store: ClusterConfigs
  envReady: Promise<void>
  /** How long the API server has to start answering. */
  timeoutMs: number
  /** The audit log, as the page's person records to it. */
  audit: Recorder
  /** A server's: what its person may do (the desktop app has none). */
  guard?: AccessGuard
  /** A plugin Lumovi has, by its name: whose page logs were shown on, for the history. */
  plugin?: PluginLookup
  /** The desktop app's: the organization's policy lets no plugin's page show logs. */
  pluginLogsOff?: () => boolean
}

/** Why a plugin's page is shown no logs, where its organization says so. */
export const LOGS_OFF = READ_REFUSED['logs-off']

export class LogStreams {
  readonly #streams = new Map<string, () => void>()

  constructor(
    private readonly deps: Dependencies,
    private readonly emit: {
      lines: (id: string, lines: string[]) => void
      end: (id: string, error?: KubeError) => void
    },
  ) {}

  async start(id: unknown, request: unknown): Promise<Result<null>> {
    let asked: LogStreamRequest | undefined
    let via: Via | undefined
    try {
      if (typeof id !== 'string' || !/^[\w-]{8,64}$/.test(id) || this.#streams.has(id)) {
        throw invalid('A new stream needs a new id')
      }
      const r = assertQuery<LogStreamRequest>(request)
      assertString(r.context, 'context')
      assertNamespace(r.namespace)
      assertDnsName(r.pod, 'a pod’s name')
      assertString(r.container, 'container')
      const params = new URLSearchParams({ container: r.container, timestamps: 'true' })
      if (r.tailLines !== undefined) {
        assertIntegerInRange(r.tailLines, 'tailLines', 1, MAX_TAIL)
        params.set('tailLines', String(r.tailLines))
      }
      if (r.sinceSeconds !== undefined) {
        assertIntegerInRange(r.sinceSeconds, 'sinceSeconds', 1, MAX_SINCE)
        params.set('sinceSeconds', String(r.sinceSeconds))
      } else if (r.sinceTime !== undefined) {
        assertString(r.sinceTime, 'sinceTime')
        if (Number.isNaN(Date.parse(r.sinceTime))) throw invalid('sinceTime must be a time')
        params.set('sinceTime', r.sinceTime)
      }
      // A previous container has stopped: there's nothing more to follow.
      if (r.previous === true) params.set('previous', 'true')
      else if (r.follow === true) params.set('follow', 'true')
      const path = `/api/v1/namespaces/${encodeURIComponent(r.namespace)}/pods/${encodeURIComponent(r.pod)}/log?${params}`

      asked = r
      // (Asked for a plugin's page where the organization lets none show logs: none are read.)
      if (r.via !== undefined && this.deps.pluginLogsOff?.()) {
        throw new KubeRequestError('forbidden', LOGS_OFF)
      }
      await this.deps.guard?.require(r.context, 'logs', 'on', r.namespace, 'read logs')
      await this.deps.envReady
      const kc = this.deps.store.forContext(r.context)
      const { body, abort } = await kubeStream(kc, path, { timeoutMs: this.deps.timeoutMs })
      // (Shown on a plugin's page: whose, as the backend knows it, never as the page says.)
      via = await knownVia(this.deps.plugin, r.via)
      this.#read(r, { outcome: 'success' }, via)
      this.#streams.set(id, abort)
      let partial = ''
      let batch: string[] = []
      let timer: NodeJS.Timeout | undefined
      const flush = () => {
        clearTimeout(timer)
        timer = undefined
        if (batch.length) this.emit.lines(id, batch)
        batch = []
      }
      // The API server ends every line; a chunk can end mid-line, or mid-character.
      body.setEncoding('utf8')
      body.on('data', (chunk: string) => {
        const lines = (partial + chunk).split('\n')
        partial = lines.pop()!
        batch.push(...lines.filter(Boolean))
        timer ??= setTimeout(flush, BATCH_MS)
      })
      let ended = false
      const end = (error?: Error) => {
        if (ended) return
        ended = true
        // Stopped by the page, which isn't listening any more.
        if (!this.#streams.delete(id)) return
        flush()
        this.emit.end(id, error && toKubeError(error))
      }
      body.on('end', () => end())
      body.on('error', end)
      body.on('close', () => end())
      return { ok: true, data: null }
    } catch (error) {
      const failure = { ok: false as const, error: toKubeError(error) }
      if (asked)
        this.#read(asked, outcomeOf(failure), via ?? (await knownVia(this.deps.plugin, asked.via)))
      return failure
    }
  }

  /** Recorded once a while for the same container's logs: a page asks for them again. */
  #read(r: LogStreamRequest, outcome: ReturnType<typeof outcomeOf>, via?: Via) {
    const which = r.previous === true ? 'previous' : 'current'
    this.deps.audit.read(
      // (A plugin's page's showing is its own: once a while, as the person's own reading is.)
      `logs:${r.context}/${r.namespace}/${r.pod}/${r.container}/${which}/${outcome.outcome}${via ? `/${via.details.plugin}` : ''}`,
      {
        action: 'logs.read',
        ...outcome,
        cluster: r.context,
        target: { kind: 'Pod', name: r.pod, namespace: r.namespace },
        summary: `Read the logs of Pod ${r.pod} (${r.container})${r.previous === true ? ', from before it restarted' : ''}${via ? `, shown on the plugin ${whose(via.label)} page` : ''}`,
        command: kubectl(
          r.context,
          r.namespace,
          'logs',
          r.pod,
          '-c',
          r.container,
          ...(r.previous === true ? ['--previous'] : r.follow === true ? ['-f'] : []),
        ),
        details: {
          container: r.container,
          previous: r.previous === true,
          follow: r.follow === true,
          ...via?.details,
        },
      },
    )
  }

  stop(id: unknown): void {
    const abort = this.#streams.get(String(id))
    this.#streams.delete(String(id))
    abort?.()
  }

  stopAll(): void {
    for (const id of [...this.#streams.keys()]) this.stop(id)
  }
}

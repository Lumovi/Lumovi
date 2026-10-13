/**
 * A pod's logs a plugin's code reads, once (`spec.logs: read`): the one way its code is handed
 * any. Checked as a read is, in turn: a plugin Lumovi has in use whose code it runs, the file and
 * code its page was handed, its code not turned off, the organization's policy, its file's
 * `logs: read` and its read of Pods; then read as the person (their access to logs, and the
 * cluster's rules), never a follow, its last lines kept to `READ_LIMITS` with the oldest cut.
 * Every one, read or refused, is in the history, naming the plugin.
 */
import { kubectl } from '@shared/kubectl'
import { mayCarryCode } from '@shared/plugin-loading'
import {
  granted,
  logsQuery,
  READ_LIMITS,
  READ_REFUSED,
  resolvedAs,
  type LogLine,
  type PluginLogs,
  type PluginLogsQuery,
  type ReadRefusal,
} from '@shared/plugin-reads'
import { ALL_CODE_ON, codeOff } from '@shared/plugin-hand-over'
import { PLUGIN_NAME, whose } from '@shared/plugins'
import type { KnownPlugin } from '@shared/plugins-known'
import type { Recorder } from './audit/recorder'
import type { KubeService } from './kube/service'
import type { HandOverTo } from './plugin-code'
import { REFUSED, refusalOf } from './plugin-reads'

interface PluginLogReading {
  kube: Pick<KubeService, 'podLogs'>
  /** The plugins in use, as the backend reads them now. */
  known: () => Promise<readonly Readonly<KnownPlugin>[]>
  /** Where the page that asks is, now: what turns plugins' code, and their logs, off there. */
  to?: () => HandOverTo
  audit: Recorder
}

/**
 * What's read of the cluster to keep the last lines: more than is handed, never all of it. (The
 * cluster stops at so many bytes from the oldest of the lines asked for, so a read that fills it
 * is asked again for fewer: the newest are the ones kept.)
 */
export const FETCHED_BYTES = 8 * READ_LIMITS.logBytes

/** A line as the API server writes it with its time (`timestamps`): when, then what. */
const STAMPED = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) (.*)$/

/** The lines of what the cluster sent, the last of them within Lumovi's limits: cut at the oldest. */
export function lastLines(text: string): { lines: LogLine[]; cut: boolean } {
  const all = text.split('\n')
  if (all.at(-1) === '') all.pop()
  let cut = all.length > READ_LIMITS.logLines
  const kept = all.slice(-READ_LIMITS.logLines)
  const lines: LogLine[] = []
  let bytes = 0
  for (let i = kept.length - 1; i >= 0; i--) {
    const raw = kept[i]!
    const stamped = STAMPED.exec(raw)
    const line: LogLine = stamped ? { time: stamped[1]!, text: stamped[2]! } : { text: raw }
    bytes += Buffer.byteLength(line.text) + 1
    if (bytes > READ_LIMITS.logBytes) {
      cut = true
      break
    }
    lines.unshift(line)
  }
  return { lines, cut }
}

export function pluginLogs({ kube, known, audit, to }: PluginLogReading) {
  return async function read(query: unknown): Promise<PluginLogs> {
    // (Lumovi's own page sends these: one that isn't one names no plugin, and isn't recorded.)
    const q = logsQuery(query)
    if (!q || !PLUGIN_NAME.test(q.plugin)) return { ok: false, refused: 'failed' }
    const refuse = (plugin: Readonly<KnownPlugin> | undefined, refused: ReadRefusal) => {
      record(audit, q, plugin, refused)
      return { ok: false as const, refused }
    }
    const plugin = (await known()).find((p) => p.name === q.plugin)
    // (A plugin without code has no page that could ask.)
    if (!plugin || !mayCarryCode(plugin.origin) || plugin.codeDigest === undefined) {
      return refuse(undefined, 'not-in-use')
    }
    if (q.digest !== plugin.digest || q.codeDigest !== plugin.codeDigest) {
      return refuse(plugin, 'changed')
    }
    const switches = to?.().switches ?? ALL_CODE_ON
    if (codeOff(plugin.name, switches)) return refuse(plugin, 'code-off')
    // The organization's policy lets no plugin show or read logs.
    if (switches.logsOff) return refuse(plugin, 'logs-off')
    // Its file says its code reads them, of Pods it reads.
    if (plugin.logs !== 'read' || !granted(plugin.grant, resolvedAs('', 'Pod'), 'objects')) {
      return refuse(plugin, 'not-granted')
    }
    let tail = q.tail ?? READ_LIMITS.logLines
    for (;;) {
      const sent = await kube.podLogs({
        context: q.context,
        namespace: q.namespace,
        pod: q.pod,
        container: q.container,
        tailLines: tail,
        ...(q.since === undefined ? {} : { sinceSeconds: q.since }),
        ...(q.previous ? { previous: true } : {}),
        limitBytes: FETCHED_BYTES,
        timestamps: true,
      })
      if (!sent.ok) return refuse(plugin, refusalOf(sent.error.code))
      // The cluster stopped before its newest lines: fewer of them, at most those that came whole.
      if (Buffer.byteLength(sent.data) >= FETCHED_BYTES && tail > 1) {
        const whole = sent.data.split('\n').length - 1
        tail = Math.max(1, Math.min(Math.floor(tail / 2), whole))
        continue
      }
      record(audit, q, plugin)
      const { lines, cut } = lastLines(sent.data)
      const fewer = tail < (q.tail ?? READ_LIMITS.logLines)
      return { ok: true, lines, ...(cut || fewer ? { cut: true as const } : {}) }
    }
  }
}

function record(
  audit: Recorder,
  q: PluginLogsQuery,
  plugin: Readonly<KnownPlugin> | undefined,
  refused?: ReadRefusal,
): void {
  const who: Record<string, string> = plugin
    ? {
        plugin: plugin.name,
        pluginVersion: plugin.version,
        pluginDigest: plugin.digest,
        ...(plugin.codeDigest === undefined ? {} : { codeDigest: plugin.codeDigest }),
      }
    : { plugin: q.plugin }
  // A plugin Lumovi has in use: each container's logs apart, once a while. One it hasn't (by any
  // name a page cares to send): one entry a while, so new names can't fill the history.
  const same = plugin
    ? [q.context, plugin.name, q.namespace, q.pod, q.container, q.previous ?? false, refused ?? '']
    : [q.context, refused]
  audit.read(`plugin-logs:${JSON.stringify(same)}`, {
    action: 'logs.read',
    outcome: refused === undefined ? 'success' : REFUSED.has(refused) ? 'refused' : 'failure',
    ...(refused === undefined ? {} : { error: READ_REFUSED[refused] }),
    cluster: q.context,
    target: { kind: 'Pod', name: q.pod, namespace: q.namespace },
    summary: `Read the logs of Pod ${q.pod} (${q.container})${q.previous ? ', from before it restarted' : ''}, for the plugin ${whose(plugin?.label ?? q.plugin)} code`,
    command: kubectl(
      q.context,
      q.namespace,
      'logs',
      q.pod,
      '-c',
      q.container,
      `--tail=${q.tail ?? READ_LIMITS.logLines}`,
      ...(q.since === undefined ? [] : [`--since=${q.since}s`]),
      ...(q.previous ? ['--previous'] : []),
    ),
    details: {
      container: q.container,
      previous: q.previous === true,
      ...who,
      ...(refused === undefined ? {} : { refused }),
    },
  })
}

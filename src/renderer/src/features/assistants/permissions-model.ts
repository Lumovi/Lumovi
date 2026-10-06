/**
 * What the AI permissions page works out: what someone typing in a rule's
 * clusters or namespaces may mean (with how much each matches), what a rule
 * covers, and how a decision reads.
 */
import {
  AI_SETTINGS,
  AI_VALUE_LABELS,
  parseMatcher,
  ruleTest,
  type AiAccess,
  type AiDecision,
  type AiSetting,
  type AiSource,
  type AiTarget,
  type Matcher,
} from '@shared/ai-permissions'
import type { KubeContext } from '@shared/api'
import type { IndexedNamespace } from './namespaces'

export const formatCount = (n: number) => n.toLocaleString('en-US')

export const plural = (n: number, one: string, many: string) =>
  `${formatCount(n)} ${n === 1 ? one : many}`

/** A namespace as the rules see it. */
export const targetOf = (ns: IndexedNamespace): AiTarget => ({
  cluster: { name: ns.cluster.name, labels: ns.cluster.labels },
  namespace: { name: ns.name, labels: ns.labels },
})

/** Whether one matcher takes in a cluster (or a namespace). */
function matcherTest(text: string, onCluster: boolean): (ns: IndexedNamespace) => boolean {
  const test = ruleTest({
    name: '',
    clusters: onCluster ? [text] : [],
    namespaces: onCluster ? [] : [text],
    set: {},
  })
  return (ns) => test(targetOf(ns)) === true
}

export interface Suggestion {
  text: string
  kind: 'Name' | 'Pattern' | 'Label'
  /** How much it takes in (or, with "!", leaves out): "12 namespaces". */
  count: string
  none: boolean
}

/**
 * What someone typing `typed` may mean: a pattern of what starts so, names and
 * labels that do; "!" first, what to leave out. Each with how much it matches:
 * clusters (the person's contexts) or namespaces.
 */
export function suggestions(
  typed: string,
  onCluster: boolean,
  contexts: KubeContext[],
  namespaces: IndexedNamespace[],
  contextsAre: string,
): Suggestion[] {
  const given = typed.trim()
  const not = given.startsWith('!')
  const body = not ? given.slice(1) : given
  if (!body || typeof parseMatcher(given) === 'string') return []
  // Clusters as the namespaces' list has them, each once; a cluster whose namespaces can't be
  // listed counts too.
  const pool: IndexedNamespace[] = onCluster
    ? contexts.map((cluster) => ({ key: cluster.name, cluster, name: '', labels: {} }))
    : namespaces
  const named = (ns: IndexedNamespace) => (onCluster ? ns.cluster.name : ns.name)
  const labelsOf = (ns: IndexedNamespace) => (onCluster ? (ns.cluster.labels ?? {}) : ns.labels)
  const texts = new Set<string>()
  if (body.includes('=') || body.includes('*')) texts.add(body)
  else {
    texts.add(`${body}*`)
    const names = new Set(pool.map(named).filter((name) => name.startsWith(body)))
    for (const name of [...names].slice(0, 3)) texts.add(name)
    const labels = new Set(
      pool.flatMap((ns) =>
        Object.entries(labelsOf(ns))
          // Not the label every namespace has, which only says its name.
          .filter(([key]) => key !== NAME_LABEL)
          .filter(([key, value]) => key.startsWith(body) || value.startsWith(body))
          .map(([key, value]) => `${key}=${value}`),
      ),
    )
    for (const label of [...labels].slice(0, 3)) texts.add(label)
  }
  const unit = onCluster ? [contextsAre.slice(0, -1), contextsAre] : ['namespace', 'namespaces']
  // Only what a rule takes (a context's name could have a space, say).
  const valid = [...texts].filter((text) => typeof parseMatcher(text) !== 'string')
  return valid.slice(0, 7).map((text) => {
    const count = pool.filter(matcherTest(text, onCluster)).length
    const kind = KIND[(parseMatcher(text) as Matcher).kind]
    return {
      text: `${not ? '!' : ''}${text}`,
      kind,
      count: `${not ? 'leaves out ' : ''}${plural(count, unit[0]!, unit[1]!)}`,
      none: count === 0,
    }
  })
}

const KIND = { name: 'Name', pattern: 'Pattern', label: 'Label' } as const

/** The label Kubernetes gives every namespace: its name, again. */
export const NAME_LABEL = 'kubernetes.io/metadata.name'

/** What a matcher is, for its chip: "pattern", "label", "not"… */
export function matcherKind(text: string): string {
  // A rule's: it's one.
  const parsed = parseMatcher(text) as Matcher
  const kind = parsed.kind === 'name' ? '' : parsed.kind
  return parsed.not ? `not${kind ? ` ${kind}` : ''}` : kind
}

/** Who decided a setting, in words. */
export function sourceText(from: AiSource): string {
  if (from.kind === 'default') return 'Defaults'
  const names = from.names.join(', ')
  return from.kind === 'admin' ? `${names}, by your administrator` : names
}

/** A setting's values to choose from (asking first, for changes), the loosest marked so. */
export function choicesOf<K extends AiSetting>(key: K) {
  const values = (key === 'changes'
    ? ['ask', 'allow', 'never']
    : AI_SETTINGS[key]) as unknown as readonly AiAccess[K][]
  return values.map((value) => ({
    value,
    label: (AI_VALUE_LABELS[key] as Record<string, string>)[value]!,
    warn: (key === 'changes' && value === 'allow') || (key === 'secrets' && value === 'values'),
  }))
}

/** What each setting is about, said once. */
export const SETTING_TEXT: Record<AiSetting, { label: string; hint: string }> = {
  visibility: {
    label: 'Visibility',
    hint: 'Hidden namespaces are as good as gone for assistants.',
  },
  changes: { label: 'Changes', hint: 'What happens when an assistant asks to change something.' },
  secrets: { label: 'Secrets', hint: 'Keys only shows what a Secret holds, never what it says.' },
  env: { label: 'Env values', hint: 'Values written into a workload, like DB_PASSWORD=….' },
  logs: { label: 'Logs', hint: 'Applications often log tokens and customers’ data.' },
}

/** Every namespace counted, as decided: what it sees, changes, and reads. */
export function tally(
  decided: { ns: IndexedNamespace; decision: AiDecision }[],
  readOnly: (cluster: string) => boolean,
) {
  const counts = { seen: 0, hidden: 0, asking: 0, unasked: 0, never: 0, logs: 0, values: 0 }
  const clusters = new Set<string>()
  for (const { ns, decision } of decided) {
    if (decision.visibility.value === 'hidden') {
      counts.hidden++
      continue
    }
    counts.seen++
    clusters.add(ns.cluster.name)
    // A read-only cluster takes no changes, whatever the rules say.
    const changes = readOnly(ns.cluster.name) ? 'never' : decision.changes.value
    counts[changes === 'ask' ? 'asking' : changes === 'allow' ? 'unasked' : 'never']++
    if (decision.logs.value === 'read') counts.logs++
    if (decision.secrets.value === 'values') counts.values++
  }
  return { ...counts, clusters: clusters.size }
}

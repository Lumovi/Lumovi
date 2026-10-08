/**
 * The AI assistants page's Permissions tab: what assistants may do, and
 * where. The person's defaults, and rules for some clusters and namespaces
 * (by name, pattern or label, so one rule covers thousands), under the
 * administrator's. It decides as the tools do, over every cluster's
 * namespaces, so what it shows is what assistants may do; nothing is ever
 * listed whole, only counted, searched and sampled.
 */
import { notifyManager, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, CircleAlert, Lock, Plus, Search, Server, ShieldCheck, X } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { stringify } from 'yaml'
import {
  AI_SETTING_KEYS,
  AI_SETTINGS,
  AI_VALUE_LABELS,
  clusterForAssistant,
  decider,
  parseMatcher,
  ruleTest,
  stricter,
  type AiAccess,
  type AiDecision,
  type AiDefaults,
  type AiPermissions,
  type AiPermissionsView,
  type AiPolicy,
  type AiRule,
  type AiSetting,
  type AiTarget,
} from '@shared/ai-permissions'
import type { KubeContext, LumoviApi } from '@shared/api'
import { Button } from '@renderer/components/Button'
import { api } from '@renderer/lib/api'
import { Loading } from '@renderer/components/States'
import { useContexts } from '@renderer/hooks/queries'
import { readOnlyIn, useSettings } from '@renderer/hooks/settings'
import { cn } from '@renderer/lib/cn'
import { Card, Segmented } from './PageParts'
import { useNamespaceIndex, type IndexedNamespace, type NamespaceIndex } from './namespaces'
import {
  choicesOf,
  formatCount,
  matcherKind,
  NAME_LABEL,
  plural,
  SETTING_TEXT,
  sourceText,
  suggestions,
  tally,
  targetOf,
  type Suggestion,
} from './permissions-model'

type PermissionsApi = NonNullable<LumoviApi['aiPermissions']>
/** What the page shows them for: the desktop app's contexts, a server's fleet, or its one cluster. */
export type Scope = 'desktop' | 'fleet' | 'single'

/** How long after the last change they're kept: a name typed isn't kept a key at a time. */
const SAVE_MS = 400
/** How many of what a rule matches are shown; search finds the rest. */
const SAMPLE = 12

/** The person's AI permissions, kept up to date as another page changes them. */
export function useAiPermissions(permissions: PermissionsApi) {
  const queryClient = useQueryClient()
  useEffect(
    () => permissions.onChanged((view) => queryClient.setQueryData(['ai-permissions'], view)),
    [permissions, queryClient],
  )
  return useQuery({ queryKey: ['ai-permissions'], queryFn: () => permissions.get() })
}

export function PermissionsTab({
  permissions,
  scope,
}: {
  permissions: PermissionsApi
  scope: Scope
}) {
  const view = useAiPermissions(permissions).data
  const contexts = useContexts().data?.contexts
  if (!view || !contexts) return <Loading label="Reading your AI permissions…" />
  return <Editor view={view} contexts={contexts} permissions={permissions} scope={scope} />
}

function Editor({
  view,
  contexts,
  permissions,
  scope,
}: {
  view: AiPermissionsView
  contexts: KubeContext[]
  permissions: PermissionsApi
  scope: Scope
}) {
  const queryClient = useQueryClient()
  const settings = useSettings().data
  const [edited, setEdited] = useState<AiPermissions>()
  const [saving, setSaving] = useState<'saving' | 'saved' | { error: string }>()
  const [open, setOpen] = useState<string>()
  const mine = edited ?? view.mine

  // Kept a moment after the last change; what couldn't be kept says why, and is tried again.
  useEffect(() => {
    if (!edited) return
    const timer = setTimeout(() => {
      setSaving('saving')
      permissions.set(edited).then(
        (kept) => {
          // What was edited is let go of as the page's copy of what's kept arrives, in one: never
          // a moment showing what was there before (a rule's edits lost, or the rule gone).
          notifyManager.batch(() => {
            queryClient.setQueryData(['ai-permissions'], kept)
            notifyManager.schedule(() =>
              setEdited((current) => (current === edited ? undefined : current)),
            )
          })
          setSaving('saved')
        },
        (error: Error) => setSaving({ error: error.message }),
      )
    }, SAVE_MS)
    return () => clearTimeout(timer)
  }, [edited, permissions, queryClient])

  const policy: AiPolicy = useMemo(() => ({ mine, admin: view.admin }), [mine, view.admin])
  const decide = useMemo(() => decider(policy), [policy])
  const index = useNamespaceIndex(contexts)
  const decided = useMemo(
    () => index.namespaces.map((ns) => ({ ns, decision: decide(targetOf(ns)) })),
    [index, decide],
  )
  const readOnly = (cluster: string) => readOnlyIn(settings, cluster)

  const setRules = (rules: AiRule[]) => setEdited({ ...mine, rules })
  const addRule = () => {
    const id = `rule-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    setRules([...mine.rules, { id, name: 'New rule', clusters: [], namespaces: [], set: {} }])
    setOpen(id)
  }

  return (
    <div className="flex flex-wrap items-start gap-5">
      <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-5">
        {view.problem && (
          <p
            role="alert"
            className="flex gap-2.5 rounded-xl border border-critical/25 bg-critical/8 px-3.5 py-2.5 text-[13px] leading-snug text-ink-1"
          >
            <CircleAlert className="mt-px size-4 shrink-0 text-critical-text" />
            <span>{view.problem}</span>
          </p>
        )}
        {view.kept === 'memory' && (
          <p
            role="note"
            className="flex gap-2.5 rounded-xl border border-warn/40 bg-warn/10 px-3.5 py-2.5 text-[13px] leading-snug text-ink-1"
          >
            <CircleAlert className="mt-px size-4 shrink-0 text-warn-text" />
            <span>
              This server keeps AI permissions in memory: when it restarts, yours are gone, and
              assistants do what the defaults say until you set them again. Its administrator can
              keep them (LUMOVI_DATA_DIR, or the Helm chart).
            </span>
          </p>
        )}
        {api.access && (
          <p className="flex gap-2.5 rounded-xl bg-surface-2 px-3.5 py-2.5 text-[13px] leading-snug text-ink-2">
            <ShieldCheck className="mt-px size-4 shrink-0 text-ink-3" aria-hidden />
            <span>
              Your access caps them too: where Lumovi’s admins don’t let you do something, your
              assistants don’t either, whatever these say.{' '}
              <Link to="/your-access" className="font-medium text-accent-strong hover:underline">
                See your access
              </Link>
            </span>
          </p>
        )}
        <Stats decided={decided} index={index} readOnly={readOnly} />
        <Defaults
          defaults={mine.defaults}
          admin={view.admin}
          onChange={(defaults) => setEdited({ ...mine, defaults })}
        />
        <section aria-labelledby="ai-rules" className="flex flex-col gap-2.5">
          <div className="mt-1 flex flex-wrap items-end gap-4">
            <div className="min-w-0 flex-[1_1_340px]">
              <h2 id="ai-rules" className="text-[15px] font-semibold tracking-[-0.01em] text-ink-1">
                Rules{' '}
                <span className="ml-1 font-mono text-xs font-normal text-ink-3">
                  {view.admin.length + mine.rules.length}
                </span>
              </h2>
              <p className="mt-1 max-w-[640px] text-[13px] text-ink-2">
                A rule matches{' '}
                {scope === 'desktop' ? 'contexts and ' : scope === 'fleet' ? 'clusters and ' : ''}
                namespaces by name, pattern or label, so one rule covers thousands. Where rules
                overlap, the strictest wins, setting by setting. A rule that names namespaces is
                about what’s in them; a cluster’s own objects (nodes, custom resource definitions,
                cluster roles…) are read as the rules that name none say, and changing one can reach
                every namespace, so it’s only as allowed as every namespace is.
                {view.admin.length > 0 && ' Your administrator’s always win.'}
              </p>
              <ClusterWide decided={decided} decide={decide} />
            </div>
            <Saving state={saving} onRetry={() => edited && setEdited({ ...edited })} />
            <Button variant="primary" onClick={addRule}>
              <Plus /> Add rule
            </Button>
          </div>
          {view.admin.map((rule) => (
            <RuleCard key={rule.name} rule={rule} admin decided={decided} scope={scope} />
          ))}
          {mine.rules.map((rule) => (
            <RuleCard
              key={rule.id}
              rule={rule}
              decided={decided}
              scope={scope}
              open={open === rule.id}
              onToggle={() => setOpen(open === rule.id ? undefined : rule.id)}
            >
              <RuleEditor
                rule={rule}
                onChange={(next) => setRules(mine.rules.map((r) => (r.id === rule.id ? next : r)))}
                onRemove={() => {
                  setRules(mine.rules.filter((r) => r.id !== rule.id))
                  setOpen(undefined)
                }}
                onDone={() => setOpen(undefined)}
                contexts={contexts}
                index={index}
                decided={decided}
                admin={view.admin}
                scope={scope}
              />
            </RuleCard>
          ))}
          {mine.rules.length === 0 && (
            <p className="rounded-xl border border-dashed border-line-strong px-4 py-3 text-[13px] text-ink-3">
              No rules of your own yet: add one to say what assistants may do in some{' '}
              {scope === 'single' ? 'namespaces' : 'clusters or namespaces'}.
            </p>
          )}
        </section>
      </div>
      <aside
        aria-label="What assistants may do where"
        className="flex min-w-0 flex-[1_1_320px] flex-col gap-4"
      >
        <Check decided={decided} index={index} readOnly={readOnly} scope={scope} />
        <Told policy={policy} contexts={contexts} decide={decide} readOnly={readOnly} />
      </aside>
    </div>
  )
}

/**
 * The clusters whose own objects assistants can't change: a change to one
 * reaches every namespace, and some of theirs are hidden, refused, or hide
 * their Secrets.
 */
function ClusterWide({
  decided,
  decide,
}: {
  decided: Decided
  decide: (target: AiTarget) => AiDecision
}) {
  const everywhere = new Map<string, AiDecision>()
  for (const { ns, decision } of decided) {
    const cluster = ns.cluster.name
    everywhere.set(
      cluster,
      stricter(everywhere.get(cluster) ?? decide({ cluster: ns.cluster }), decision),
    )
  }
  const blocked = [...everywhere]
    .filter(
      ([, d]) =>
        d.visibility.value === 'hidden' ||
        d.changes.value === 'never' ||
        d.secrets.value === 'hidden',
    )
    .map(([cluster]) => cluster)
  if (!blocked.length) return null
  return (
    <p className="mt-1.5 flex max-w-[640px] items-start gap-1.5 text-xs text-warn-text">
      <Lock className="mt-0.5 size-3 shrink-0" />
      Assistants can’t change the cluster’s own objects in {blocked.join(', ')}: some of their
      namespaces are hidden, refused, or hide their Secrets.
    </p>
  )
}

/** Whether they're kept: saving, saved, or why they couldn't be. */
function Saving({
  state,
  onRetry,
}: {
  state: 'saving' | 'saved' | { error: string } | undefined
  onRetry: () => void
}) {
  if (!state) return null
  if (typeof state === 'object') {
    return (
      <p role="alert" className="flex items-center gap-2 text-xs text-critical-text">
        <CircleAlert className="size-3.5 shrink-0" />
        <span className="selectable">Not kept: {state.error}</span>
        <Button variant="ghost" className="h-7 px-2 text-xs" onClick={onRetry}>
          Try again
        </Button>
      </p>
    )
  }
  return (
    <p role="status" className="text-xs text-ink-3">
      {state === 'saving' ? 'Keeping…' : 'Kept'}
    </p>
  )
}

type Decided = { ns: IndexedNamespace; decision: AiDecision }[]

/** What assistants may do, counted over every namespace: what they see, change, and read. */
function Stats({
  decided,
  index,
  readOnly,
}: {
  decided: Decided
  index: NamespaceIndex
  readOnly: (cluster: string) => boolean
}) {
  const counts = tally(decided, readOnly)
  const stats = [
    {
      value: counts.seen,
      label: `namespaces assistants see${counts.hidden ? ` (${formatCount(counts.hidden)} hidden)` : ''}`,
    },
    { value: counts.asking, label: 'where changes ask you first' },
    { value: counts.unasked, label: 'where changes are made without asking' },
    { value: counts.logs, label: 'where they may read logs' },
    { value: counts.values, label: 'where they may read Secret values' },
  ]
  return (
    <section aria-label="At a glance">
      <div className="flex flex-wrap gap-px overflow-hidden rounded-xl border border-line bg-line">
        {stats.map((stat) => (
          <div key={stat.label} className="flex-[1_1_150px] bg-surface px-4 py-3.5">
            <div className="font-mono text-xl font-medium tracking-[-0.02em] text-ink-1">
              {formatCount(stat.value)}
            </div>
            <div className="text-xs text-ink-2">{stat.label}</div>
          </div>
        ))}
      </div>
      {index.counting.length > 0 && (
        <p className="mt-2 text-xs text-ink-3">
          Counting the namespaces in {index.counting.join(', ')}…
        </p>
      )}
      {index.failed.length > 0 && (
        <details className="mt-2 text-xs text-warn-text">
          <summary className="cursor-pointer">
            Not counted: {index.failed.map(({ context }) => context).join(', ')}, whose namespaces
            can’t be listed.
          </summary>
          <ul className="mt-1 space-y-0.5 pl-4 text-ink-3">
            {index.failed.map(({ context, message }) => (
              <li key={context} className="selectable">
                {context}: {message}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

const DEFAULT_KEYS = AI_SETTING_KEYS.filter((key) => key !== 'visibility') as (keyof AiDefaults)[]

/** Where an administrator's rules keep a setting stricter than `value`: what they say. */
function limits<K extends AiSetting>(admin: AiRule[], key: K, value: AiAccess[K]): string[] {
  const order = AI_SETTINGS[key] as readonly string[]
  return admin
    .filter((rule) => rule.set[key] && order.indexOf(rule.set[key]!) > order.indexOf(value))
    .map(
      (rule) =>
        `Your administrator keeps “${rule.name}” at ${(AI_VALUE_LABELS[key] as Record<string, string>)[rule.set[key]!]}.`,
    )
}

const VALUES_WARNING = 'Assistants read Secret values, and send them to their model’s provider.'

/** What assistants may do wherever no rule says otherwise. */
function Defaults({
  defaults,
  admin,
  onChange,
}: {
  defaults: AiDefaults
  admin: AiRule[]
  onChange: (defaults: AiDefaults) => void
}) {
  return (
    <Card as="section" aria-labelledby="ai-defaults">
      <div className="flex flex-wrap items-baseline justify-between gap-3 px-4 py-3.5">
        <h2 id="ai-defaults" className="text-[15px] font-semibold tracking-[-0.01em] text-ink-1">
          Defaults
        </h2>
        <span className="text-xs text-ink-3">Wherever no rule says otherwise</span>
      </div>
      {DEFAULT_KEYS.map((key) => {
        const notes = [
          ...(key === 'secrets' && defaults.secrets === 'values' ? [VALUES_WARNING] : []),
          ...limits(admin, key, defaults[key]),
        ]
        return (
          <div
            key={key}
            className="flex flex-wrap items-center gap-4 border-t border-line px-4 py-3"
          >
            <div className="min-w-0 flex-[1_1_240px]">
              <div className="text-[13px] font-medium text-ink-1">{SETTING_TEXT[key].label}</div>
              <div className="text-xs text-ink-3">{SETTING_TEXT[key].hint}</div>
              <Notes notes={notes} />
            </div>
            <Segmented
              label={SETTING_TEXT[key].label}
              value={defaults[key]}
              choices={choicesOf(key)}
              onChange={(value) => onChange({ ...defaults, [key]: value })}
            />
          </div>
        )
      })}
    </Card>
  )
}

function Notes({ notes }: { notes: string[] }) {
  return notes.map((note) => (
    <p key={note} className="mt-1 flex items-start gap-1.5 text-xs text-warn-text">
      <Lock className="mt-0.5 size-3 shrink-0" />
      {note}
    </p>
  ))
}

/** What a rule says, as short as its card shows it. */
function effects(rule: AiRule, admin: boolean): { text: string; loose: boolean }[] {
  const said = AI_SETTING_KEYS.filter((key) => rule.set[key] !== undefined).map((key) => {
    const value = rule.set[key]!
    const loose = (AI_SETTINGS[key] as readonly string[]).indexOf(value) === 0
    const text =
      admin && key === 'changes' && value === 'ask'
        ? 'Changes always ask'
        : admin && key === 'secrets' && value === 'keys'
          ? 'Never Secret values'
          : EFFECTS[key][value as never]
    return { text, loose: loose && !admin }
  })
  return said.length ? said : [{ text: 'Nothing set yet', loose: false }]
}

const EFFECTS: { [K in AiSetting]: Record<AiAccess[K], string> } = {
  visibility: { visible: 'Visible', hidden: 'Hidden from assistants' },
  changes: { ask: 'Changes ask you', allow: 'Changes without asking', never: 'No changes' },
  secrets: { values: 'Secret values shown', keys: 'Secret keys only', hidden: 'Secrets hidden' },
  env: { show: 'Env values shown', sensitive: 'Sensitive env hidden', all: 'Env values hidden' },
  logs: { read: 'Reads logs', off: 'No logs' },
}

/** Where a rule applies, in a line: its clusters, then its namespaces. */
function whereOf(rule: AiRule, scope: Scope): string {
  const namespaces = rule.namespaces.length ? rule.namespaces.join(', ') : 'all namespaces'
  // One cluster: where in it, unless the rule names clusters (an administrator's may).
  if (scope === 'single' && rule.clusters.length === 0) return namespaces
  const all = scope === 'desktop' ? 'all contexts' : 'all clusters'
  return `${rule.clusters.length ? rule.clusters.join(', ') : all}  /  ${namespaces}`
}

/** What a rule matches, of every namespace counted. */
function matchedBy(rule: AiRule, decided: Decided): IndexedNamespace[] {
  const test = ruleTest(rule)
  return decided.filter(({ ns }) => test(targetOf(ns)) === true).map(({ ns }) => ns)
}

/** "12 namespaces · 3 clusters", or with one cluster, "12 namespaces". */
function counted(matched: IndexedNamespace[], scope: Scope, joiner = ' · '): string {
  const namespaces = plural(matched.length, 'namespace', 'namespaces')
  if (scope === 'single') return namespaces
  const clusters = new Set(matched.map((ns) => ns.cluster.name)).size
  const [one, many] = scope === 'desktop' ? ['context', 'contexts'] : ['cluster', 'clusters']
  return `${namespaces}${joiner}${plural(clusters, one!, many!)}`
}

function RuleCard({
  rule,
  admin = false,
  decided,
  scope,
  open = false,
  onToggle,
  children,
}: {
  rule: AiRule
  admin?: boolean
  decided: Decided
  scope: Scope
  open?: boolean
  onToggle?: () => void
  children?: ReactNode
}) {
  const matched = useMemo(() => matchedBy(rule, decided), [rule, decided])
  const summary = (
    <>
      <span className="flex min-w-0 flex-[1_1_260px] flex-col">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-semibold text-ink-1">{rule.name}</span>
          {admin && (
            <span className="rounded-full border border-line-strong px-1.5 text-2xs text-ink-2">
              Set by your administrator
            </span>
          )}
        </span>
        <span className="truncate font-mono text-xs text-ink-3">{whereOf(rule, scope)}</span>
      </span>
      <span className="flex flex-wrap gap-1.5">
        {effects(rule, admin).map((effect) => (
          <span
            key={effect.text}
            className={cn(
              'rounded-full px-2 py-0.5 text-xs whitespace-nowrap',
              effect.loose ? 'bg-warn/15 text-warn-text' : 'bg-surface-3 text-ink-2',
            )}
          >
            {effect.text}
          </span>
        ))}
      </span>
      <span className="min-w-[150px] text-right text-xs whitespace-nowrap text-ink-3">
        {counted(matched, scope)}
      </span>
    </>
  )
  return (
    <Card
      as="article"
      aria-label={rule.name}
      className={cn(open && 'border-line-strong ring-1 ring-line')}
    >
      {admin ? (
        <div className="flex flex-wrap items-center gap-3 bg-surface-2 px-4 py-3">
          <Lock className="size-4 shrink-0 text-ink-3" />
          {summary}
        </div>
      ) : (
        <>
          <button
            type="button"
            aria-expanded={open}
            onClick={onToggle}
            className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2"
          >
            {summary}
            <ChevronDown
              className={cn(
                'size-4 shrink-0 text-ink-2 transition-transform',
                open && 'rotate-180',
              )}
            />
          </button>
          {open && children}
        </>
      )}
    </Card>
  )
}

function RuleEditor({
  rule,
  onChange,
  onRemove,
  onDone,
  contexts,
  index,
  decided,
  admin,
  scope,
}: {
  rule: AiRule
  onChange: (rule: AiRule) => void
  onRemove: () => void
  onDone: () => void
  contexts: KubeContext[]
  index: NamespaceIndex
  decided: Decided
  admin: AiRule[]
  scope: Scope
}) {
  const [search, setSearch] = useState('')
  const matched = useMemo(() => matchedBy(rule, decided), [rule, decided])
  const contextsAre = scope === 'desktop' ? 'contexts' : 'clusters'
  const suggest = (onCluster: boolean) => (typed: string) =>
    suggestions(typed, onCluster, contexts, index.namespaces, contextsAre)

  // What the administrator keeps stricter, where this rule would loosen it.
  const notes = [
    ...(rule.set.secrets === 'values'
      ? ['Assistants read Secret values here, and send them to their model’s provider.']
      : []),
    ...AI_SETTING_KEYS.flatMap((key) => {
      const value = rule.set[key]
      if (value === undefined) return []
      const order = AI_SETTINGS[key] as readonly string[]
      const stricter = admin.filter(
        (limit) => limit.set[key] && order.indexOf(limit.set[key]!) > order.indexOf(value),
      )
      const tests = stricter.map(ruleTest)
      const capped = matched.filter((ns) => tests.some((test) => test(targetOf(ns)) !== false))
      return capped.length
        ? [
            `${stricter[0]!.name}: ${SETTING_TEXT[key].label} stay at ${(AI_VALUE_LABELS[key] as Record<string, string>)[stricter[0]!.set[key]!]} in ${plural(capped.length, 'of these namespaces', 'of these namespaces')}, as your administrator set.`,
          ]
        : []
    }),
  ]

  const query = search.trim()
  const found = query
    ? matched.filter((ns) => ns.name.includes(query) || ns.cluster.name.includes(query))
    : matched

  return (
    <div className="flex flex-col gap-4 border-t border-line p-4">
      <label className="flex max-w-[360px] flex-col gap-1.5">
        <span className="text-xs font-medium text-ink-2">Name</span>
        <input
          value={rule.name}
          onChange={(event) => onChange({ ...rule, name: event.target.value })}
          className="h-8 rounded-lg border border-line-strong bg-surface px-2.5 text-[13px] text-ink-1 outline-none focus:border-accent focus:ring-3 focus:ring-accent-soft"
        />
      </label>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-4">
        {scope !== 'single' && (
          <MatcherField
            id={`clusters-${rule.id}`}
            label={scope === 'desktop' ? 'Contexts' : 'Clusters'}
            values={rule.clusters}
            onChange={(clusters) => onChange({ ...rule, clusters })}
            placeholder={
              scope === 'desktop'
                ? 'All contexts: add a name or pattern'
                : 'All clusters: add a name or label'
            }
            suggest={suggest(true)}
          />
        )}
        <MatcherField
          id={`namespaces-${rule.id}`}
          label="Namespaces"
          values={rule.namespaces}
          onChange={(namespaces) => onChange({ ...rule, namespaces })}
          placeholder="All namespaces: add a name, pattern or label"
          suggest={suggest(false)}
          hint={
            <>
              Type a name, a pattern like <code className="font-mono">tenant-*</code>, a label like{' '}
              <code className="font-mono">team=payments</code>, or{' '}
              <code className="font-mono">!</code> first to leave one out.
            </>
          }
        />
      </div>
      <div className="overflow-hidden rounded-lg border border-line">
        <div className="bg-surface-2 px-3.5 py-2.5 text-xs font-medium text-ink-2">
          Where it matches, assistants may
        </div>
        {AI_SETTING_KEYS.map((key) => (
          <div
            key={key}
            className="flex flex-wrap items-center gap-4 border-t border-line px-3.5 py-2.5"
          >
            <div className="flex-[1_1_160px] text-[13px] font-medium text-ink-1">
              {SETTING_TEXT[key].label}
            </div>
            <Segmented
              label={SETTING_TEXT[key].label}
              value={rule.set[key]}
              choices={[{ value: undefined, label: 'Not set' }, ...choicesOf(key)]}
              onChange={(value) => {
                const set = { ...rule.set }
                if (value === undefined) delete set[key]
                else Object.assign(set, { [key]: value })
                onChange({ ...rule, set })
              }}
            />
          </div>
        ))}
      </div>
      {notes.length > 0 && (
        <div className="space-y-1.5 rounded-lg bg-warn/10 px-3 py-2.5">
          {notes.map((note) => (
            <p key={note} className="flex items-start gap-2 text-xs text-warn-text">
              <Lock className="mt-0.5 size-3.5 shrink-0" />
              {note}
            </p>
          ))}
        </div>
      )}
      <section
        aria-label="What it matches"
        className="flex flex-col rounded-lg border border-line bg-surface-2"
      >
        <div className="flex flex-wrap items-center gap-3 px-3.5 py-2.5">
          <span className="flex-[1_1_200px] text-xs text-ink-2">
            Matches{' '}
            <strong className="font-semibold text-ink-1">{counted(matched, scope, ' in ')}</strong>
          </span>
          <label className="flex h-8 flex-[0_1_240px] items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-2">
            <Search className="size-3.5 text-ink-3" />
            <input
              type="search"
              aria-label="Find in what it matches"
              placeholder="Find in these"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="min-w-0 flex-1 bg-transparent text-xs text-ink-1 outline-none"
            />
          </label>
        </div>
        {found.length > 0 ? (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-0.5 px-1.5 pb-1.5">
            {found.slice(0, SAMPLE).map((ns) => (
              <li
                key={ns.key}
                className="flex min-w-0 items-center gap-2 rounded-md bg-surface px-2 py-1"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-1">
                  {ns.name}
                </span>
                {scope !== 'single' && (
                  <span className="text-2xs whitespace-nowrap text-ink-3">{ns.cluster.name}</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-3.5 pb-3 text-xs text-ink-3">
            {query ? `None of these has “${query}” in its name.` : 'Nothing matches yet.'}
          </p>
        )}
        {found.length > SAMPLE && (
          <p className="px-3.5 pb-2.5 text-xs text-ink-3">
            And {formatCount(found.length - SAMPLE)} more{query ? ` with “${query}”` : ''}: search
            to find one.
          </p>
        )}
      </section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" className="text-critical-text" onClick={onRemove}>
          Delete rule
        </Button>
        <Button variant="primary" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  )
}

/** A rule's clusters or namespaces: chips, and what's typed, with what it may mean. */
function MatcherField({
  id,
  label,
  values,
  onChange,
  placeholder,
  suggest,
  hint,
}: {
  id: string
  label: string
  values: string[]
  onChange: (values: string[]) => void
  placeholder: string
  suggest: (typed: string) => Suggestion[]
  hint?: ReactNode
}) {
  const [typed, setTyped] = useState('')
  const found = suggest(typed)
  const parsed = typed.trim() ? parseMatcher(typed.trim()) : undefined
  const add = (text: string) => {
    if (!values.includes(text)) onChange([...values, text])
    setTyped('')
  }
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-ink-2">
        {label}
      </label>
      <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-1.5 py-1 focus-within:border-accent focus-within:ring-3 focus-within:ring-accent-soft">
        {values.map((text) => (
          <span
            key={text}
            className="inline-flex h-6 items-center gap-1 rounded-md bg-surface-3 pr-0.5 pl-2 font-mono text-xs text-ink-1"
          >
            {matcherKind(text) && (
              <span className="font-sans text-2xs text-ink-3">{matcherKind(text)}</span>
            )}
            {text}
            <button
              type="button"
              aria-label={`Remove ${text}`}
              onClick={() => onChange(values.filter((value) => value !== text))}
              className="grid size-5 place-items-center rounded text-ink-2 hover:bg-line"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          id={id}
          autoComplete="off"
          value={typed}
          placeholder={values.length ? 'Add another' : placeholder}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && found.length) {
              event.preventDefault()
              add(found[0]!.text)
            } else if (event.key === 'Escape') setTyped('')
            else if (event.key === 'Backspace' && !typed && values.length) {
              onChange(values.slice(0, -1))
            }
          }}
          className="h-6 min-w-[140px] flex-1 bg-transparent text-[13px] text-ink-1 outline-none placeholder:text-ink-3"
        />
      </div>
      {typeof parsed === 'string' && (
        <p role="alert" className="text-xs text-critical-text">
          {parsed}
        </p>
      )}
      {found.length > 0 && (
        <div
          role="group"
          aria-label={`Suggestions for ${label}`}
          className="flex flex-col rounded-lg border border-line-strong bg-surface p-1 shadow-pop"
        >
          {found.map((suggestion) => (
            <button
              key={suggestion.text}
              type="button"
              onClick={() => add(suggestion.text)}
              className="flex min-h-8 items-center gap-2 rounded-md px-2 text-left hover:bg-accent-soft"
            >
              <span className="w-14 text-2xs text-ink-3">{suggestion.kind}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-1">
                {suggestion.text}
              </span>
              <span
                className={cn(
                  'text-xs whitespace-nowrap',
                  suggestion.none ? 'text-warn-text' : 'text-ink-3',
                )}
              >
                {suggestion.none ? 'none yet' : suggestion.count}
              </span>
            </button>
          ))}
        </div>
      )}
      {hint && <p className="text-xs text-ink-3">{hint}</p>}
    </div>
  )
}

/** Any namespace: what assistants may do there, and which rule says so. */
function Check({
  decided,
  index,
  readOnly,
  scope,
}: {
  decided: Decided
  index: NamespaceIndex
  readOnly: (cluster: string) => boolean
  scope: Scope
}) {
  const [typed, setTyped] = useState('')
  const [chosen, setChosen] = useState<string>()
  const query = typed.trim()
  const found = query
    ? decided
        .filter(({ ns }) => ns.name.includes(query))
        .sort(
          (a, b) =>
            Number(b.ns.name.startsWith(query)) - Number(a.ns.name.startsWith(query)) ||
            a.ns.name.length - b.ns.name.length ||
            a.ns.name.localeCompare(b.ns.name),
        )
    : []
  const shown = decided.find(({ ns }) => ns.key === chosen) ?? decided[0]
  const pick = (key: string) => {
    setChosen(key)
    setTyped('')
  }
  return (
    <Card as="section" aria-labelledby="ai-check" className="flex flex-col gap-3 p-4">
      <div>
        <h2 id="ai-check" className="text-[15px] font-semibold tracking-[-0.01em] text-ink-1">
          Check a namespace
        </h2>
        <p className="mt-0.5 text-xs text-ink-3">What an assistant may do there, and why.</p>
      </div>
      <label className="flex h-9 items-center gap-2 rounded-lg border border-line-strong bg-surface px-2.5 focus-within:border-accent focus-within:ring-3 focus-within:ring-accent-soft">
        <Search className="size-3.5 text-ink-3" />
        <input
          type="search"
          aria-label="Namespace"
          autoComplete="off"
          placeholder={`Search ${plural(index.namespaces.length, 'namespace', 'namespaces')}`}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && found.length) pick(found[0]!.ns.key)
            else if (event.key === 'Escape') setTyped('')
          }}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-ink-1 outline-none"
        />
      </label>
      {query && (
        <div
          role="group"
          aria-label="Namespaces found"
          className="-mt-1.5 flex flex-col rounded-lg border border-line-strong p-1 shadow-pop"
        >
          {found.slice(0, 7).map(({ ns }) => (
            <button
              key={ns.key}
              type="button"
              onClick={() => pick(ns.key)}
              className="flex min-h-8 items-center gap-2 rounded-md px-2 text-left hover:bg-accent-soft"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-1">
                {ns.name}
              </span>
              <span className="text-2xs whitespace-nowrap text-ink-3">{ns.cluster.name}</span>
            </button>
          ))}
          <p className="px-2 py-1 text-2xs text-ink-3">
            {found.length === 0
              ? `No namespace has “${query}” in its name.`
              : found.length > 7
                ? `${formatCount(found.length)} found: type more to narrow them down`
                : `${formatCount(found.length)} found`}
          </p>
        </div>
      )}
      {shown && <Decision shown={shown} readOnly={readOnly} />}
      <p className="text-xs text-ink-3">
        {scope === 'desktop'
          ? 'What your kubeconfig’s user may do (RBAC) applies after these, and a cluster you made read-only takes no changes.'
          : 'Your own access (RBAC) applies after these: Lumovi never gives an assistant more than you have.'}
      </p>
    </Card>
  )
}

function Decision({
  shown: { ns, decision },
  readOnly,
}: {
  shown: Decided[number]
  readOnly: (cluster: string) => boolean
}) {
  const hidden = decision.visibility.value === 'hidden'
  return (
    <div className="flex flex-col gap-2">
      <div className="font-mono text-[15px] font-medium break-all text-ink-1">{ns.name}</div>
      <div className="flex flex-wrap gap-1.5">
        <span className="inline-flex items-center gap-1 rounded-full bg-ink-1 px-2 text-2xs text-surface">
          <Server className="size-2.5" /> {ns.cluster.name}
        </span>
        {/* Not the label every namespace has, which only says its name. */}
        {Object.entries(ns.labels)
          .filter(([key]) => key !== NAME_LABEL)
          .map(([key, value]) => (
            <span
              key={key}
              className="rounded-full bg-surface-3 px-2 font-mono text-2xs text-ink-2"
            >
              {key}={value}
            </span>
          ))}
      </div>
      <dl className="overflow-hidden rounded-lg border border-line">
        {AI_SETTING_KEYS.map((key) => {
          const blank = hidden && key !== 'visibility'
          const { value, from } = decision[key]
          const locked = key === 'changes' && !blank && readOnly(ns.cluster.name)
          const shownValue = blank
            ? '—'
            : locked
              ? 'Never: read-only'
              : (AI_VALUE_LABELS[key] as Record<string, string>)[value]
          const loose =
            !blank &&
            !locked &&
            ((key === 'changes' && value === 'allow') || (key === 'secrets' && value === 'values'))
          return (
            <div key={key} className="flex gap-3 border-t border-line px-3 py-2 first:border-t-0">
              <dt className="w-[92px] shrink-0 text-[13px] text-ink-2">
                {SETTING_TEXT[key].label}
              </dt>
              <dd className="min-w-0 flex-1">
                <div
                  className={cn(
                    'text-[13px] font-semibold',
                    blank ? 'text-ink-3' : loose ? 'text-warn-text' : 'text-ink-1',
                  )}
                >
                  {shownValue}
                </div>
                <div className="text-xs text-ink-3">
                  {blank
                    ? 'Hidden namespaces show nothing'
                    : locked
                      ? 'The cluster is read-only'
                      : sourceText(from)}
                </div>
              </dd>
            </div>
          )
        })}
      </dl>
    </div>
  )
}

/** What assistants are told about the cluster of the namespace checked, as list_clusters says it. */
function Told({
  policy,
  contexts,
  decide,
  readOnly,
}: {
  policy: AiPolicy
  contexts: KubeContext[]
  decide: (target: AiTarget) => AiDecision
  readOnly: (cluster: string) => boolean
}) {
  const visible = contexts.filter(
    (context) => decide({ cluster: context }).visibility.value !== 'hidden',
  )
  const told = visible.map((context) =>
    clusterForAssistant(policy, context, readOnly(context.name)),
  )
  return (
    <Card as="section" aria-labelledby="ai-told" className="flex flex-col gap-2 p-4">
      <h2 id="ai-told" className="text-[13px] font-semibold text-ink-1">
        Assistants know their limits
      </h2>
      <p className="text-xs text-ink-2">
        As they start, assistants are told what each cluster lets them do, so they don’t try what
        they can’t, and can tell you why. What a rule hides, they never learn exists.
      </p>
      <pre
        aria-label="What assistants are told"
        className="mt-1 max-h-[420px] overflow-auto rounded-lg bg-[#262626] px-3 py-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-[#ededed] selectable"
      >
        {stringify(told, { lineWidth: 0, aliasDuplicateObjects: false })}
      </pre>
    </Card>
  )
}

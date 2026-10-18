/**
 * Add a cluster → From AWS (the desktop app's): the person's EKS clusters, found with their own
 * `aws` CLI only as they ask, by profile and region, each to add as any other kubeconfig is. What
 * was found is the dialog's (AwsState), so its list is there again once one is added.
 */
import { LoaderCircle, Search, TriangleAlert } from 'lucide-react'
import { Fragment, useState } from 'react'
import type { AwsCluster, AwsFound } from '@shared/api'
import { Button } from '@renderer/components/Button'
import { CopyButton } from '@renderer/components/CopyButton'
import { useContexts } from '@renderer/hooks/queries'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'

/** What From AWS has: the profiles `aws` knows, those ticked with their regions, what was found. */
export interface AwsState {
  profiles?: string[]
  ticked: Record<string, boolean>
  regions: Record<string, string>
  found?: AwsFound[]
}

export const NO_AWS: AwsState = { ticked: {}, regions: {} }

/** EKS's word for a cluster, as Lumovi says it (nothing for one that's active), and whether it's added. */
const STATUS: Record<string, { word?: string; addable: boolean; failed?: true }> = {
  ACTIVE: { addable: true },
  UPDATING: { word: 'Updating', addable: true },
  CREATING: { word: 'Being created', addable: false },
  DELETING: { word: 'Being deleted', addable: false },
  FAILED: { word: 'Failed', addable: false, failed: true },
  PENDING: { word: 'Pending', addable: false },
}

export function FromAws({
  state,
  onState,
  onAdd,
  onError,
}: {
  state: AwsState
  onState: (change: (state: AwsState) => AwsState) => void
  /** A cluster found, to add: its kubeconfig checked as a pasted one is. */
  onAdd: (cluster: AwsCluster) => void
  onError: (error?: string) => void
}) {
  const [busy, setBusy] = useState(false)
  // Those added already: a context of their name, at their server's address.
  const here = new Set(
    (useContexts().data?.contexts ?? []).flatMap((context) =>
      context.server ? [`${context.name} ${context.server}`] : [],
    ),
  )
  const { profiles, ticked, regions, found } = state

  const listProfiles = async () => {
    setBusy(true)
    onError(undefined)
    const result = await api.addedClusters!.awsProfiles()
    setBusy(false)
    if (!result.ok) return onError(result.error.message)
    const { profiles: names, regions: set } = result.data
    // The default one ticked: "default" where there is one.
    const first = names.includes('default') ? 'default' : names[0]
    onState(() => ({
      profiles: names,
      ticked: first ? { [first]: true } : {},
      regions: Object.fromEntries(names.map((name) => [name, set[name] ?? ''])),
    }))
  }

  const find = async () => {
    const asks = (profiles ?? [])
      .filter((profile) => ticked[profile])
      .map((profile) => ({
        profile,
        regions: (regions[profile] ?? '')
          .split(/[\s,]+/)
          .map((region) => region.trim())
          .filter(Boolean),
      }))
      .filter(({ regions }) => regions.length > 0)
    if (asks.length === 0) return onError('Tick a profile, with a region to look in.')
    setBusy(true)
    onError(undefined)
    const result = await api.addedClusters!.awsFind(asks)
    setBusy(false)
    if (!result.ok) return onError(result.error.message)
    onState((now) => ({ ...now, found: result.data }))
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-ink-3">
        Lumovi runs <code className="font-mono">aws</code> as you, with the profiles you tick from
        your AWS config. If a profile signs in through a program of its own (credential_process,
        say), that program runs too.
      </p>
      {profiles && profiles.length === 0 && (
        <Problem
          lead="aws has no profiles."
          text=" Set one up with `aws configure` (or `aws configure sso`), then choose **Find clusters** again."
        />
      )}
      {profiles && profiles.length > 0 && (
        <div>
          <div
            aria-hidden
            className="mb-1 grid grid-cols-[2fr_3fr] gap-3 text-2xs font-medium tracking-wider text-ink-3 uppercase"
          >
            <span>Profile</span>
            <span>Regions</span>
          </div>
          <ul aria-label="Profiles" className="flex flex-col gap-1.5">
            {profiles.map((profile) => (
              <li key={profile} className="grid grid-cols-[2fr_3fr] items-center gap-3">
                <label className="flex min-w-0 items-center gap-2 text-[13px] text-ink-1">
                  <input
                    type="checkbox"
                    checked={!!ticked[profile]}
                    onChange={(event) =>
                      onState((now) => ({
                        ...now,
                        ticked: { ...now.ticked, [profile]: event.target.checked },
                      }))
                    }
                  />
                  <span className="truncate">{profile}</span>
                </label>
                <input
                  aria-label={`Region for ${profile}`}
                  value={regions[profile] ?? ''}
                  placeholder="eu-west-1, us-east-1"
                  disabled={!ticked[profile]}
                  onChange={(event) =>
                    onState((now) => ({
                      ...now,
                      regions: { ...now.regions, [profile]: event.target.value },
                    }))
                  }
                  className="h-7 w-full rounded-md border border-line-strong bg-surface px-2 font-mono text-xs text-ink-1 outline-none placeholder:text-ink-3 focus:border-accent focus:ring-3 focus:ring-accent-soft disabled:opacity-50"
                />
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <Button
          variant={found ? 'secondary' : 'primary'}
          disabled={busy}
          onClick={() => void (profiles ? find() : listProfiles())}
        >
          {busy ? <LoaderCircle className="animate-spin" /> : <Search />} Find clusters
        </Button>
      </div>
      {found?.map((one) => {
        const heading = `AWS · ${one.profile}${one.account ? ` (${one.account})` : ''} · ${one.region}`
        return (
          <section key={`${one.profile} ${one.region}`} aria-label={heading}>
            <h3 className="mb-1.5 text-xs font-semibold text-ink-2">{heading}</h3>
            {one.problem && <Problem text={one.problem} />}
            {one.note && <p className="text-xs text-ink-3">{one.note}</p>}
            {one.clusters.length > 0 && (
              <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
                {one.clusters.map((cluster) => (
                  <Found
                    key={cluster.name}
                    cluster={cluster}
                    added={!!cluster.server && here.has(`${cluster.name} ${cluster.server}`)}
                    onAdd={() => onAdd(cluster)}
                  />
                ))}
              </ul>
            )}
          </section>
        )
      })}
    </div>
  )
}

/** A cluster found: its version and state, and Add where it can be added. */
function Found({
  cluster,
  added,
  onAdd,
}: {
  cluster: AwsCluster
  added: boolean
  onAdd: () => void
}) {
  const status = cluster.status ? STATUS[cluster.status] : undefined
  const addable = !!cluster.kubeconfig && (status?.addable ?? !cluster.status)
  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block truncate text-[13px] font-medium',
            cluster.unaddable ? 'text-ink-2' : 'text-ink-1',
          )}
        >
          {cluster.name}
        </span>
        <span className="flex items-center gap-1.5 text-xs text-ink-3">
          {cluster.unaddable ?? (
            <>
              {cluster.version && `Kubernetes ${cluster.version}`}
              {status?.word && (
                <>
                  {cluster.version && <span aria-hidden>·</span>}
                  <span
                    aria-hidden
                    className={cn(
                      'size-1.5 rounded-full',
                      status.failed ? 'bg-critical' : 'bg-ink-3',
                    )}
                  />
                  <span className={cn(status.failed && 'text-critical-text')}>{status.word}</span>
                </>
              )}
            </>
          )}
        </span>
      </span>
      {added ? (
        <span className="text-xs text-ink-3">Added</span>
      ) : (
        addable && (
          <Button variant="secondary" aria-label={`Add ${cluster.name}`} onClick={onAdd}>
            Add
          </Button>
        )
      )}
    </li>
  )
}

/**
 * Why nothing could be found, in Lumovi's words: a sign-in that ran out, say, its first words in
 * warning; a command in it as code, to copy; what to choose in bold.
 */
function Problem({ text, lead: given }: { text: string; lead?: string }) {
  const [lead, rest] =
    given !== undefined
      ? [given, text]
      : text.includes(': ')
        ? [text.slice(0, text.indexOf(': ') + 1), text.slice(text.indexOf(': ') + 1)]
        : ['', text]
  return (
    <p className="mb-1.5 flex items-start gap-1.5 text-xs leading-relaxed text-ink-2">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warn-text" />
      <span>
        {lead && <span className="text-warn-text">{lead}</span>}
        {rest.split(/(`[^`]+`|\*\*[^*]+\*\*)/).map((part, index) =>
          part.startsWith('`') ? (
            <span
              key={index}
              className="inline-flex items-center gap-0.5 rounded-md bg-surface-3 pl-1.5 align-middle"
            >
              <code className="font-mono">{part.slice(1, -1)}</code>
              <CopyButton text={part.slice(1, -1)} label={`Copy ${part.slice(1, -1)}`} />
            </span>
          ) : part.startsWith('**') ? (
            <strong key={index} className="font-semibold">
              {part.slice(2, -2)}
            </strong>
          ) : (
            <Fragment key={index}>{part}</Fragment>
          ),
        )}
      </span>
    </p>
  )
}

import { CircleAlert, CircleCheck, Lock, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import type {
  HelmRepositories,
  HelmRepository,
  HelmRepositoryInput,
  HelmRepositoryTest,
} from '@shared/api'
import { addressOf, sameOrigin, signInGoes } from '@shared/helm-repositories'
import { Button } from '@renderer/components/Button'
import { useRepositoryChange } from '@renderer/hooks/helm'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { ActionDialog, useSubmit } from '../actions/ActionDialog'

const field =
  'h-8 w-full rounded-lg border border-line-strong bg-surface px-2.5 font-mono text-xs text-ink-1 outline-none focus:border-accent focus:ring-3 focus:ring-accent-soft disabled:bg-surface-3/50 disabled:text-ink-3'

/** Where repositories are kept, as a dialog's subject says it. */
export const keptWhere = (kept: HelmRepositories['kept']) =>
  kept === 'server'
    ? 'Helm repositories · kept on this server, for everyone who uses it'
    : 'Helm repositories · kept on this computer, for every cluster'

/** A registry's host, as `helm registry login` takes it. */
const hostOf = (url: string) => url.replace(/^oci:\/\//i, '').split('/')[0]!

/** What Test connection found, in Lumovi's words. */
function tested(found: HelmRepositoryTest): string {
  if ('charts' in found) {
    return `Connected: its index lists ${found.charts} ${found.charts === 1 ? 'chart' : 'charts'}.`
  }
  const [first, ...rest] = found.found
  const versions = (n: number) => `${n} ${n === 1 ? 'version' : 'versions'}`
  return `Connected: ${[
    first ? `${first.chart} has ${versions(first.versions)}` : '',
    ...rest.map((each) => `${each.chart} ${each.versions}`),
  ].join(', ')}.`
}

/** Test connection, beside what it found: as given (a sign-in left out, the saved one's). */
export function useRepositoryTest() {
  const [result, setResult] = useState<{ ok: boolean; text: string }>()
  const [testing, setTesting] = useState(false)
  const test = async (input: HelmRepositoryInput, saved: boolean) => {
    setTesting(true)
    const found = await api.helm.repositories.test(input)
    setTesting(false)
    setResult(
      found.ok
        ? { ok: true, text: tested(found.data) }
        : {
            ok: false,
            text:
              found.error.message +
              (saved && /^Couldn’t sign in: 401/.test(found.error.message)
                ? ` The saved ${input.kind === 'oci' ? 'token' : 'password'} may have changed: replace it.`
                : ''),
          },
    )
  }
  return { result, testing, test, clear: () => setResult(undefined) }
}

/** What Test connection said: a tick and what it found, or why it couldn't. */
export function TestResult({ result }: { result?: { ok: boolean; text: string } }) {
  if (!result) return null
  const Icon = result.ok ? CircleCheck : CircleAlert
  return (
    <span
      role={result.ok ? 'status' : 'alert'}
      className={cn(
        'flex min-w-0 items-start gap-1.5 text-xs',
        result.ok ? 'text-ink-2' : 'text-critical-text',
      )}
    >
      <Icon className={cn('mt-px size-3.5 shrink-0', result.ok && 'text-good-text')} />
      <span className="min-w-0 [overflow-wrap:anywhere]">{result.text}</span>
    </span>
  )
}

/**
 * Adds a repository (HTTP, or an OCI registry with the charts to look for in it), or edits one.
 * A sign-in's secret is typed once and never shown again: editing, it's "Saved", replaced only by
 * typing a new one; changing the address's scheme, host or port removes it.
 */
export function RepositoryDialog({
  state,
  repository,
  onClose,
}: {
  state: HelmRepositories
  /** The one edited; none, one added. */
  repository?: HelmRepository
  onClose: () => void
}) {
  const changes = useRepositoryChange()
  const editing = repository !== undefined
  const [kind, setKind] = useState<HelmRepository['kind']>(repository?.kind ?? 'http')
  const [name, setName] = useState(repository?.name ?? '')
  const [url, setUrl] = useState(repository?.url ?? '')
  const [charts, setCharts] = useState<string[]>(repository?.charts ?? [])
  const [chartText, setChartText] = useState('')
  const [needsSignIn, setNeedsSignIn] = useState(repository?.username !== undefined)
  const [username, setUsername] = useState(repository?.username ?? '')
  const [secret, setSecret] = useState('')
  // The saved secret is kept until it's replaced (or the address moves elsewhere).
  const [replacing, setReplacing] = useState(false)
  const { result, testing, test, clear } = useRepositoryTest()
  const { pending, error, submit } = useSubmit(onClose)

  const address = url.trim() ? addressOf(kind, url) : undefined
  const parsed = address && 'url' in address ? address.url : undefined
  // A sign-in goes over https alone: over http none can be added.
  const plainHttp = parsed !== undefined && !signInGoes(parsed)
  const noKeeping = state.noSignIns
  const canSignIn = !plainHttp && !noKeeping
  const moved =
    editing &&
    repository.username !== undefined &&
    parsed !== undefined &&
    !sameOrigin(repository.url, url, repository.kind)
  // The saved one still holds: same place, same user, not being replaced.
  const keepsSaved =
    editing &&
    repository.username !== undefined &&
    !moved &&
    !replacing &&
    username.trim() === repository.username
  const signedIn = needsSignIn && canSignIn
  const secretWord = kind === 'oci' ? 'Token' : 'Password'

  const input = (): HelmRepositoryInput => ({
    ...(editing ? { id: repository.id } : {}),
    name: name.trim(),
    kind,
    url: url.trim(),
    ...(kind === 'oci' ? { charts } : {}),
    signIn: signedIn ? { username: username.trim(), ...(keepsSaved ? {} : { secret }) } : null,
  })
  const ready =
    name.trim() !== '' &&
    parsed !== undefined &&
    (kind === 'http' || charts.length > 0) &&
    (!signedIn || (username.trim() !== '' && (keepsSaved || secret !== '')))

  const addChart = () => {
    const chart = chartText.trim()
    if (chart && !charts.includes(chart)) setCharts([...charts, chart])
    setChartText('')
    clear()
  }

  const signInArgs = signedIn
    ? ` --username ${username.trim() || '<username>'} --password-stdin`
    : ''
  const command =
    kind === 'oci'
      ? signedIn
        ? `helm registry login ${hostOf(url) || '<registry>'}${signInArgs}`
        : `helm show chart ${url.trim().replace(/\/+$/, '') || 'oci://<registry>'}/${charts[0] ?? '<chart>'}`
      : `helm repo add ${name.trim() || '<name>'} ${url.trim() || '<address>'}${signInArgs}${editing ? ' --force-update' : ''}`
  const commandNote =
    kind === 'oci'
      ? `Lumovi keeps registries itself, not in Helm’s own list: this is how Helm would ${signedIn ? 'sign in to it' : 'read one of its charts'}.`
      : 'Lumovi keeps repositories itself, not in Helm’s own list: this is how Helm would add it.'

  return (
    <ActionDialog
      icon={editing ? Pencil : Plus}
      title={editing ? `Edit ${repository.name}` : 'Add a repository'}
      name={editing ? repository.name : undefined}
      subject={keptWhere(state.kept)}
      cluster={false}
      command={command}
      commandNote={commandNote}
      confirmLabel={editing ? 'Save' : 'Add repository'}
      ready={ready}
      pending={pending}
      error={error}
      onClose={onClose}
      onSubmit={() => void submit(() => changes.save(input()))}
    >
      {!editing && (
        <div
          role="radiogroup"
          aria-label="Kind"
          className="inline-flex rounded-lg border border-line bg-surface-3/50 p-0.5"
        >
          {(
            [
              ['http', 'HTTP repository'],
              ['oci', 'OCI registry'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={kind === value}
              onClick={() => {
                setKind(value)
                clear()
              }}
              className={cn(
                'h-7 rounded-md px-2.5 text-xs font-medium text-ink-2',
                kind === value && 'bg-surface text-ink-1 shadow-sm',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-2">Name</span>
          <input
            aria-label="Name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            spellCheck={false}
            autoComplete="off"
            className={field}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-2">
            {kind === 'oci' ? 'Registry' : 'Address'}
          </span>
          <input
            aria-label={kind === 'oci' ? 'Registry' : 'Address'}
            value={url}
            placeholder={
              kind === 'oci' ? 'oci://ghcr.io/acme/charts' : 'https://charts.example.com'
            }
            onChange={(event) => {
              setUrl(event.target.value)
              clear()
            }}
            spellCheck={false}
            autoComplete="off"
            className={field}
          />
        </label>
        {(address && 'problem' in address) || moved ? (
          <p
            role={moved ? undefined : 'alert'}
            className={cn(
              'col-span-2 -mt-1.5 text-xs',
              moved ? 'text-ink-2' : 'text-critical-text',
            )}
          >
            {moved
              ? 'Changing the host removes its sign-in. Enter it again for the new address.'
              : (address as { problem: string }).problem}
          </p>
        ) : null}
      </div>
      {kind === 'oci' && (
        <div>
          <span className="mb-1 block text-xs font-medium text-ink-2">Charts</span>
          <div className="flex min-h-8 flex-wrap items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-1.5 py-1 focus-within:border-accent focus-within:ring-3 focus-within:ring-accent-soft">
            {charts.map((chart) => (
              <span
                key={chart}
                className="inline-flex h-6 items-center gap-1 rounded-md bg-surface-3 pr-0.5 pl-2 font-mono text-xs text-ink-1"
              >
                {chart}
                <button
                  type="button"
                  aria-label={`Remove ${chart}`}
                  onClick={() => {
                    setCharts(charts.filter((c) => c !== chart))
                    clear()
                  }}
                  className="grid size-5 place-items-center rounded text-ink-3 hover:bg-surface-2 hover:text-ink-1"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
            <input
              aria-label="Add a chart’s name"
              placeholder="Add a chart’s name"
              value={chartText}
              onChange={(event) => setChartText(event.target.value)}
              onKeyDown={(event) => {
                // Adds the chart, rather than submitting the dialog.
                if (event.key === 'Enter' || event.key === ',') {
                  event.preventDefault()
                  addChart()
                } else if (event.key === 'Backspace' && chartText === '' && charts.length) {
                  setCharts(charts.slice(0, -1))
                }
              }}
              onBlur={addChart}
              spellCheck={false}
              autoComplete="off"
              className="h-6 min-w-32 flex-1 bg-transparent px-1 font-mono text-xs text-ink-1 outline-none"
            />
          </div>
          <p className="mt-1 text-xs text-ink-3">
            A registry has no index to browse: name the charts Lumovi should look for. It reads
            their versions from the registry’s tags.
          </p>
        </div>
      )}
      <div className="space-y-2.5 rounded-lg border border-line p-3">
        <label className={cn('flex items-center gap-2 text-[13px]', !canSignIn && 'text-ink-3')}>
          <input
            type="checkbox"
            checked={signedIn}
            disabled={!canSignIn}
            onChange={(event) => {
              setNeedsSignIn(event.target.checked)
              clear()
            }}
            className="accent-[var(--accent)]"
          />
          It needs a sign-in
        </label>
        {noKeeping ? (
          <div className="flex gap-2 rounded-lg bg-surface-3/60 px-3 py-2.5 text-xs text-ink-2">
            <Lock className="mt-0.5 size-3.5 shrink-0 text-ink-3" />
            <p>
              <span className="block font-medium text-ink-1">
                Lumovi can’t keep a password here.
              </span>
              {noKeeping}
            </p>
          </div>
        ) : plainHttp ? (
          <p className="flex gap-2 text-xs text-ink-3">
            <Lock className="mt-0.5 size-3.5 shrink-0" />A sign-in is only sent over https. Use the
            repository’s https address to add one.
          </p>
        ) : (
          signedIn && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-ink-2">Username</span>
                  <input
                    aria-label="Username"
                    value={username}
                    onChange={(event) => {
                      setUsername(event.target.value)
                      clear()
                    }}
                    spellCheck={false}
                    autoComplete="off"
                    className={field}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-ink-2">{secretWord}</span>
                  {keepsSaved ? (
                    <span className="flex gap-1.5">
                      <input
                        aria-label={secretWord}
                        value="Saved"
                        disabled
                        className={cn(field, 'font-sans')}
                      />
                      <Button
                        variant="secondary"
                        className="h-8 shrink-0 px-2.5 text-xs"
                        onClick={() => {
                          setReplacing(true)
                          clear()
                        }}
                      >
                        Replace…
                      </Button>
                    </span>
                  ) : (
                    <input
                      aria-label={secretWord}
                      type="password"
                      value={secret}
                      placeholder={moved ? 'Enter it again' : undefined}
                      onChange={(event) => {
                        setSecret(event.target.value)
                        clear()
                      }}
                      autoComplete="new-password"
                      // Focused when it's to be replaced.
                      autoFocus={replacing}
                      className={field}
                    />
                  )}
                </label>
              </div>
              <p className="flex gap-2 text-xs text-ink-3">
                <Lock className="mt-0.5 size-3.5 shrink-0" />
                {keepsSaved
                  ? 'Never shown again once saved. To change it, replace it and type the new one. Remove the sign-in by clearing It needs a sign-in.'
                  : state.kept === 'server'
                    ? 'Kept sealed on the server and never shown again, to anyone. Adding or changing one is in the audit log. Helm never sees it: Lumovi fetches charts with it and hands Helm the chart.'
                    : 'Kept in this computer’s keychain and never shown again. Helm never sees it: Lumovi fetches charts with it and hands Helm the chart.'}
              </p>
            </>
          )
        )}
      </div>
      <div className="flex items-start gap-3">
        <Button
          variant="secondary"
          className="h-7 shrink-0 px-2.5 text-xs"
          disabled={!ready || testing}
          onClick={() => void test(input(), keepsSaved)}
        >
          <RefreshCw className={cn(testing && 'animate-spin')} /> Test connection
        </Button>
        <TestResult result={result} />
      </div>
    </ActionDialog>
  )
}

/** Removes a repository: Lumovi forgets it and its sign-in; what was installed from it stays. */
export function RemoveRepositoryDialog({
  state,
  repository,
  onClose,
}: {
  state: HelmRepositories
  repository: HelmRepository
  onClose: () => void
}) {
  const changes = useRepositoryChange()
  const { pending, error, submit } = useSubmit(onClose)
  return (
    <ActionDialog
      icon={Trash2}
      tone="danger"
      title={`Remove ${repository.name}?`}
      name={repository.name}
      subject={keptWhere(state.kept)}
      cluster={false}
      command={
        repository.kind === 'oci'
          ? `helm registry logout ${hostOf(repository.url)}`
          : `helm repo remove ${repository.name}`
      }
      commandNote="Lumovi’s own list, not Helm’s: this is how Helm would remove it."
      confirmLabel="Remove"
      pending={pending}
      error={error}
      onClose={onClose}
      onSubmit={() => void submit(() => changes.remove(repository.id))}
    >
      <p className="text-[13px] leading-relaxed text-ink-2">
        Lumovi forgets it{repository.username ? ', and its saved sign-in' : ''}. Its charts leave
        the Charts tab. Releases installed from it stay as they are, and stop saying when it has a
        newer version.
      </p>
    </ActionDialog>
  )
}

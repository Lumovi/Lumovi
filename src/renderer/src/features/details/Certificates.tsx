/**
 * What the certificates in a Secret's values say (LMV-194), as the backend read them: a card a
 * key, its name over who it's for, the names it's for, its issuer, when it's valid and its chain.
 * Never a value, nor a key; nothing where the person may see only the Secret's keys.
 */
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import type { CertificateSummary, KubeObject } from '@shared/api'
import { BusyButton } from '@renderer/components/Busy'
import { Button } from '@renderer/components/Button'
import { StatusPill } from '@renderer/components/Status'
import { POLL_INTERVAL } from '@renderer/hooks/queries'
import { api, unwrap } from '@renderer/lib/api'
import {
  dateOf,
  fromNow,
  STATE_HEALTH,
  STATE_NAMES,
  stateOf,
  type ReadCertificate,
} from '@renderer/lib/certificates'
import { TheirText } from '@renderer/plugins/TheirText'
import { useCluster } from '@renderer/state/cluster'
import { useAccessHere } from '../access/use-access'
import { KeyValueGrid, Section } from './sections'

/**
 * How many of a Secret's keys are expected to hold a certificate, by their names and its type
 * alone (no value is looked at here): a TLS Secret's tls.crt, ca.crt, and keys named .crt or .pem.
 */
function expected(object: KubeObject): number {
  const tls = object.type === 'kubernetes.io/tls'
  return Object.keys((object.data ?? {}) as Record<string, unknown>).filter(
    (key) =>
      (tls && key === 'tls.crt') ||
      key === 'ca.crt' ||
      // (A .pem named for a key holds one, not a certificate.)
      (/\.(crt|pem)$/i.test(key) && !/key/i.test(key)),
  ).length
}

/** What a failed read is asked again for: the cluster not answering, or failing itself. */
const RETRIED = new Set(['unreachable', 'timeout', 'server'])
/** What's an answer, not a failure: the person may not, or it's gone. Nothing's said of these. */
const REFUSED = new Set([
  'forbidden',
  'unauthorized',
  'auth',
  'not-allowed',
  'not-found',
  'invalid',
])
const codeOf = (error: unknown) => (error as { code?: string } | null)?.code ?? ''

declare const LUMOVI_TEST_BUILD: boolean
/**
 * How many failed reads are asked again for, 5 s apart (about two minutes, with their retries),
 * before the panel stops and offers to try again. (The tests' build alone takes fewer.)
 */
const pollsMost = () =>
  (typeof LUMOVI_TEST_BUILD !== 'undefined' &&
    LUMOVI_TEST_BUILD &&
    (globalThis as { __lumoviCertificatePolls?: number }).__lumoviCertificatePolls) ||
  15

/** The names a card shows before "N more". */
const NAMES_SHOWN = 4

/**
 * What a Secret's certificates say, as its panel reads them (once, for its section and its
 * header): nothing asked where only its keys may be seen.
 */
export function useSecretCertificates(object: KubeObject | undefined) {
  const { context } = useCluster()
  const namespace = object?.metadata.namespace ?? ''
  const name = object?.metadata.name ?? ''
  // (Only where its values may be seen: the backend says none elsewhere, and asks nothing.)
  const withheld = useAccessHere().whyNot('secrets', 'values', namespace, 'see Secrets’ values')
  // Once it has stopped asking, a read asked for by hand is one read, not retried.
  const stopped = useRef(false)
  const read = useQuery({
    queryKey: ['certificates', context, namespace, name, object?.metadata.resourceVersion],
    queryFn: async () => {
      try {
        return await unwrap(api.kube.certificates({ context, namespace, name }))
      } catch (error) {
        // (Where a failed test's trace keeps it: its code and message, nothing else.)
        console.warn(
          'A Secret’s certificates couldn’t be read:',
          codeOf(error),
          (error as Error).message,
        )
        throw error
      }
    },
    enabled: object !== undefined && !withheld,
    // A read the cluster didn't answer is asked again, then every 5 s, as the panel's own object
    // is read again, until it's answered or it has been about two minutes. A refusal, or anything
    // else, is an answer: nothing more is asked. (It all ends with the panel, or its object.)
    retry: (count, error) => !stopped.current && count < 2 && RETRIED.has(codeOf(error)),
    // (And only so: not again as another part of the panel shows it, nor as the window's focused.)
    retryOnMount: false,
    refetchOnWindowFocus: false,
    refetchInterval: (query) =>
      query.state.data === undefined &&
      RETRIED.has(codeOf(query.state.error)) &&
      query.state.errorUpdateCount < pollsMost()
        ? POLL_INTERVAL
        : false,
  })
  const failures = read.errorUpdateCount
  useEffect(() => {
    stopped.current = failures >= pollsMost()
  }, [failures])
  return read
}

export function CertificatesSection({ object }: { object: KubeObject }) {
  const read = useSecretCertificates(object)
  const said = read.data
  // Not read, where certificates are expected (and it wasn't refused): said (once, to a screen
  // reader), rather than looking as if there were none; once it's stopped asking, with a way to
  // ask again.
  const awaited = expected(object)
  const code = codeOf(read.error)
  if (!said && read.isError && awaited > 0 && !REFUSED.has(code)) {
    const them = awaited === 1 ? 'certificate' : 'certificates'
    const asking = RETRIED.has(code) && read.errorUpdateCount < pollsMost()
    return (
      <Section title={awaited === 1 ? 'Certificate' : 'Certificates'}>
        {asking ? (
          <p role="status" className="text-[13px] text-ink-2">
            Lumovi couldn’t read the {them} just now. It’s trying again.
          </p>
        ) : (
          <p role="status" className="flex flex-wrap items-center gap-x-3 text-[13px] text-ink-2">
            Lumovi couldn’t read the {them}.
            {read.isFetching ? (
              <BusyButton name="Try again" word="Reading" timed={false} />
            ) : (
              <Button variant="secondary" onClick={() => void read.refetch()}>
                Try again
              </Button>
            )}
          </p>
        )}
      </Section>
    )
  }
  if (!said?.length) return null
  return (
    <Section title={said.length === 1 ? 'Certificate' : 'Certificates'}>
      <div className="space-y-2">
        {said.map((summary) => (
          <CertificateCard key={summary.key} summary={summary} now={read.dataUpdatedAt} />
        ))}
      </div>
    </Section>
  )
}

function CertificateCard({ summary, now }: { summary: CertificateSummary; now: number }) {
  return (
    <article
      aria-label={`Certificate ${summary.key}`}
      className="rounded-xl border border-line bg-surface-2 p-3.5"
    >
      <h4 className="mb-2.5 font-mono text-xs font-medium wrap-anywhere text-ink-1">
        {summary.key}
      </h4>
      {summary.as === 'unreadable' ? (
        <p className="text-[13px] text-ink-2">This isn’t a certificate Lumovi can read.</p>
      ) : summary.as === 'bundle' ? (
        <KeyValueGrid
          entries={[
            {
              label: 'Bundle',
              value: `${summary.atLeast ? 'At least ' : ''}${summary.count} certificates`,
            },
          ]}
        />
      ) : (
        <KeyValueGrid entries={entriesOf(summary, now)} />
      )}
    </article>
  )
}

function entriesOf(certificate: ReadCertificate, now: number) {
  const notBefore = Date.parse(certificate.notBefore)
  const notAfter = Date.parse(certificate.notAfter)
  // Its own state, as its Valid row says it (its chain's is said on the Chain row).
  const own = stateOf({ notBefore, notAfter }, now)
  const { subject, issuer, chainEnds } = certificate
  const ends = chainEnds && Date.parse(chainEnds.notAfter)
  const chainState = ends !== undefined ? stateOf({ notBefore: 0, notAfter: ends }, now) : 'valid'
  const issued = [issuer.commonName, issuer.organization].filter(Boolean).join(' · ')
  return [
    ...(subject.commonName
      ? [
          {
            label: 'Subject',
            value: (
              <>
                <TheirText text={subject.commonName} inline />
                {subject.rest && (
                  <span className="block text-xs text-ink-3">
                    <TheirText text={subject.rest} inline />
                  </span>
                )}
              </>
            ),
          },
        ]
      : []),
    ...(certificate.names.length > 0
      ? [{ label: 'Names', value: <Names certificate={certificate} /> }]
      : []),
    {
      label: 'Issuer',
      value: certificate.selfSigned ? (
        'Self-signed'
      ) : issued ? (
        <TheirText text={issued} inline />
      ) : (
        '—'
      ),
    },
    {
      label: 'Valid',
      value: (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>
            {dateOf(notBefore)} – {dateOf(notAfter)}{' '}
            <span className="text-ink-3">
              (
              {own === 'not-yet-valid' ? `from ${fromNow(notBefore, now)}` : fromNow(notAfter, now)}
              )
            </span>
          </span>
          {own !== 'valid' && (
            <StatusPill status={{ health: STATE_HEALTH[own], label: STATE_NAMES[own] }} />
          )}
        </span>
      ),
    },
    ...(certificate.chain > 0
      ? [
          {
            label: 'Chain',
            value: (
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>
                  {certificate.chain} more{' '}
                  {certificate.chain === 1 ? 'certificate' : 'certificates'}
                  {chainEnds && ends !== undefined && (
                    <>
                      {' · '}
                      {chainEnds.commonName && (
                        <TheirText text={chainEnds.commonName} inline />
                      )}{' '}
                      {ends <= now ? 'expired' : 'expires'} {dateOf(ends)}{' '}
                      <span className="text-ink-3">({fromNow(ends, now)})</span>
                    </>
                  )}
                </span>
                {chainState !== 'valid' && (
                  <StatusPill
                    status={{ health: STATE_HEALTH[chainState], label: STATE_NAMES[chainState] }}
                  />
                )}
              </span>
            ),
          },
        ]
      : []),
  ]
}

/** The names it's for: the first few, and the rest shown in place when asked for. */
function Names({ certificate }: { certificate: ReadCertificate }) {
  const [all, setAll] = useState(false)
  const { names, moreNames } = certificate
  const shown = all ? names : names.slice(0, NAMES_SHOWN)
  const hidden = names.length - shown.length
  return (
    <span>
      {shown.map((each, i) => (
        <span key={i}>
          {i > 0 && ', '}
          <TheirText text={each} inline />
        </span>
      ))}
      {hidden > 0 && (
        <>
          {', '}
          <button
            type="button"
            onClick={() => setAll(true)}
            className="font-medium text-accent-strong hover:underline"
          >
            {hidden} more
          </button>
        </>
      )}
      {all && moreNames > 0 && <span className="text-ink-3">, and {moreNames} more not read</span>}
    </span>
  )
}

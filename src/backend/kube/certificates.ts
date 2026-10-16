/**
 * What the certificates in a Secret's values say (LMV-194): its subject, the names it's for, its
 * issuer and when it's valid. Read only where the person may see the Secret's values, and only
 * from PEM certificate blocks: a private key, or anything else in a value, is never parsed.
 * Nothing of a value but these fields leaves here, and each of them is anyone's words, kept short.
 */
import { X509Certificate } from 'node:crypto'
import type { CertificateSummary, KubeObject } from '@shared/api'

/** The most of a value read for its certificates, in bytes: a key's chain fits well inside. */
const VALUE_MOST = 64 * 1024
/** The most certificates parsed in one value: its first, and those after it. */
const CERTIFICATES_MOST = 8
/** The most characters kept of a name, or of a part of a subject or issuer. */
const TEXT_MOST = 256
/** The most names kept of a certificate's: past them, how many more. */
const NAMES_MOST = 50

const BEGIN = '-----BEGIN CERTIFICATE-----'
const BLOCK = /-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+?)-----END CERTIFICATE-----/g

const short = (text: string) => (text.length > TEXT_MOST ? text.slice(0, TEXT_MOST) : text)

/** A distinguished name's attributes, as Node writes them: one `KEY=value` a line. */
const attributesOf = (name: string) =>
  name
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf('=')
      return { key: line.slice(0, at), value: line.slice(at + 1) }
    })

/** A subject: its common name, and the rest as written. */
function subjectOf(name: string): { commonName?: string; rest?: string } {
  const attributes = attributesOf(name)
  const commonName = attributes.find((each) => each.key === 'CN')?.value
  const rest = attributes
    .filter((each) => each.key !== 'CN')
    .map((each) => `${each.key}=${each.value}`)
    .join(', ')
  return {
    ...(commonName ? { commonName: short(commonName) } : {}),
    ...(rest ? { rest: short(rest) } : {}),
  }
}

/** An issuer: its common name and organization. */
function issuerOf(name: string): { commonName?: string; organization?: string } {
  const attributes = attributesOf(name)
  const commonName = attributes.find((each) => each.key === 'CN')?.value
  const organization = attributes.find((each) => each.key === 'O')?.value
  return {
    ...(commonName ? { commonName: short(commonName) } : {}),
    ...(organization ? { organization: short(organization) } : {}),
  }
}

/** A common name, where there is one. */
const pick = (commonName: string | undefined) => (commonName ? { commonName } : {})

/** The DNS names, then the IP addresses, a certificate's alternative names give. */
function namesIn(alternative: string | undefined): string[] {
  const dns: string[] = []
  const ips: string[] = []
  // (Node quotes a name with a comma in it, escaping its quotes and backslashes.)
  const entry = /(DNS|IP Address):("(?:[^"\\]|\\.)*"|[^,]*)/g
  for (const [, type, raw] of (alternative ?? '').matchAll(entry)) {
    const value = raw!.startsWith('"') ? raw!.slice(1, -1).replace(/\\(.)/g, '$1') : raw!.trim()
    if (value) (type === 'DNS' ? dns : ips).push(short(value))
  }
  return [...dns, ...ips]
}

/** What a value's certificates say: undefined where it holds none. */
export function certificateIn(key: string, value: string): CertificateSummary | undefined {
  // (A value is base64: only its start is read, whole groups of four.)
  const whole = Math.ceil(VALUE_MOST / 3) * 4
  const text = Buffer.from(value.slice(0, whole), 'base64').toString('latin1')
  if (!text.includes(BEGIN)) return undefined
  const blocks = [...text.matchAll(BLOCK)]
  let parsed: X509Certificate[]
  try {
    parsed = blocks.slice(0, CERTIFICATES_MOST).map(([block]) => new X509Certificate(block))
  } catch {
    return { key, as: 'unreadable' }
  }
  if (parsed.length === 0) return { key, as: 'unreadable' }
  // Each issued by the one after it, as a chain is; else a bundle (of roots, say), counted only.
  const chained = parsed.every((each, i) => i === 0 || parsed[i - 1]!.checkIssued(each))
  if (!chained) {
    return {
      key,
      as: 'bundle',
      count: blocks.length,
      ...(value.length > whole ? { atLeast: true } : {}),
    }
  }
  const [first, ...after] = parsed as [X509Certificate, ...X509Certificate[]]
  const names = namesIn(first.subjectAltName)
  const soonest = after.reduce<X509Certificate | undefined>(
    (sooner, each) => (!sooner || each.validToDate < sooner.validToDate ? each : sooner),
    undefined,
  )
  const endsFirst = soonest && soonest.validToDate < first.validToDate ? soonest : undefined
  return {
    key,
    as: 'certificate',
    subject: subjectOf(first.subject),
    issuer: issuerOf(first.issuer),
    // (Signed with its own key: a CA's root, or a leaf made for itself, whatever it may sign.)
    selfSigned: first.subject === first.issuer && first.verify(first.publicKey),
    names: names.slice(0, NAMES_MOST),
    moreNames: Math.max(0, names.length - NAMES_MOST),
    notBefore: first.validFromDate.toISOString(),
    notAfter: first.validToDate.toISOString(),
    chain: blocks.length - 1,
    ...(endsFirst
      ? {
          chainEnds: {
            ...pick(subjectOf(endsFirst.subject).commonName),
            notAfter: endsFirst.validToDate.toISOString(),
          },
        }
      : {}),
  }
}

/**
 * What each of a Secret's values that holds a certificate says, in its keys' order: those with a
 * PEM certificate in them, and a TLS Secret's tls.crt whatever's in it (unreadable, where it's
 * none).
 */
export function certificatesOf(secret: KubeObject): CertificateSummary[] {
  const data = (secret.data ?? {}) as Record<string, unknown>
  const tls = secret.type === 'kubernetes.io/tls'
  return Object.entries(data).flatMap(([key, value]) => {
    if (typeof value !== 'string' || !value) return []
    const said =
      certificateIn(key, value) ??
      (tls && key === 'tls.crt' ? ({ key, as: 'unreadable' } as const) : undefined)
    return said ? [said] : []
  })
}

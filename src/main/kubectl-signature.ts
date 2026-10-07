/**
 * Whether a kubectl is Kubernetes' own: signed in its release process, as Kubernetes signs its
 * binaries (cosign, keyless: a signature beside each, kubectl.sig, and the certificate Sigstore's
 * Fulcio gave the release for it, kubectl.cert).
 *
 * Checked here, without asking anyone (an air-gapped computer can, and no host learns what's
 * downloaded), against Sigstore's trust root as Lumovi ships it (sigstore-root.json): that
 * Fulcio issued the certificate, that a certificate transparency log Sigstore runs saw it then
 * (its signed timestamp), that it names Kubernetes' release (its service account, signed in with
 * Google), and that its key signed these bytes. Not whether the signing happened while the
 * certificate was valid, which only Sigstore's transparency log (Rekor) could say: its key was
 * the release's, for those ten minutes, and nobody else's.
 */
import { createPublicKey, verify, type KeyObject } from 'node:crypto'
import {
  ByteStream,
  crypto,
  EXTENSION_OID_SCT,
  X509Certificate,
  X509SCTExtension,
} from '@sigstore/core'

/** Who signs Kubernetes' releases, and how they signed in (Kubernetes' own instructions). */
export const KUBERNETES_SIGNER = {
  identity: 'krel-staging@k8s-releng-prod.iam.gserviceaccount.com',
  issuer: 'https://accounts.google.com',
}

/** What a certificate may be used for (extended key usage), and signing code. */
const OID_EXTENDED_KEY_USAGE = '2.5.29.37'
const OID_CODE_SIGNING = '1.3.6.1.5.5.7.3.3'
/** The OIDC issuer Fulcio writes into a certificate: as it once did, and as it does now. */
const OID_ISSUER_V1 = '1.3.6.1.4.1.57264.1.1'
const OID_ISSUER_V2 = '1.3.6.1.4.1.57264.1.8'

interface Validity {
  start: string
  end?: string
}

/** Sigstore's trust root (its trusted_root.json), as far as checking a certificate needs. */
export interface TrustRoot {
  certificateAuthorities: {
    certChain: { certificates: { rawBytes: string }[] }
    validFor: Validity
  }[]
  ctlogs: { publicKey: { rawBytes: string; validFor: Validity }; logId: { keyId: string } }[]
}

/** Why a kubectl isn't taken as Kubernetes' own: said in a terminal's first line. */
class SignatureError extends Error {}

const within = ({ start, end }: Validity, date: Date) =>
  date >= new Date(start) && (!end || date <= new Date(end))

/**
 * Why `binary` isn't Kubernetes' own, or nothing if it is: signed by `signer` with `signature`
 * (base64, as kubectl.sig has it), under `certificate` (a PEM, base64'd, as kubectl.cert has it).
 */
export function whyNotKubernetes(
  binary: Buffer,
  signature: Buffer,
  certificate: Buffer,
  root: TrustRoot,
  signer = KUBERNETES_SIGNER,
): string | undefined {
  try {
    check(binary, signature, certificate, root, signer)
    return undefined
  } catch (error) {
    // What can't be read isn't Kubernetes' either.
    return error instanceof SignatureError
      ? error.message
      : `its certificate couldn’t be read (${(error as Error).message})`
  }
}

function check(
  binary: Buffer,
  signature: Buffer,
  certificate: Buffer,
  root: TrustRoot,
  signer: typeof KUBERNETES_SIGNER,
): void {
  let leaf: X509Certificate
  try {
    leaf = X509Certificate.parse(Buffer.from(certificate.toString(), 'base64').toString())
  } catch {
    throw new SignatureError('its certificate isn’t one')
  }
  // When Fulcio issued it, as a transparency log signed: the time everything else is checked at.
  const issued = loggedAt(leaf, root)
  if (!leaf.validForDate(issued)) {
    throw new SignatureError('its certificate wasn’t valid when it was logged')
  }
  if (!fromFulcio(leaf, issued, root)) {
    throw new SignatureError('its certificate isn’t from Sigstore’s certificate authority')
  }
  // (Its value: a sequence of what it may be used for.)
  const usages = leaf
    .extension(OID_EXTENDED_KEY_USAGE)
    ?.valueObj.subs[0]?.subs.map((usage) => usage.toOID())
  if (!usages?.includes(OID_CODE_SIGNING)) {
    throw new SignatureError('its certificate isn’t for signing code')
  }
  const issuer =
    leaf.extension(OID_ISSUER_V2)?.valueObj.subs[0]?.value.toString('ascii') ??
    leaf.extension(OID_ISSUER_V1)?.value.toString('ascii')
  if (leaf.subjectAltName !== signer.identity) {
    throw new SignatureError(
      `it’s signed by ${leaf.subjectAltName ?? 'someone unnamed'}, not Kubernetes’ release`,
    )
  }
  if (issuer !== signer.issuer) {
    throw new SignatureError(
      `its signer signed in with ${issuer ?? 'nobody'}, not as Kubernetes’ release does`,
    )
  }
  let key: KeyObject
  try {
    key = createPublicKey({ key: leaf.publicKey, format: 'der', type: 'spki' })
  } catch {
    throw new SignatureError('its certificate’s key isn’t one')
  }
  const signed = Buffer.from(signature.toString().trim(), 'base64')
  if (!verify('sha256', binary, key, signed)) {
    throw new SignatureError('its signature isn’t for what was downloaded')
  }
}

/** Whether a chain in the trust root, valid then, issued `leaf`, and each link the next. */
function fromFulcio(leaf: X509Certificate, at: Date, root: TrustRoot): boolean {
  return root.certificateAuthorities
    .filter((ca) => within(ca.validFor, at))
    .some(({ certChain }) => {
      const chain = certChain.certificates.map(({ rawBytes }) =>
        X509Certificate.parse(Buffer.from(rawBytes, 'base64')),
      )
      const path = [leaf, ...chain]
      return path.every(
        (cert, i) =>
          cert.validForDate(at) &&
          (i === path.length - 1 ? cert.verify() : cert.verify(path[i + 1]!)) &&
          (i === 0 || cert.isCA),
      )
    })
}

/**
 * When a certificate transparency log in the trust root saw `leaf`, as it signed (RFC 6962): the
 * signed timestamp Fulcio embeds, checked over the certificate as it was before it was in it.
 */
function loggedAt(leaf: X509Certificate, root: TrustRoot): Date {
  const clone = leaf.clone()
  const at = clone.extensions.findIndex((ext) => ext.subs[0]!.toOID() === EXTENSION_OID_SCT)
  const timestamps =
    at === -1 ? [] : new X509SCTExtension(clone.extensions[at]!).signedCertificateTimestamps
  if (!timestamps.length) {
    throw new SignatureError('its certificate wasn’t logged')
  }
  clone.extensions.splice(at, 1)
  // Its issuer's key (by its hash): Fulcio's, whichever of the trust root's chains it's from.
  const issuers = root.certificateAuthorities.map(({ certChain }) =>
    X509Certificate.parse(Buffer.from(certChain.certificates[0]!.rawBytes, 'base64')),
  )
  for (const sct of timestamps) {
    const logs = root.ctlogs.filter(
      ({ logId, publicKey }) =>
        Buffer.from(logId.keyId, 'base64').equals(sct.logID) &&
        within(publicKey.validFor, sct.datetime),
    )
    for (const issuer of issuers) {
      const precert = new ByteStream()
      precert.appendView(crypto.digest('sha256', issuer.publicKey))
      const tbs = clone.tbsCertificate.toDER()
      precert.appendUint24(tbs.length)
      precert.appendView(tbs)
      const verified = logs.some((log) =>
        sct.verify(
          precert.buffer,
          createPublicKey({
            key: Buffer.from(log.publicKey.rawBytes, 'base64'),
            format: 'der',
            type: 'spki',
          }),
        ),
      )
      if (verified) return sct.datetime
    }
  }
  throw new SignatureError('its certificate wasn’t logged where Sigstore logs them')
}

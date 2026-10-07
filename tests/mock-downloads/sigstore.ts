/**
 * A stand-in for Sigstore, for the e2e tests: a certificate authority like Fulcio's (a root and
 * an intermediate) and a certificate transparency log, made as the tests start, and the trust
 * root that names them (as Lumovi ships Sigstore's, in src/main/sigstore-root.json). It gives
 * certificates as Fulcio gives Kubernetes' release one, each with the timestamp its log signed,
 * and what each way of getting one wrong looks like.
 */
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto'
import { X509Certificate } from '@sigstore/core'
import * as x509 from '@peculiar/x509'
import { KUBERNETES_SIGNER } from '../../src/main/kubectl-signature.ts'

const { subtle } = globalThis.crypto
x509.cryptoProvider.set(globalThis.crypto)

/** How a signed kubectl's certificate can be wrong (each one way only). */
export type CertificateFault =
  /** Someone other than Kubernetes' release. */
  | 'identity'
  /** Kubernetes' release's name, signed in elsewhere. */
  | 'issuer'
  /** Not issued by the certificate authority, though logged as if it were. */
  | 'authority'
  /** No timestamp from a log. */
  | 'unlogged'
  /** A timestamp whose signature isn't the log's. */
  | 'forged-log'
  /** A timestamp from a log the trust root doesn't name. */
  | 'foreign-log'
  /** Logged after it expired. */
  | 'logged-late'
  /** For something other than signing code. */
  | 'usage'

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' }
const DAY = 86_400_000

const keys = () => subtle.generateKey(ALGORITHM, true, ['sign', 'verify'])
const der = (cert: x509.X509Certificate) => Buffer.from(cert.rawData)
const spki = async (key: CryptoKey) => Buffer.from(await subtle.exportKey('spki', key))
const toKeyObject = async (key: CryptoKey) =>
  createPrivateKey({
    key: Buffer.from(await subtle.exportKey('pkcs8', key)),
    format: 'der',
    type: 'pkcs8',
  })

/** DER for a length, and for a value of a tag. */
const length = (n: number) =>
  n < 0x80
    ? Buffer.from([n])
    : n < 0x100
      ? Buffer.from([0x81, n])
      : Buffer.from([0x82, n >> 8, n & 0xff])
const tlv = (tag: number, value: Buffer) =>
  Buffer.concat([Buffer.from([tag]), length(value.length), value])

export interface MockSigstore {
  /** The trust root naming its authority and its log, as Lumovi reads it. */
  root: object
  /** kubectl.cert for what `fault` says (base64 of its PEM, as dl.k8s.io has it). */
  certificate(fault?: CertificateFault): Promise<Buffer>
  /** kubectl.sig: `binary` signed with the key of the certificates it gives (base64). */
  sign(binary: Buffer): Buffer
}

export async function startMockSigstore(): Promise<MockSigstore> {
  const now = Date.now()
  const caValidity = { notBefore: new Date(now - 365 * DAY), notAfter: new Date(now + 365 * DAY) }
  const authority = async (name: string) => {
    const rootKeys = await keys()
    const root = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: '01',
      name: `O=${name}, CN=${name}`,
      ...caValidity,
      keys: rootKeys,
      signingAlgorithm: ALGORITHM,
      extensions: [new x509.BasicConstraintsExtension(true, 1, true)],
    })
    const intermediateKeys = await keys()
    const intermediate = await x509.X509CertificateGenerator.create({
      serialNumber: '02',
      subject: `O=${name}, CN=${name}-intermediate`,
      issuer: root.subject,
      ...caValidity,
      publicKey: intermediateKeys.publicKey,
      signingKey: rootKeys.privateKey,
      signingAlgorithm: ALGORITHM,
      extensions: [new x509.BasicConstraintsExtension(true, 0, true)],
    })
    return { root, intermediate, intermediateKeys }
  }
  const fulcio = await authority('mock-sigstore.test')
  const elsewhere = await authority('elsewhere.test')
  const log = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const otherLog = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const logSpki = (key: KeyObject) => key.export({ format: 'der', type: 'spki' })
  // The key the certificates name: as Fulcio's, ephemeral, but here kept for the tests' kubectl.
  const signing = await keys()
  const signingKey = await toKeyObject(signing.privateKey)
  const certificates = new Map<string, Buffer>()

  /** The timestamp a log signs for `tbs` (RFC 6962): over the certificate before it was in it. */
  const timestamp = (
    tbs: Buffer,
    issuerKey: Buffer,
    at: number,
    logKey: KeyObject,
    logId: KeyObject,
    forged: boolean,
  ) => {
    const time = Buffer.alloc(8)
    time.writeBigUInt64BE(BigInt(at))
    const signed = Buffer.concat([
      Buffer.from([0, 0]),
      time,
      Buffer.from([0, 1]),
      createHash('sha256').update(issuerKey).digest(),
      Buffer.from([tbs.length >> 16, (tbs.length >> 8) & 0xff, tbs.length & 0xff]),
      tbs,
      Buffer.from([0, 0]),
    ])
    let signature = sign('sha256', signed, logKey)
    if (forged) signature = sign('sha256', Buffer.concat([signed, Buffer.from('x')]), logKey)
    const sct = Buffer.concat([
      Buffer.from([0]),
      createHash('sha256').update(logSpki(logId)).digest(),
      time,
      Buffer.from([0, 0, 4, 3, signature.length >> 8, signature.length & 0xff]),
      signature,
    ])
    const list = Buffer.concat([Buffer.from([sct.length >> 8, sct.length & 0xff]), sct])
    return tlv(0x04, Buffer.concat([Buffer.from([list.length >> 8, list.length & 0xff]), list]))
  }

  const certificate = async (fault?: CertificateFault) => {
    const kept = certificates.get(fault ?? 'none')
    if (kept) return kept
    // Valid for ten minutes, as Fulcio's are, a day ago.
    const notBefore = new Date(now - DAY)
    const notAfter = new Date(notBefore.getTime() + 10 * 60_000)
    const issuer =
      fault === 'issuer' ? 'https://token.actions.githubusercontent.com' : KUBERNETES_SIGNER.issuer
    const extensions = [
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([
        fault === 'usage' ? '1.3.6.1.5.5.7.3.1' : '1.3.6.1.5.5.7.3.3',
      ]),
      new x509.SubjectAlternativeNameExtension(
        [
          {
            type: 'email',
            value: fault === 'identity' ? 'someone@example.com' : KUBERNETES_SIGNER.identity,
          },
        ],
        true,
      ),
      new x509.Extension('1.3.6.1.4.1.57264.1.1', false, Buffer.from(issuer)),
      new x509.Extension('1.3.6.1.4.1.57264.1.8', false, tlv(0x0c, Buffer.from(issuer))),
    ]
    // Signed by Fulcio's intermediate: or, as 'authority' is, by another's, logged as Fulcio's.
    const signer = fault === 'authority' ? elsewhere : fulcio
    const template = {
      serialNumber: '0a1b2c3d',
      subject: '',
      issuer: fulcio.intermediate.subject,
      notBefore,
      notAfter,
      publicKey: signing.publicKey,
      signingKey: signer.intermediateKeys.privateKey,
      signingAlgorithm: ALGORITHM,
    }
    let all = extensions
    if (fault !== 'unlogged') {
      const pre = await x509.X509CertificateGenerator.create({ ...template, extensions })
      const tbs = X509Certificate.parse(der(pre)).tbsCertificate.toDER()
      const loggedAt =
        fault === 'logged-late' ? notAfter.getTime() + 60_000 : notBefore.getTime() + 1_000
      const logKey = fault === 'foreign-log' ? otherLog.privateKey : log.privateKey
      const logId = fault === 'foreign-log' ? otherLog.publicKey : log.publicKey
      const sct = timestamp(
        tbs,
        await spki(fulcio.intermediateKeys.publicKey),
        loggedAt,
        logKey,
        logId,
        fault === 'forged-log',
      )
      all = [...extensions, new x509.Extension('1.3.6.1.4.1.11129.2.4.2', false, sct)]
    }
    const cert = await x509.X509CertificateGenerator.create({ ...template, extensions: all })
    const encoded = Buffer.from(cert.toString('pem')).toString('base64')
    certificates.set(fault ?? 'none', Buffer.from(encoded))
    return Buffer.from(encoded)
  }

  return {
    root: {
      certificateAuthorities: [
        {
          certChain: {
            certificates: [fulcio.intermediate, fulcio.root].map((c) => ({
              rawBytes: der(c).toString('base64'),
            })),
          },
          validFor: { start: caValidity.notBefore.toISOString() },
        },
      ],
      ctlogs: [
        {
          publicKey: {
            rawBytes: logSpki(log.publicKey).toString('base64'),
            validFor: { start: caValidity.notBefore.toISOString() },
          },
          logId: { keyId: createHash('sha256').update(logSpki(log.publicKey)).digest('base64') },
        },
      ],
    },
    certificate,
    sign: (binary) => Buffer.from(sign('sha256', binary, signingKey).toString('base64')),
  }
}

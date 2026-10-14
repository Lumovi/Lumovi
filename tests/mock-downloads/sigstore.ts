/**
 * A stand-in for Sigstore, for the e2e tests: a certificate authority like Fulcio's (a root and
 * an intermediate) and a certificate transparency log, made as the tests start, and the trust
 * root that names them (as Lumovi ships Sigstore's, in src/main/sigstore-root.json). It gives
 * certificates as Fulcio gives Kubernetes' release one, each with the timestamp its log signed,
 * and what each way of getting one wrong looks like. And, as Fulcio gives a GitHub workflow one
 * (named by a URI): a file signed as `cosign sign-blob --bundle` writes it, and an attestation
 * as GitHub's attest action writes it.
 */
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto'
import { X509Certificate } from '@sigstore/core'
// (Before x509, which needs it loaded: its dependency injection reads decorators' metadata.)
import 'reflect-metadata'
import * as x509 from '@peculiar/x509'
import { KUBERNETES_SIGNER } from '../../src/main/kubernetes-signer.ts'

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
  /**
   * A Sigstore bundle of `data`, as `cosign sign-blob --bundle` writes it: signed under a
   * certificate naming `signer` (a URI, as a workflow's is) and wrong as `fault` says.
   */
  blob(data: Buffer, signer: WorkflowSigner, fault?: CertificateFault): Promise<Buffer>
  /**
   * An attestation of `statement`, as GitHub's attest action writes it: a Sigstore bundle of a
   * DSSE envelope, signed likewise.
   */
  attestation(statement: object, signer: WorkflowSigner, fault?: CertificateFault): Promise<Buffer>
}

/** Who a workflow's certificate names: its URI, and how it signed in. */
export interface WorkflowSigner {
  identity: string
  issuer: string
}

/** DSSE's pre-authentication encoding: what an envelope's signature is over. */
export function preAuthEncoding(type: string, payload: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${Buffer.byteLength(type)} ${type} ${payload.length} `),
    payload,
  ])
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

  /** A certificate as Fulcio issues one naming `name`, signed in with `issuer`: its DER. */
  const issue = async (
    name: { type: 'email' | 'url'; value: string },
    issuer: string,
    fault?: CertificateFault,
  ) => {
    // Valid for ten minutes, as Fulcio's are, a day ago.
    const notBefore = new Date(now - DAY)
    const notAfter = new Date(notBefore.getTime() + 10 * 60_000)
    const extensions = [
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([
        fault === 'usage' ? '1.3.6.1.5.5.7.3.1' : '1.3.6.1.5.5.7.3.3',
      ]),
      new x509.SubjectAlternativeNameExtension([name], true),
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
    return x509.X509CertificateGenerator.create({ ...template, extensions: all })
  }

  const certificate = async (fault?: CertificateFault) => {
    const kept = certificates.get(fault ?? 'none')
    if (kept) return kept
    const issuer =
      fault === 'issuer' ? 'https://token.actions.githubusercontent.com' : KUBERNETES_SIGNER.issuer
    const name = {
      type: 'email' as const,
      value: fault === 'identity' ? 'someone@example.com' : KUBERNETES_SIGNER.identity,
    }
    const cert = await issue(name, issuer, fault)
    const encoded = Buffer.from(cert.toString('pem')).toString('base64')
    certificates.set(fault ?? 'none', Buffer.from(encoded))
    return Buffer.from(encoded)
  }

  /** A workflow's certificate: named by its URI (an email, where `fault` is 'identity'). */
  const workflowCertificate = async (signer: WorkflowSigner, fault?: CertificateFault) => {
    const name =
      fault === 'identity'
        ? { type: 'email' as const, value: 'someone@example.com' }
        : { type: 'url' as const, value: signer.identity }
    return der(await issue(name, signer.issuer, fault))
  }
  const material = (certificate: Buffer) => ({
    certificate: { rawBytes: certificate.toString('base64') },
    tlogEntries: [],
    timestampVerificationData: {},
  })
  const MEDIA_TYPE = 'application/vnd.dev.sigstore.bundle.v0.3+json'

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
    blob: async (data, signer, fault) =>
      Buffer.from(
        JSON.stringify({
          mediaType: MEDIA_TYPE,
          verificationMaterial: material(await workflowCertificate(signer, fault)),
          messageSignature: {
            messageDigest: {
              algorithm: 'SHA2_256',
              digest: createHash('sha256').update(data).digest('base64'),
            },
            signature: sign('sha256', data, signingKey).toString('base64'),
          },
        }),
      ),
    attestation: async (statement, signer, fault) => {
      const type = 'application/vnd.in-toto+json'
      const payload = Buffer.from(JSON.stringify(statement))
      return Buffer.from(
        JSON.stringify({
          mediaType: MEDIA_TYPE,
          verificationMaterial: material(await workflowCertificate(signer, fault)),
          dsseEnvelope: {
            payload: payload.toString('base64'),
            payloadType: type,
            signatures: [
              {
                sig: sign('sha256', preAuthEncoding(type, payload), signingKey).toString('base64'),
              },
            ],
          },
        }),
      )
    },
  }
}

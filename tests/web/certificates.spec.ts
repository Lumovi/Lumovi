/**
 * What the certificates in a Secret's values say (src/backend/kube/certificates.ts): read from
 * PEM certificate blocks alone, nothing of a value or a key passed on, and anyone's words kept
 * short, however a value's written.
 */
import { expect, test } from '../temp-folders.ts'
import { generate } from 'selfsigned'
import { certificateIn, certificatesOf } from '../../src/backend/kube/certificates.ts'

const base64 = (text: string) => Buffer.from(text).toString('base64')
const DAY = 24 * 60 * 60 * 1000
const days = (n: number) => new Date(Date.now() + n * DAY)

type Pems = Awaited<ReturnType<typeof generate>>

/** A certificate authority (signed by `by`, else itself), valid until `until`. */
const authority = (commonName: string, until = days(365), by?: Pems) =>
  generate(
    [
      { name: 'commonName', value: commonName },
      { name: 'organizationName', value: 'Shop' },
    ],
    {
      algorithm: 'sha256',
      notBeforeDate: days(-1),
      notAfterDate: until,
      extensions: [{ name: 'basicConstraints', cA: true }],
      ...(by ? { ca: { key: by.private, cert: by.cert } } : {}),
    },
  )

/** A server's certificate for shop.example, signed by `by`, valid until `until`. */
const server = (by: Pems, until = days(30), commonName = 'shop.example') =>
  generate([{ name: 'commonName', value: commonName }], {
    algorithm: 'sha256',
    notBeforeDate: days(-1),
    notAfterDate: until,
    ca: { key: by.private, cert: by.cert },
    extensions: [
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'shop.example' },
          { type: 2, value: 'www.shop.example' },
          { type: 7, ip: '10.0.0.7' },
        ],
      },
    ],
  })

test('a TLS Secret’s certificate: who it’s for, its names, its issuer, when it’s valid and its chain; never its key', async () => {
  const ca = await authority('Shop CA')
  const leaf = await server(ca, days(9))
  const secret = {
    kind: 'Secret',
    metadata: { name: 'shop-tls', namespace: 'shop' },
    type: 'kubernetes.io/tls',
    data: { 'tls.crt': base64(leaf.cert + ca.cert), 'tls.key': base64(leaf.private) },
  }
  const said = certificatesOf(secret)
  expect(said).toEqual([
    {
      key: 'tls.crt',
      as: 'certificate',
      subject: { commonName: 'shop.example' },
      issuer: { commonName: 'Shop CA', organization: 'Shop' },
      selfSigned: false,
      names: ['shop.example', 'www.shop.example', '10.0.0.7'],
      moreNames: 0,
      notBefore: expect.any(String),
      notAfter: expect.any(String),
      chain: 1,
    },
  ])
  // (Certificates keep whole seconds.)
  const notAfter = Date.parse((said[0] as { notAfter: string }).notAfter)
  expect(Math.abs(notAfter - days(9).getTime())).toBeLessThan(5_000)
  // Nothing of a value goes with it: not the key, nor the certificate's own text.
  const told = JSON.stringify(said)
  for (const value of Object.values(secret.data)) expect(told).not.toContain(value.slice(0, 40))
  expect(told).not.toContain('PRIVATE')
  expect(told).not.toContain(leaf.cert.split('\n')[1]!)
})

test('a certificate’s whole subject, and one its subject issued itself', async () => {
  const root = await authority('Shop Root')
  expect(certificateIn('ca.crt', base64(root.cert))).toMatchObject({
    as: 'certificate',
    subject: { commonName: 'Shop Root', rest: 'O=Shop' },
    issuer: { commonName: 'Shop Root', organization: 'Shop' },
    selfSigned: true,
    chain: 0,
  })
})

test('a server’s certificate made for itself is self-signed too', async () => {
  const own = await generate([{ name: 'commonName', value: 'own.example' }], {
    algorithm: 'sha256',
  })
  expect(certificateIn('tls.crt', base64(own.cert))).toMatchObject({
    as: 'certificate',
    issuer: { commonName: 'own.example' },
    selfSigned: true,
  })
})

test('a chain whose certificate after the first ends sooner says which, and when', async () => {
  const root = await authority('Shop Root')
  const intermediate = await authority('Shop Intermediate', days(3), root)
  const leaf = await server(intermediate, days(60))
  const said = certificateIn('tls.crt', base64(leaf.cert + intermediate.cert + root.cert))
  expect(said).toMatchObject({ as: 'certificate', chain: 2 })
  const { chainEnds } = said as { chainEnds: { commonName: string; notAfter: string } }
  expect(chainEnds.commonName).toBe('Shop Intermediate')
  expect(Math.abs(Date.parse(chainEnds.notAfter) - days(3).getTime())).toBeLessThan(5_000)
  // One whose chain outlasts it says nothing of the chain's ends.
  const long = await authority('Shop Long', days(400), root)
  const fine = certificateIn('tls.crt', base64((await server(long)).cert + long.cert + root.cert))
  expect(fine).not.toHaveProperty('chainEnds')
})

test('certificates that don’t chain are a bundle, only counted', async () => {
  const roots = await Promise.all(['One', 'Two', 'Three'].map((name) => authority(`Root ${name}`)))
  expect(certificateIn('ca.crt', base64(roots.map((each) => each.cert).join('')))).toEqual({
    key: 'ca.crt',
    as: 'bundle',
    count: 3,
  })
})

test('any key that holds a certificate says so; a key, or a value that isn’t one, says nothing', async () => {
  const ca = await authority('Shop CA')
  const leaf = await server(ca)
  const said = certificatesOf({
    kind: 'Secret',
    metadata: { name: 'db', namespace: 'shop' },
    data: {
      password: base64('hunter2'),
      'ca.crt': base64(ca.cert),
      'client.key': base64(leaf.private),
      // A key and its certificate in one value: the certificate's read, the key isn't.
      'client.pem': base64(leaf.private + leaf.cert),
      empty: '',
    },
  })
  expect(said.map((each) => [each.key, each.as])).toEqual([
    ['ca.crt', 'certificate'],
    ['client.pem', 'certificate'],
  ])
})

test('a TLS Secret’s tls.crt that isn’t a certificate says it can’t be read; another key that isn’t one says nothing', () => {
  const said = certificatesOf({
    kind: 'Secret',
    metadata: { name: 'odd', namespace: 'shop' },
    type: 'kubernetes.io/tls',
    data: {
      'tls.crt': base64('not a certificate'),
      'tls.key': base64('not a key'),
      'ca.crt': base64('nor this'),
    },
  })
  expect(said).toEqual([{ key: 'tls.crt', as: 'unreadable' }])
  // An Opaque Secret's tls.crt is a key like any other.
  expect(
    certificatesOf({
      kind: 'Secret',
      metadata: { name: 'opaque', namespace: 'shop' },
      type: 'Opaque',
      data: { 'tls.crt': base64('not a certificate') },
    }),
  ).toEqual([])
})

test('a certificate that can’t be read says only that, and the others still say theirs', async () => {
  const leaf = await server(await authority('Shop CA'))
  const broken = leaf.cert.replace(/\n[A-Za-z0-9+/]{20}/, '\nAAAAAAAAAAAAAAAAAAAA')
  const cut = leaf.cert.slice(0, leaf.cert.length / 2)
  const said = certificatesOf({
    kind: 'Secret',
    metadata: { name: 'mixed', namespace: 'shop' },
    data: {
      'broken.crt': base64(broken),
      'cut.crt': base64(cut),
      'garbled.crt': base64(
        `${'-----BEGIN CERTIFICATE-----'}\nnotacertificate\n-----END CERTIFICATE-----\n`,
      ),
      'tls.crt': base64(leaf.cert),
    },
  })
  expect(said.map(({ key, as }) => [key, as])).toEqual([
    ['broken.crt', 'unreadable'],
    ['cut.crt', 'unreadable'],
    ['garbled.crt', 'unreadable'],
    ['tls.crt', 'certificate'],
  ])
})

test('a value is read only so far: eight certificates parsed, and nothing past 64 KB', async () => {
  const root = await authority('Shop Root')
  const leaf = await server(root)
  // Its certificate, then its self-signed root nineteen times: a chain, counted whole.
  expect(certificateIn('chain.crt', base64(leaf.cert + root.cert.repeat(19)))).toMatchObject({
    as: 'certificate',
    chain: 19,
  })
  // A megabyte before its certificate: not read that far, so it holds none that's seen.
  const padded = base64(`${'x'.repeat(1024 * 1024)}\n${leaf.cert}`)
  expect(certificateIn('big.crt', padded)).toBeUndefined()
  // A megabyte after it: the certificate's read, the rest isn't.
  const after = base64(`${leaf.cert}\n${'x'.repeat(1024 * 1024)}`)
  expect(certificateIn('big.crt', after)).toMatchObject({ as: 'certificate', chain: 0 })
  // A bundle longer than what's read: at least as many as were seen.
  const others = await Promise.all(['One', 'Two'].map((name) => authority(`Root ${name}`)))
  const many = others
    .map((each) => each.cert)
    .join('')
    .repeat(60)
  expect(certificateIn('ca.crt', base64(many))).toMatchObject({ as: 'bundle', atLeast: true })
})

test('what a certificate says is anyone’s words: kept as written, and short', async () => {
  const ca = await authority('Shop CA')
  // A common name that turns text round, and one far longer than any.
  const turned = 'shop‮txt.example'
  expect(certificateIn('tls.crt', base64((await server(ca, days(30), turned)).cert))).toMatchObject(
    {
      subject: { commonName: turned },
    },
  )
  const long = await server(ca, days(30), 'a'.repeat(1000))
  const said = certificateIn('tls.crt', base64(long.cert)) as { subject: { commonName: string } }
  expect(said.subject.commonName).toHaveLength(256)
})

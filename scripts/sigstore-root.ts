/**
 * Sigstore's trust root, as the desktop app checks Kubernetes' signature on the kubectl it
 * downloads (src/main/kubectl-signature.ts): Fulcio's certificate authorities and the
 * certificate transparency logs' keys, with where they came from and when
 * (src/main/sigstore-root.json). Shipped, so checking asks nobody.
 *
 *   node scripts/sigstore-root.ts    takes it again, if Sigstore has changed it
 *
 * Taken through Sigstore's TUF repository, as its own clients take it: its trusted_root.json is
 * used only once its signed metadata, from the root of trust @sigstore/tuf comes with, says it's
 * the one Sigstore published. Not from wherever a copy of it is, which anyone able to change that
 * copy could change.
 *
 * Written only when the certificate authorities or the logs are new (or it was taken some other
 * way): then it says so, and, in a workflow, `changed=true`
 * (.github/workflows/kubernetes-signing.yml then opens a pull request).
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initTUF } from '@sigstore/tuf'

const SOURCE = "Sigstore's TUF repository, https://tuf-repo-cdn.sigstore.dev (trusted_root.json)"
const FILE = join(import.meta.dirname, '..', 'src', 'main', 'sigstore-root.json')

type Root = { certificateAuthorities: unknown; ctlogs: unknown }

// A cache of its own: only the root of trust @sigstore/tuf comes with is trusted, never one left
// from before.
const cachePath = mkdtempSync(join(tmpdir(), 'sigstore-tuf-'))
let root: Root
try {
  const tuf = await initTUF({ cachePath, forceInit: true })
  root = JSON.parse(await tuf.getTarget('trusted_root.json')) as Root
} finally {
  rmSync(cachePath, { recursive: true, force: true })
}

const kept = JSON.parse(readFileSync(FILE, 'utf8')) as Root & { source: string; taken: string }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const changed =
  kept.source !== SOURCE ||
  !same(root.certificateAuthorities, kept.certificateAuthorities) ||
  !same(root.ctlogs, kept.ctlogs)
if (changed) {
  const taken = new Date().toISOString().slice(0, 10)
  const next = {
    source: SOURCE,
    taken,
    certificateAuthorities: root.certificateAuthorities,
    ctlogs: root.ctlogs,
  }
  writeFileSync(FILE, JSON.stringify(next, null, 2) + '\n')
  console.log(`src/main/sigstore-root.json: Sigstore's, as it is on ${taken}`)
} else {
  console.log(`src/main/sigstore-root.json: as Sigstore's is (taken ${kept.taken})`)
}
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`)

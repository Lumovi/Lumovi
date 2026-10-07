/**
 * Sigstore's trust root, as the desktop app checks Kubernetes' signature on the kubectl it
 * downloads (src/main/kubectl-signature.ts): Fulcio's certificate authorities and the
 * certificate transparency logs' keys, from Sigstore's public trust root, with where it came from
 * and when (src/main/sigstore-root.json). Shipped, so checking asks nobody.
 *
 *   node scripts/sigstore-root.ts           takes it again (before a release)
 *   node scripts/sigstore-root.ts --check   warns when it was taken more than 90 days ago (CI)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE =
  'https://raw.githubusercontent.com/sigstore/root-signing/main/targets/trusted_root.json'
const FILE = join(import.meta.dirname, '..', 'src', 'main', 'sigstore-root.json')
const MAX_AGE_DAYS = 90

if (process.argv.includes('--check')) {
  const { taken } = JSON.parse(readFileSync(FILE, 'utf8')) as { taken: string }
  const days = Math.floor((Date.now() - Date.parse(taken)) / 86_400_000)
  if (days > MAX_AGE_DAYS) {
    // A warning, not a failure: Sigstore rarely changes it, and nothing else waits on it.
    console.log(
      `::warning file=src/main/sigstore-root.json::Sigstore's trust root was taken ${days} days ago: run node scripts/sigstore-root.ts`,
    )
  } else {
    console.log(`Sigstore's trust root was taken ${days} days ago.`)
  }
} else {
  const response = await fetch(SOURCE)
  if (!response.ok) throw new Error(`${SOURCE} answered ${response.status}`)
  const root = (await response.json()) as { certificateAuthorities: unknown; ctlogs: unknown }
  const kept = {
    source: SOURCE,
    taken: new Date().toISOString().slice(0, 10),
    certificateAuthorities: root.certificateAuthorities,
    ctlogs: root.ctlogs,
  }
  writeFileSync(FILE, JSON.stringify(kept, null, 2) + '\n')
  console.log(`src/main/sigstore-root.json: taken ${kept.taken}`)
}

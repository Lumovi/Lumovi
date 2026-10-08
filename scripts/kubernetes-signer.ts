/**
 * Whether Kubernetes' instructions for checking its signatures still name the signer Lumovi
 * checks kubectl against (src/main/kubernetes-signer.ts): the identity and the issuer, in the
 * command they give for a binary (`cosign verify-blob "$BINARY" …`), not anywhere else on the
 * page (the SBOM's and images' are signed otherwise, or could stay when the binaries' changed). If Kubernetes changes how it signs, a Lumovi that knows only
 * the old signer refuses every new kubectl (terminals use the one installed), until an update.
 *
 *   node scripts/kubernetes-signer.ts
 *
 * Says whether they're named, and, in a workflow, `named=true` or `named=false`
 * (.github/workflows/kubernetes-signing.yml opens an issue when they're not, which may also mean
 * the instructions were reworded). Fails only when they can't be read.
 */
import { appendFileSync } from 'node:fs'
import { KUBERNETES_SIGNER } from '../src/main/kubernetes-signer.ts'

/** "Verify Signed Kubernetes Artifacts", as kubernetes.io's source has it. */
const INSTRUCTIONS =
  'https://raw.githubusercontent.com/kubernetes/website/main/content/en/docs/tasks/administer-cluster/verify-signed-artifacts.md'

const response = await fetch(INSTRUCTIONS)
if (!response.ok) throw new Error(`${INSTRUCTIONS} answered ${response.status}`)
// Each command on a line of its own (a line ending in \ goes on), with single spaces.
const commands = (await response.text())
  .replace(/\\\n/g, ' ')
  .split('\n')
  .map((line) => ` ${line.replace(/\s+/g, ' ').trim()} `)
const { identity, issuer } = KUBERNETES_SIGNER
// The flag and its value, in the same command.
const gives = (command: string, flag: string, value: string) =>
  command.includes(` ${flag} ${value} `) || command.includes(` ${flag}=${value} `)
const named = commands.some(
  (command) =>
    command.startsWith(' cosign verify-blob "$BINARY" ') &&
    gives(command, '--certificate-identity', identity) &&
    gives(command, '--certificate-oidc-issuer', issuer),
)
console.log(
  named
    ? `Kubernetes' instructions name ${identity}, signed in with ${issuer}, as Lumovi checks.`
    : `Kubernetes' instructions may no longer name ${identity}, signed in with ${issuer}, for a binary (or say it in other words): ${INSTRUCTIONS}`,
)
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `named=${named}\n`)

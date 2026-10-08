/**
 * Whether Kubernetes' instructions for checking its signatures still name the signer Lumovi
 * checks kubectl against (src/main/kubernetes-signer.ts): the identity and the issuer, as
 * `cosign verify-blob` takes them. If Kubernetes changes how it signs, a Lumovi that knows only
 * the old signer refuses every new kubectl (terminals use the one installed), until an update.
 *
 *   node scripts/kubernetes-signer.ts
 *
 * Says whether they're named, and, in a workflow, `named=true` or `named=false`
 * (.github/workflows/kubernetes-signing.yml opens an issue when they're not). Fails only when the
 * instructions can't be read.
 */
import { appendFileSync } from 'node:fs'
import { KUBERNETES_SIGNER } from '../src/main/kubernetes-signer.ts'

/** "Verify Signed Kubernetes Artifacts", as kubernetes.io's source has it. */
const INSTRUCTIONS =
  'https://raw.githubusercontent.com/kubernetes/website/main/content/en/docs/tasks/administer-cluster/verify-signed-artifacts.md'

const response = await fetch(INSTRUCTIONS)
if (!response.ok) throw new Error(`${INSTRUCTIONS} answered ${response.status}`)
// The commands as one line each: a line ending in \ goes on, and spaces are spaces.
const commands = ` ${(await response.text()).replace(/\\\n/g, ' ').replace(/\s+/g, ' ')} `
const { identity, issuer } = KUBERNETES_SIGNER
// The flag and its value, as the instructions' commands give them.
const names = (flag: string, value: string) =>
  commands.includes(` ${flag} ${value} `) || commands.includes(` ${flag}=${value} `)
const named =
  names('--certificate-identity', identity) && names('--certificate-oidc-issuer', issuer)
console.log(
  named
    ? `Kubernetes' instructions name ${identity}, signed in with ${issuer}, as Lumovi checks.`
    : `Kubernetes' instructions no longer name ${identity}, signed in with ${issuer}: ${INSTRUCTIONS}`,
)
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `named=${named}\n`)
